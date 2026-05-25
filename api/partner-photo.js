// api/partner-photo.js
//
// Pipeline :
//   1. Watermarkly  → détecte plaque + place logo (URL hébergée)
//   2. Photoroom v2 → détourage + fond #F2F2F2 + ombre ai.soft
//   3. Sharp        → vignette AE en haut à droite
//
// Variables Vercel : PHOTOROOM_API_KEY  WATERMARKLY_API_KEY  VIGNETTE_URL

const FormData = require("form-data");
const fetch    = require("node-fetch");
const sharp    = require("sharp");

const BACKGROUND_COLOR = "#F2F2F2";
const LOGO_URL         = "https://cotecars-test.vercel.app/logo-ae.png";

// ─────────────────────────────────────────────────────────────────────────────
// RETRY HELPER
// ─────────────────────────────────────────────────────────────────────────────
async function withRetry(fn, maxAttempts = 3, backoffMs = [0, 2000, 4000]) {
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    if (backoffMs[attempt] > 0) await new Promise(r => setTimeout(r, backoffMs[attempt]));
    try { return await fn(); } catch (err) {
      const msg = err.message || "";
      const retry = msg.includes("503") || msg.includes("429") ||
                    msg.includes("Service Unavailable") || msg.includes("Too Many Requests");
      console.warn(`[retry] ${attempt + 1}/${maxAttempts} — ${msg}`);
      if (!retry || attempt === maxAttempts - 1) throw err;
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// ÉTAPE 1 — WATERMARKLY
// ─────────────────────────────────────────────────────────────────────────────
async function blurPlateWatermarkly(imageBuffer) {
  try {
    const API_URL = "https://blur-api-eu1.watermarkly.com/blur/";
    const API_KEY = process.env.WATERMARKLY_API_KEY;

    const params = new URLSearchParams({
      blur_intensity:      "10",
      format:              "jpeg",
      detection_threshold: "0",
      logo_url:            LOGO_URL,
      logo_size:           "1.0",
    });

    const res = await withRetry(() =>
      fetch(`${API_URL}?${params.toString()}`, {
        method:  "POST",
        headers: { "x-api-key": API_KEY, "Content-Type": "application/octet-stream" },
        body:    imageBuffer,
      })
    );

    if (!res.ok) { console.warn(`[Watermarkly] Erreur ${res.status}`); return null; }
    const buf = Buffer.from(await res.arrayBuffer());
    console.log(`[Watermarkly] OK — ${buf.length} octets`);
    return buf;

  } catch (err) {
    console.warn("[Watermarkly] Erreur :", err.message);
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
  if (!res.ok) throw new Error(`Photoroom ${res.status} : ${await res.text().catch(() => "")}`);
  return Buffer.from(await res.arrayBuffer());
}

// ─────────────────────────────────────────────────────────────────────────────
// HANDLER PRINCIPAL
// ─────────────────────────────────────────────────────────────────────────────
module.exports = async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ success: false, error: "Method not allowed" });

  try {
    const { image } = req.body;
    if (!image) return res.status(200).json({ success: false, error: 'Champ "image" manquant.' });

    const base64Data  = image.includes(",") ? image.split(",")[1] : image;
    const mimeType    = image.includes("data:") ? image.split(";")[0].split(":")[1] : "image/jpeg";
    const imageBuffer = Buffer.from(base64Data, "base64");

    if (imageBuffer.length > 20 * 1024 * 1024)
      return res.status(200).json({ success: false, error: "Image trop volumineuse (max 20 Mo)." });

    // ── 1. Watermarkly ───────────────────────────────────────────────────────
    console.log("[Pipeline] Étape 1 — Watermarkly...");
    const watermarklyResult = await blurPlateWatermarkly(imageBuffer);

    const imageForPhotoroom = watermarklyResult ?? imageBuffer;
    if (!watermarklyResult) console.warn("[Pipeline] Watermarkly échoué — image originale");

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

    console.log(`[Pipeline] Terminé — ${photoroomBuffer.length} octets`);

    return res.status(200).json({
      success:       true,
      result:        "data:image/jpeg;base64," + photoroomBuffer.toString("base64"),
      plateDetected: !!watermarklyResult,
    });

  } catch (error) {
    console.error("[partner-photo] Erreur :", error);
    return res.status(200).json({ success: false, error: error.message || "Erreur serveur." });
  }
};