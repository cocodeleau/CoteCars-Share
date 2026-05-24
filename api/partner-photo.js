// api/partner-photo.js
//
// Pipeline par photo :
//   1. Watermarkly        → détection plaque + tentative remplacement logo
//   2. Logo garanti       → diff original/watermarkly → composite AUTOEASY_LOGO_B64
//                           couvre le cas flou-sans-logo sur angles difficiles
//   3. Photoroom v2       → détourage + fond #F2F2F2 + ombre portée ai.soft
//   4. Vignette AE        → logo carré en haut à droite
//
// Reçoit : POST JSON { image: "data:image/jpeg;base64,...", original_url?: "..." }
// Renvoie : { success: true, result: "data:image/jpeg;base64,...", plateDetected: bool }
//        ou { success: false, error: "..." }
//
// Variables d'env Vercel requises :
//   PHOTOROOM_API_KEY
//   WATERMARKLY_API_KEY
//   AUTOEASY_LOGO_URL    (ex. https://cotecars-test.vercel.app/logo-ae.png)
//   VIGNETTE_URL         (ex. https://cotecars-test.vercel.app/vignette-AE.png)

const FormData = require("form-data");
const fetch    = require("node-fetch");
const sharp    = require("sharp");

const BACKGROUND_COLOR = "#F2F2F2";

// Logo AutoEasy — PNG fond transparent, encodé en base64
const AUTOEASY_LOGO_B64 = "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";

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
// WATERMARKLY BLUR API
// Toujours POST avec prétraitement sharp (Option A+B).
// NE THROW JAMAIS — retourne null si erreur.
// ─────────────────────────────────────────────────────────────────────────────
async function blurPlateWatermarkly(imageBuffer, originalUrl = null) {
  try {
    const API_URL = "https://blur-api-eu1.watermarkly.com/blur/";
    const API_KEY = process.env.WATERMARKLY_API_KEY;
    const logoUrl = process.env.AUTOEASY_LOGO_URL || "";

    const params = new URLSearchParams({
      blur_intensity:      "10",
      format:              "jpeg",
      detection_threshold: "0.05",
    });

    if (logoUrl) {
      params.set("logo_url",  logoUrl);
      params.set("logo_size", "1.3");
    }

    // Prétraitement : sharpen + saturation → meilleure détection des plaques en angle
    const enhanced = await sharp(imageBuffer)
      .sharpen({ sigma: 1.2, flat: 1, jagged: 2 })
      .modulate({ saturation: 1.1 })
      .jpeg({ quality: 96 })
      .toBuffer();

    console.log("[Watermarkly] POST — image prétraitée");

    const res = await withRetry(() =>
      fetch(`${API_URL}?${params.toString()}`, {
        method:  "POST",
        headers: { "x-api-key": API_KEY, "Content-Type": "application/octet-stream" },
        body:    enhanced,
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
// FIND PLATE REGION
// Compare original vs résultat Watermarkly (downscalé à 800px).
// Retourne la bounding box de la zone la plus modifiée (= la plaque).
// Retourne null si aucune zone significative trouvée.
// ─────────────────────────────────────────────────────────────────────────────
async function findPlateRegion(origBuffer, wmBuffer) {
  try {
    const { width: W, height: H } = await sharp(origBuffer).metadata();

    // Downscaler pour la comparaison (performance)
    const scale = Math.min(1, 800 / W);
    const cW    = Math.round(W * scale);
    const cH    = Math.round(H * scale);

    const [oRaw, wRaw] = await Promise.all([
      sharp(origBuffer).resize(cW, cH).raw().toBuffer({ resolveWithObject: true }),
      sharp(wmBuffer).resize(cW, cH).raw().toBuffer({ resolveWithObject: true }),
    ]);

    const oD  = oRaw.data;
    const wD  = wRaw.data;
    const ch  = oRaw.info.channels; // 3 (RGB) ou 4 (RGBA)
    const THR = 60; // seuil de diff par pixel (somme des 3 canaux)

    // Compter les pixels modifiés par ligne et par colonne
    const rowCount = new Int32Array(cH);
    const colCount = new Int32Array(cW);
    let total = 0;

    for (let y = 0; y < cH; y++) {
      for (let x = 0; x < cW; x++) {
        const i = (y * cW + x) * ch;
        const d = Math.abs(oD[i]   - wD[i])
                + Math.abs(oD[i+1] - wD[i+1])
                + Math.abs(oD[i+2] - wD[i+2]);
        if (d > THR) { rowCount[y]++; colCount[x]++; total++; }
      }
    }

    // Pas assez de changements → rien à traiter
    const MIN_CHANGED = Math.max(50, cW * cH * 0.0008);
    if (total < MIN_CHANGED) {
      console.log(`[findPlate] Aucune zone significative (${total} pixels modifiés)`);
      return null;
    }

    // Trouver la densité max de changements par ligne/colonne
    let maxRow = 0, maxCol = 0;
    for (let y = 0; y < cH; y++) if (rowCount[y] > maxRow) maxRow = rowCount[y];
    for (let x = 0; x < cW; x++) if (colCount[x] > maxCol) maxCol = colCount[x];

    if (maxRow === 0) return null;

    // Seuil : lignes/colonnes avec au moins 25% du maximum de changements
    const rowThr = Math.max(2, maxRow * 0.25);
    const colThr = Math.max(2, maxCol * 0.25);

    let minY = cH, maxY = 0, minX = cW, maxX = 0;
    for (let y = 0; y < cH; y++) {
      if (rowCount[y] >= rowThr) { minY = Math.min(minY, y); maxY = Math.max(maxY, y); }
    }
    for (let x = 0; x < cW; x++) {
      if (colCount[x] >= colThr) { minX = Math.min(minX, x); maxX = Math.max(maxX, x); }
    }

    const bW = maxX - minX;
    const bH = maxY - minY;

    // Validation : forme cohérente avec une plaque
    if (bW < 15 || bH < 3)     { console.log("[findPlate] Zone trop petite"); return null; }
    if (bW > cW * 0.85)        { console.log("[findPlate] Zone trop large"); return null; }
    if (bW / Math.max(1, bH) < 1.2) { console.log("[findPlate] Ratio trop carré"); return null; }

    // Revenir aux coordonnées de l'image originale + padding
    const PAD    = 8;
    const oLeft  = Math.max(0, Math.round(minX / scale) - PAD);
    const oTop   = Math.max(0, Math.round(minY / scale) - PAD);
    const oRight = Math.min(W, Math.round(maxX / scale) + PAD);
    const oBot   = Math.min(H, Math.round(maxY / scale) + PAD);

    const region = { left: oLeft, top: oTop, width: oRight - oLeft, height: oBot - oTop };
    console.log(`[findPlate] Plaque détectée : (${oLeft},${oTop}) ${region.width}x${region.height}px`);
    return region;

  } catch (err) {
    console.warn("[findPlate] Erreur :", err.message);
    return null;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// COMPOSITE LOGO SUR LA RÉGION DÉTECTÉE
// Couvre la zone plaque avec le logo AutoEasy (fond blanc + logo centré).
// ─────────────────────────────────────────────────────────────────────────────
async function compositeLogoOnRegion(imageBuffer, region) {
  const logoBuffer = Buffer.from(AUTOEASY_LOGO_B64, "base64");

  // Logo redimensionné pour couvrir exactement la bbox
  // fit:contain + flatten blanc → fond blanc, logo centré
  const overlayBuffer = await sharp(logoBuffer)
    .resize(region.width, region.height, {
      fit:        "contain",
      background: { r: 255, g: 255, b: 255, alpha: 1 },
    })
    .flatten({ background: { r: 255, g: 255, b: 255 } })
    .png()
    .toBuffer();

  return sharp(imageBuffer)
    .composite([{ input: overlayBuffer, top: region.top, left: region.left }])
    .jpeg({ quality: 95 })
    .toBuffer();
}

// ─────────────────────────────────────────────────────────────────────────────
// PHOTOROOM v2
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
    const mimeType    = image.includes("data:")
      ? image.split(";")[0].split(":")[1]
      : "image/jpeg";
    const imageBuffer = Buffer.from(base64Data, "base64");
    const originalUrl = req.body.original_url || null;

    if (imageBuffer.length > 20 * 1024 * 1024) {
      return res.status(200).json({ success: false, error: "Image trop volumineuse (max 20 Mo)." });
    }

    // ── 1. Watermarkly ──────────────────────────────────────────────────────
    console.log("[Pipeline] Étape 1 — Watermarkly...");
    const watermarklyResult = await blurPlateWatermarkly(imageBuffer, originalUrl);

    if (!watermarklyResult) {
      console.warn("[Pipeline] Watermarkly échoué — image originale → Photoroom");
    }

    // ── 2. Logo garanti par diff + composite ────────────────────────────────
    let imageForPhotoroom = watermarklyResult ?? imageBuffer;

    if (watermarklyResult) {
      console.log("[Pipeline] Étape 2 — Vérification et logo garanti...");
      try {
        const region = await findPlateRegion(imageBuffer, watermarklyResult);
        if (region) {
          imageForPhotoroom = await compositeLogoOnRegion(watermarklyResult, region);
          console.log("[Pipeline] Logo garanti appliqué sur la plaque");
        } else {
          console.log("[Pipeline] Aucune zone de plaque trouvée — watermarkly utilisé tel quel");
          imageForPhotoroom = watermarklyResult;
        }
      } catch (e) {
        console.warn("[Pipeline] Logo garanti échoué :", e.message);
        imageForPhotoroom = watermarklyResult;
      }
    }

    // ── 3. Photoroom ─────────────────────────────────────────────────────────
    console.log("[Pipeline] Étape 3 — Photoroom...");
    let photoroomBuffer;
    try {
      photoroomBuffer = await runPhotoroom(imageForPhotoroom, "image/jpeg");
    } catch (err) {
      return res.status(200).json({ success: false, error: err.message });
    }

    const { width: imgW } = await sharp(photoroomBuffer).metadata();
    console.log(`[Pipeline] Photoroom OK — largeur ${imgW}px`);

    // ── 4. Vignette AE ───────────────────────────────────────────────────────
    const vignetteUrl = process.env.VIGNETTE_URL
      || "https://cotecars-test.vercel.app/vignette-AE.png";
    try {
      const vigRes        = await fetch(vignetteUrl);
      const vigBuf        = Buffer.from(await vigRes.arrayBuffer());
      const VIGNETTE_SIZE = Math.round(imgW * 0.08);
      const VIGNETTE_PAD  = Math.round(imgW * 0.02);
      const vigResized    = await sharp(vigBuf)
        .resize(VIGNETTE_SIZE, VIGNETTE_SIZE, {
          fit:        "contain",
          background: { r: 0, g: 0, b: 0, alpha: 0 },
        })
        .toBuffer();
      photoroomBuffer = await sharp(photoroomBuffer)
        .composite([{
          input: vigResized,
          top:   VIGNETTE_PAD,
          left:  imgW - VIGNETTE_SIZE - VIGNETTE_PAD,
        }])
        .jpeg({ quality: 92 })
        .toBuffer();
      console.log(`[Pipeline] Vignette OK — ${VIGNETTE_SIZE}x${VIGNETTE_SIZE}px`);
    } catch (e) {
      console.warn("[Pipeline] Vignette échouée :", e.message);
    }

    console.log(`[Pipeline] Terminé — ${photoroomBuffer.length} octets | watermarkly: ${!!watermarklyResult}`);

    return res.status(200).json({
      success:       true,
      result:        "data:image/jpeg;base64," + photoroomBuffer.toString("base64"),
      plateDetected: !!watermarklyResult,
    });

  } catch (error) {
    console.error("[partner-photo] Erreur inattendue :", error);
    return res.status(200).json({
      success: false,
      error:   error.message || "Erreur serveur inconnue.",
    });
  }
};