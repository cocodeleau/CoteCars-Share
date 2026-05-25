// api/partner-photo.js
//
// Pipeline :
//   1. Watermarkly  → détecte plaque + place logo AutoEasy
//                     Paramètres officiels recommandés par la documentation
//   2. Photoroom v2 → détourage + fond #F2F2F2 + ombre ai.soft
//   3. Sharp        → vignette AE en haut à droite
//
// Variables Vercel : PHOTOROOM_API_KEY  WATERMARKLY_API_KEY  AUTOEASY_LOGO_URL  VIGNETTE_URL

const FormData = require("form-data");
const fetch    = require("node-fetch");
const sharp    = require("sharp");

const BACKGROUND_COLOR = "#F2F2F2";

// ─────────────────────────────────────────────────────────────────────────────
// RETRY HELPER
// ─────────────────────────────────────────────────────────────────────────────
async function withRetry(fn, maxAttempts = 3, backoffMs = [0, 2000, 4000]) {
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    if (backoffMs[attempt] > 0) {
      await new Promise(r => setTimeout(r, backoffMs[attempt]));
    }
    try {
      return await fn();
    } catch (err) {
      const msg         = err.message || "";
      const isRetryable = msg.includes("503") || msg.includes("429") ||
                          msg.includes("Service Unavailable") ||
                          msg.includes("Too Many Requests");
      console.warn(`[retry] Tentative ${attempt + 1}/${maxAttempts} — ${msg}`);
      if (!isRetryable || attempt === maxAttempts - 1) throw err;
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// ÉTAPE 1 — WATERMARKLY
// blur_intensity:      10   → flou fort en fallback si logo impossible
// detection_threshold: 0.3  → valeur par défaut officielle pour les plaques
// logo_size:           1.0  → taille max (plein cadre de la plaque)
// ─────────────────────────────────────────────────────────────────────────────
async function blurPlateWatermarkly(imageBuffer) {
  try {
    const API_URL = "https://blur-api-eu1.watermarkly.com/blur/";
    const API_KEY = process.env.WATERMARKLY_API_KEY;
    const logoUrl = process.env.AUTOEASY_LOGO_URL || "";

    const params = new URLSearchParams({
      blur_intensity:      "10",
      format:              "jpeg",
      detection_threshold: "0.3",
    });

    if (logoUrl) {
      params.set("logo_url",  logoUrl);
      params.set("logo_size", "1.0");
    }

    const res = await withRetry(() =>
      fetch(`${API_URL}?${params.toString()}`, {
        method:  "POST",
        headers: { "x-api-key": API_KEY, "Content-Type": "application/octet-stream" },
        body:    imageBuffer,
      })
    );

    if (!res.ok) {
      const err = await res.text().catch(() => "");
      console.warn(`[Watermarkly] Erreur ${res.status} : ${err}`);
      return null;
    }

    const resultBuffer = Buffer.from(await res.arrayBuffer());
    console.log(`[Watermarkly] OK — ${resultBuffer.length} octets`);
    return resultBuffer;

  } catch (err) {
    console.warn("[Watermarkly] Erreur inattendue :", err.message);
    return null;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// ÉTAPE 2 — PHOTOROOM v2
// ─────────────────────────────────────────────────────────────────────────────
async function runPhotoroom(imageBuffer, mimeType) {
  const form = new FormData();
  form.append("imageFile",        imageBuffer, { filename: "car.jpg", contentType: mimeType });
  form.append("format",           "jpeg");
  form.append("outputSize",       "originalImage");
  form.append("padding",          "0.05");
  form.append("background.color", BACKGROUND_COLOR);
  form.append("shadow.mode",      "ai.soft");

  const res = await withRetry(() =>
    fetch("https://image-api.photoroom.com/v2/edit", {
      method:  "POST",
      headers: { "x-api-key": process.env.PHOTOROOM_API_KEY, ...form.getHeaders() },
      body:    form,
    })
  );

  if (!res.ok) {
    const errText = await res.text().catch(() => "");
    throw new Error(`Photoroom erreur ${res.status} : ${errText}`);
  }

  return Buffer.from(await res.arrayBuffer());
}

// ─────────────────────────────────────────────────────────────────────────────
// HANDLER PRINCIPAL
// ─────────────────────────────────────────────────────────────────────────────
module.exports = async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ success: false, error: "Method not allowed" });
  }

  try {
    const { image } = req.body;
    if (!image) {
      return res.status(200).json({ success: false, error: 'Champ "image" manquant.' });
    }

    const base64Data  = image.includes(",") ? image.split(",")[1] : image;
    const mimeType    = image.includes("data:") ? image.split(";")[0].split(":")[1] : "image/jpeg";
    const imageBuffer = Buffer.from(base64Data, "base64");

    if (imageBuffer.length > 20 * 1024 * 1024) {
      return res.status(200).json({ success: false, error: "Image trop volumineuse (max 20 Mo)." });
    }

    // ── 1. Watermarkly ───────────────────────────────────────────────────────
    console.log("[Pipeline] Étape 1 — Watermarkly (detection_threshold:0.3)...");
    const watermarklyResult = await blurPlateWatermarkly(imageBuffer);
    if (!watermarklyResult) {
      console.warn("[Pipeline] Watermarkly échoué — image originale utilisée");
    }

    const imageForPhotoroom = watermarklyResult ?? imageBuffer;

    // ── 2. Photoroom ─────────────────────────────────────────────────────────
    console.log("[Pipeline] Étape 2 — Photoroom...");
    let photoroomBuffer;
    try {
      photoroomBuffer = await runPhotoroom(imageForPhotoroom, "image/jpeg");
    } catch (err) {
      return res.status(200).json({ success: false, error: err.message });
    }

    const { width: imgW } = await sharp(photoroomBuffer).metadata();
    console.log(`[Pipeline] Photoroom OK — ${imgW}px`);

    // ── 3. Vignette AE ───────────────────────────────────────────────────────
    const vignetteUrl = process.env.VIGNETTE_URL || "https://cotecars-test.vercel.app/vignette-AE.png";
    try {
      const vigRes     = await fetch(vignetteUrl);
      const vigBuf     = Buffer.from(await vigRes.arrayBuffer());
      const VIG_SIZE   = Math.round(imgW * 0.08);
      const VIG_PAD    = Math.round(imgW * 0.02);
      const vigResized = await sharp(vigBuf)
        .resize(VIG_SIZE, VIG_SIZE, { fit: "contain", background: { r: 0, g: 0, b: 0, alpha: 0 } })
        .toBuffer();
      photoroomBuffer = await sharp(photoroomBuffer)
        .composite([{ input: vigResized, top: VIG_PAD, left: imgW - VIG_SIZE - VIG_PAD }])
        .jpeg({ quality: 92 })
        .toBuffer();
      console.log(`[Pipeline] Vignette OK — ${VIG_SIZE}px`);
    } catch (e) {
      console.warn("[Pipeline] Vignette échouée :", e.message);
    }

    console.log(`[Pipeline] Terminé — ${photoroomBuffer.length} octets | plaque: ${!!watermarklyResult}`);

    return res.status(200).json({
      success:       true,
      result:        "data:image/jpeg;base64," + photoroomBuffer.toString("base64"),
      plateDetected: !!watermarklyResult,
    });

  } catch (error) {
    console.error("[partner-photo] Erreur inattendue :", error);
    return res.status(200).json({ success: false, error: error.message || "Erreur serveur inconnue." });
  }
};