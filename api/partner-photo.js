// api/partner-photo.js
//
// Pipeline par photo :
//   1. Watermarkly        → détection plaque + tentative remplacement logo
//   2. Logo garanti       → diff original/watermarkly → composite AUTOEASY_LOGO_B64
//   3. Photoroom v2       → détourage + fond #F2F2F2 + ombre portée ai.soft
//   4. Vignette AE        → logo carré en haut à droite
//
// Variables d'env Vercel requises :
//   PHOTOROOM_API_KEY  WATERMARKLY_API_KEY
//   AUTOEASY_LOGO_URL  VIGNETTE_URL

const FormData = require("form-data");
const fetch    = require("node-fetch");
const sharp    = require("sharp");

const BACKGROUND_COLOR = "#F2F2F2";

const AUTOEASY_LOGO_B64 = "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";

// ─────────────────────────────────────────────────────────────────────────────
// RETRY HELPER
// ─────────────────────────────────────────────────────────────────────────────
async function withRetry(fn, maxAttempts = 3, backoffMs = [0, 2000, 4000]) {
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    if (backoffMs[attempt] > 0) await new Promise(r => setTimeout(r, backoffMs[attempt]));
    try {
      return await fn();
    } catch (err) {
      const msg = err.message || "";
      const isRetryable = msg.includes("503") || msg.includes("429") ||
                          msg.includes("Service Unavailable") || msg.includes("Too Many Requests");
      console.warn(`[retry] Tentative ${attempt + 1}/${maxAttempts} — ${msg}`);
      if (!isRetryable || attempt === maxAttempts - 1) throw err;
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// WATERMARKLY
// ─────────────────────────────────────────────────────────────────────────────
async function blurPlateWatermarkly(imageBuffer) {
  try {
    const API_URL = "https://blur-api-eu1.watermarkly.com/blur/";
    const API_KEY = process.env.WATERMARKLY_API_KEY;
    const logoUrl = process.env.AUTOEASY_LOGO_URL || "";

    const params = new URLSearchParams({
      blur_intensity:      "10",
      format:              "jpeg",
      detection_threshold: "0.05",
    });
    if (logoUrl) { params.set("logo_url", logoUrl); params.set("logo_size", "1.3"); }

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
// FIND PLATE REGION
// Compare original vs résultat Watermarkly pour localiser la plaque modifiée.
//
// Corrections v3 (plaque arrière voiture blanche) :
//   - THR abaissé à 30 : capte les pixels de fond blanc→blanc (diff faible)
//   - MIN_CHANGED très bas : capte même si seuls les chiffres changent
//   - Padding dynamique généreux en Y : couvre toute la hauteur plaque
//   - Ratio largeur/hauteur retiré : angles inhabituels produisent des ratios variés
// ─────────────────────────────────────────────────────────────────────────────
async function findPlateRegion(origBuffer, wmBuffer) {
  try {
    const { width: W, height: H } = await sharp(origBuffer).metadata();

    // Downscaler pour la perf (max 800px de large)
    const scale = Math.min(1, 800 / W);
    const cW    = Math.round(W * scale);
    const cH    = Math.round(H * scale);

    const [oRaw, wRaw] = await Promise.all([
      sharp(origBuffer).resize(cW, cH).raw().toBuffer({ resolveWithObject: true }),
      sharp(wmBuffer).resize(cW, cH).raw().toBuffer({ resolveWithObject: true }),
    ]);

    const oD  = oRaw.data;
    const wD  = wRaw.data;
    const ch  = oRaw.info.channels;
    // THR = 30 : capte les changements fond blanc clair → blanc pur (diff ~45)
    // et les chiffres noirs → blanc (diff ~600)
    const THR = 30;

    const rowCount = new Int32Array(cH);
    const colCount = new Int32Array(cW);
    let total = 0;

    for (let y = 0; y < cH; y++) {
      for (let x = 0; x < cW; x++) {
        const i = (y * cW + x) * ch;
        const d = Math.abs(oD[i]-wD[i]) + Math.abs(oD[i+1]-wD[i+1]) + Math.abs(oD[i+2]-wD[i+2]);
        if (d > THR) { rowCount[y]++; colCount[x]++; total++; }
      }
    }

    // Seuil minimal très bas — même une petite plaque doit être trouvée
    const MIN_CHANGED = Math.max(10, Math.round(cW * cH * 0.0001));
    console.log(`[findPlate] total=${total} min=${MIN_CHANGED} (${cW}x${cH})`);
    if (total < MIN_CHANGED) return null;

    // Pic de densité par ligne/colonne
    let maxRow = 0, maxCol = 0;
    for (let y = 0; y < cH; y++) if (rowCount[y] > maxRow) maxRow = rowCount[y];
    for (let x = 0; x < cW; x++) if (colCount[x] > maxCol) maxCol = colCount[x];
    if (maxRow === 0) return null;

    // Seuil : 20% du max (on attrape les bords de la plaque)
    const rowThr = Math.max(1, Math.round(maxRow * 0.2));
    const colThr = Math.max(1, Math.round(maxCol * 0.2));

    let minY = cH, maxY = 0, minX = cW, maxX = 0;
    for (let y = 0; y < cH; y++) if (rowCount[y] >= rowThr) { minY = Math.min(minY, y); maxY = Math.max(maxY, y); }
    for (let x = 0; x < cW; x++) if (colCount[x] >= colThr) { minX = Math.min(minX, x); maxX = Math.max(maxX, x); }

    const bW = maxX - minX;
    const bH = maxY - minY;

    // Validation minimale (évite les artefacts ponctuels)
    if (bW < 8 || bH < 1) { console.log(`[findPlate] Zone trop petite (${bW}x${bH})`); return null; }
    if (bW > cW * 0.92)   { console.log("[findPlate] Zone trop large"); return null; }

    // Padding dynamique :
    //   X → 25% de la largeur détectée
    //   Y → 100% de la hauteur détectée (couvre les bords de plaque non chargés)
    const padX = Math.max(4, Math.round(bW * 0.25));
    const padY = Math.max(4, Math.round(bH * 1.0));

    const dsLeft  = Math.max(0, minX - padX);
    const dsTop   = Math.max(0, minY - padY);
    const dsRight = Math.min(cW, maxX + padX);
    const dsBot   = Math.min(cH, maxY + padY);

    // Repasser en coordonnées originales
    const oLeft  = Math.max(0, Math.round(dsLeft  / scale));
    const oTop   = Math.max(0, Math.round(dsTop   / scale));
    const oRight = Math.min(W, Math.round(dsRight / scale));
    const oBot   = Math.min(H, Math.round(dsBot   / scale));

    const region = { left: oLeft, top: oTop, width: oRight - oLeft, height: oBot - oTop };
    console.log(`[findPlate] Région : (${oLeft},${oTop}) ${region.width}x${region.height}px`);
    return region;

  } catch (err) {
    console.warn("[findPlate] Erreur :", err.message);
    return null;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// COMPOSITE LOGO SUR LA RÉGION
// ─────────────────────────────────────────────────────────────────────────────
async function compositeLogoOnRegion(imageBuffer, region) {
  const logoBuffer = Buffer.from(AUTOEASY_LOGO_B64, "base64");
  const overlay = await sharp(logoBuffer)
    .resize(region.width, region.height, {
      fit:        "contain",
      background: { r: 255, g: 255, b: 255, alpha: 1 },
    })
    .flatten({ background: { r: 255, g: 255, b: 255 } })
    .png()
    .toBuffer();

  return sharp(imageBuffer)
    .composite([{ input: overlay, top: region.top, left: region.left }])
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
    if (!image) return res.status(200).json({ success: false, error: 'Champ "image" manquant.' });

    const base64Data  = image.includes(",") ? image.split(",")[1] : image;
    const mimeType    = image.includes("data:") ? image.split(";")[0].split(":")[1] : "image/jpeg";
    const imageBuffer = Buffer.from(base64Data, "base64");

    if (imageBuffer.length > 20 * 1024 * 1024) {
      return res.status(200).json({ success: false, error: "Image trop volumineuse (max 20 Mo)." });
    }

    // ── 1. Watermarkly ──────────────────────────────────────────────────────
    console.log("[Pipeline] Étape 1 — Watermarkly...");
    const watermarklyResult = await blurPlateWatermarkly(imageBuffer);
    if (!watermarklyResult) console.warn("[Pipeline] Watermarkly échoué — image originale utilisée");

    // ── 2. Logo garanti (diff + composite) ──────────────────────────────────
    let imageForPhotoroom = watermarklyResult ?? imageBuffer;

    if (watermarklyResult) {
      console.log("[Pipeline] Étape 2 — Logo garanti...");
      try {
        const region = await findPlateRegion(imageBuffer, watermarklyResult);
        if (region) {
          imageForPhotoroom = await compositeLogoOnRegion(watermarklyResult, region);
          console.log("[Pipeline] Logo composite appliqué");
        } else {
          console.log("[Pipeline] Aucune région plaque — watermarkly conservé tel quel");
        }
      } catch (e) {
        console.warn("[Pipeline] Logo garanti échoué :", e.message);
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
    console.log(`[Pipeline] Photoroom OK — ${imgW}px`);

    // ── 4. Vignette AE ───────────────────────────────────────────────────────
    const vignetteUrl = process.env.VIGNETTE_URL || "https://cotecars-test.vercel.app/vignette-AE.png";
    try {
      const vigRes     = await fetch(vignetteUrl);
      const vigBuf     = Buffer.from(await vigRes.arrayBuffer());
      const VIG_SIZE   = Math.round(imgW * 0.08);
      const VIG_PAD    = Math.round(imgW * 0.02);
      const vigResized = await sharp(vigBuf)
        .resize(VIG_SIZE, VIG_SIZE, { fit: "contain", background: { r:0,g:0,b:0,alpha:0 } })
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