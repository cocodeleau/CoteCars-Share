// api/partner-photo-esdfx.js
//
// Pipeline ESDFX (espace personnel) :
//   1. Watermarkly → détecte plaque + place le logo choisi (AutoEasy ou CoteCars)
//   2. Sharp        → vignette AE en haut à droite
//
// Pas de Photoroom — fond original conservé
//
// Variables Vercel : WATERMARKLY_API_KEY  AUTOEASY_LOGO_URL  COTECARS_LOGO_URL  VIGNETTE_URL  COTECARS_VIGNETTE_URL
// Body attendu     : { image: "data:...", cachePlaque: "autoeasy" | "cotecars" }

const fetch = require("node-fetch");
const sharp = require("sharp");

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
// cachePlaque : "autoeasy" (défaut) | "cotecars"
// ─────────────────────────────────────────────────────────────────────────────
async function blurPlateWatermarkly(imageBuffer, cachePlaque) {
  try {
    const API_URL = "https://blur-api-eu1.watermarkly.com/blur/";
    const API_KEY = process.env.WATERMARKLY_API_KEY;

    // Sélection du logo selon le cache plaque choisi
    const logoUrl = cachePlaque === "cotecars"
      ? (process.env.COTECARS_LOGO_URL || "")
      : (process.env.AUTOEASY_LOGO_URL || "");

    console.log(`[Watermarkly] Cache plaque : ${cachePlaque || "autoeasy"} — logo: ${logoUrl ? "OK" : "absent"}`);

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
      console.warn(`[Watermarkly] Erreur ${res.status}`);
      return null;
    }

    const buf = Buffer.from(await res.arrayBuffer());
    console.log(`[Watermarkly] OK — ${buf.length} octets`);
    return buf;

  } catch (err) {
    console.warn("[Watermarkly] Erreur :", err.message);
    return null;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// HANDLER PRINCIPAL
// ─────────────────────────────────────────────────────────────────────────────
module.exports = async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ success: false, error: "Method not allowed" });
  }

  try {
    const { image, cachePlaque } = req.body;
    if (!image) {
      return res.status(200).json({ success: false, error: 'Champ "image" manquant.' });
    }

    // cachePlaque : "autoeasy" (défaut) | "cotecars"
    const logoChoice = cachePlaque === "cotecars" ? "cotecars" : "autoeasy";

    const base64Data  = image.includes(",") ? image.split(",")[1] : image;
    const imageBuffer = Buffer.from(base64Data, "base64");

    if (imageBuffer.length > 20 * 1024 * 1024) {
      return res.status(200).json({ success: false, error: "Image trop volumineuse (max 20 Mo)." });
    }

    // ── 1. Watermarkly ───────────────────────────────────────────────────────
    console.log(`[ESDFX] Étape 1 — Watermarkly (logo: ${logoChoice})...`);
    const watermarklyResult = await blurPlateWatermarkly(imageBuffer, logoChoice);
    if (!watermarklyResult) {
      console.warn("[ESDFX] Watermarkly échoué — image originale utilisée");
    }

    let finalBuffer = watermarklyResult ?? imageBuffer;

    // ── 2. Vignette (AutoEasy ou CoteCars selon le cache plaque choisi) ─────
    console.log(`[ESDFX] Étape 2 — Vignette (${logoChoice})...`);
    const { width: imgW } = await sharp(finalBuffer).metadata();

    try {
      let vigBuf;
      if (logoChoice === "cotecars") {
        // Vignette CoteCars — à la racine du projet Vercel
        const ccVigUrl = process.env.COTECARS_VIGNETTE_URL
          || "https://res.cloudinary.com/di3xa7ldg/image/upload/v1779874653/LOGO_COTECARS_3_rhfxxz.png";
        console.log(`[ESDFX] Vignette CoteCars URL : ${ccVigUrl}`);
        const ccVigRes = await fetch(ccVigUrl);
        if (!ccVigRes.ok) throw new Error(`Vignette CoteCars HTTP ${ccVigRes.status} — ${ccVigUrl}`);
        vigBuf = Buffer.from(await ccVigRes.arrayBuffer());
      } else {
        // Vignette AutoEasy — URL via variable d'env
        const vignetteUrl = process.env.VIGNETTE_URL
          || "https://cotecars-test.vercel.app/vignette-AE.png";
        console.log(`[ESDFX] Vignette AutoEasy URL : ${vignetteUrl}`);
        const vigRes = await fetch(vignetteUrl);
        if (!vigRes.ok) throw new Error(`Vignette AE HTTP ${vigRes.status} — ${vignetteUrl}`);
        vigBuf = Buffer.from(await vigRes.arrayBuffer());
      }
      const VIG_SIZE   = Math.round(imgW * 0.08);
      const VIG_PAD    = Math.round(imgW * 0.02);
      const vigResized = await sharp(vigBuf)
        .resize(VIG_SIZE, VIG_SIZE, { fit: "contain", background: { r: 0, g: 0, b: 0, alpha: 0 } })
        .toBuffer();
      finalBuffer = await sharp(finalBuffer)
        .composite([{ input: vigResized, top: VIG_PAD, left: imgW - VIG_SIZE - VIG_PAD }])
        .jpeg({ quality: 92 })
        .toBuffer();
      console.log(`[ESDFX] Vignette OK — ${VIG_SIZE}px`);
    } catch (e) {
      console.warn("[ESDFX] Vignette échouée :", e.message);
      finalBuffer = await sharp(finalBuffer).jpeg({ quality: 92 }).toBuffer();
    }

    console.log(`[ESDFX] Terminé — ${finalBuffer.length} octets | plaque: ${!!watermarklyResult}`);

    return res.status(200).json({
      success:       true,
      result:        "data:image/jpeg;base64," + finalBuffer.toString("base64"),
      plateDetected: !!watermarklyResult,
    });

  } catch (error) {
    console.error("[partner-photo-esdfx] Erreur inattendue :", error);
    return res.status(200).json({ success: false, error: error.message || "Erreur serveur inconnue." });
  }
};