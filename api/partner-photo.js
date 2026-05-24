// api/partner-photo.js
//
// Pipeline :
//   0. Sharp preprocessing (enhanced = sharpen + saturation)
//   1. Watermarkly (reçoit enhanced) → detection_threshold:0 / logo_size:1.0
//   2. Logo garanti :
//        S1 — diff(enhanced, wm, THR=30) : capte tout changement Watermarkly
//        S2 — pixels sombre→blanc       : spécifique plaque blanche/voiture blanche
//      → composite AUTOEASY_LOGO_B64 sur la zone trouvée
//   3. Photoroom v2 → détourage + fond #F2F2F2 + ombre
//   4. Vignette AE  → logo en haut à droite
//
// Variables Vercel : PHOTOROOM_API_KEY WATERMARKLY_API_KEY AUTOEASY_LOGO_URL VIGNETTE_URL

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
// WATERMARKLY
// detection_threshold : "0"   → détection forcée même confidence minimale
// logo_size           : "1.0" → taille exacte plaque (1.3 peut échouer sur
//                               petites plaques arrière/angulées)
// ─────────────────────────────────────────────────────────────────────────────
async function blurPlateWatermarkly(enhancedBuffer) {
  try {
    const API_URL = "https://blur-api-eu1.watermarkly.com/blur/";
    const API_KEY = process.env.WATERMARKLY_API_KEY;
    const logoUrl = process.env.AUTOEASY_LOGO_URL || "";

    const params = new URLSearchParams({
      blur_intensity:      "10",
      format:              "jpeg",
      detection_threshold: "0",     // ← forcé à 0 (toutes les plaques détectées)
    });
    if (logoUrl) {
      params.set("logo_url",  logoUrl);
      params.set("logo_size", "1.0"); // ← taille exacte, plus conservative
    }

    const res = await withRetry(() =>
      fetch(`${API_URL}?${params.toString()}`, {
        method:  "POST",
        headers: { "x-api-key": API_KEY, "Content-Type": "application/octet-stream" },
        body:    enhancedBuffer,
      })
    );
    if (!res.ok) { console.warn(`[Watermarkly] Erreur ${res.status}`); return null; }
    const buf = Buffer.from(await res.arrayBuffer());
    console.log(`[Watermarkly] OK — ${buf.length} octets`);
    return buf;
  } catch (err) { console.warn("[Watermarkly] Erreur :", err.message); return null; }
}

// ─────────────────────────────────────────────────────────────────────────────
// BUILD REGION — helper commun aux stratégies S1 et S2
// ─────────────────────────────────────────────────────────────────────────────
function buildRegion(rowCount, colCount, total, cW, cH, scale, W, H, label) {
  if (total < 3) return null;

  let maxRow = 0, maxCol = 0;
  for (let y = 0; y < cH; y++) if (rowCount[y] > maxRow) maxRow = rowCount[y];
  for (let x = 0; x < cW; x++) if (colCount[x] > maxCol) maxCol = colCount[x];
  if (maxRow === 0) return null;

  const rowThr = Math.max(1, Math.round(maxRow * 0.2));
  const colThr = Math.max(1, Math.round(maxCol * 0.2));

  let minY = cH, maxY = 0, minX = cW, maxX = 0;
  for (let y = 0; y < cH; y++) if (rowCount[y] >= rowThr) { minY = Math.min(minY, y); maxY = Math.max(maxY, y); }
  for (let x = 0; x < cW; x++) if (colCount[x] >= colThr) { minX = Math.min(minX, x); maxX = Math.max(maxX, x); }

  const bW = maxX - minX;
  const bH = maxY - minY;

  if (bW < 5 || bH < 1 || bW > cW * 0.92) {
    console.log(`[findPlate ${label}] bbox invalide (${bW}x${bH})`);
    return null;
  }

  const padX = Math.max(3, Math.round(bW * 0.25));
  const padY = Math.max(3, Math.round(bH * 1.2));

  const oL = Math.max(0, Math.round((minX - padX) / scale));
  const oT = Math.max(0, Math.round((minY - padY) / scale));
  const oR = Math.min(W, Math.round((maxX + padX) / scale));
  const oB = Math.min(H, Math.round((maxY + padY) / scale));

  console.log(`[findPlate ${label}] total=${total} → (${oL},${oT}) ${oR-oL}x${oB-oT}px`);
  return { left: oL, top: oT, width: oR - oL, height: oB - oT };
}

// ─────────────────────────────────────────────────────────────────────────────
// FIND PLATE REGION — 2 stratégies en cascade
//
// S1 : diff standard enhanced→wm (THR=30) — capte tout changement Watermarkly
// S2 : pixels sombres→blancs — spécifique plaque blanche sur voiture blanche
// ─────────────────────────────────────────────────────────────────────────────
async function findPlateRegion(enhancedBuffer, wmBuffer) {
  try {
    const { width: W, height: H } = await sharp(enhancedBuffer).metadata();
    const scale = Math.min(1, 800 / W);
    const cW = Math.round(W * scale);
    const cH = Math.round(H * scale);

    const [eRaw, wRaw] = await Promise.all([
      sharp(enhancedBuffer).resize(cW, cH).raw().toBuffer({ resolveWithObject: true }),
      sharp(wmBuffer).resize(cW, cH).raw().toBuffer({ resolveWithObject: true }),
    ]);

    const eD = eRaw.data;
    const wD = wRaw.data;
    const ch = eRaw.info.channels;

    // ── S1 : diff standard (THR=30) ─────────────────────────────────────────
    {
      const rowC = new Int32Array(cH);
      const colC = new Int32Array(cW);
      let total = 0;
      for (let y = 0; y < cH; y++) {
        for (let x = 0; x < cW; x++) {
          const i = (y * cW + x) * ch;
          const d = Math.abs(eD[i]-wD[i]) + Math.abs(eD[i+1]-wD[i+1]) + Math.abs(eD[i+2]-wD[i+2]);
          if (d > 30) { rowC[y]++; colC[x]++; total++; }
        }
      }
      console.log(`[findPlate S1] total=${total} (${cW}x${cH})`);
      const region = buildRegion(rowC, colC, total, cW, cH, scale, W, H, "S1");
      if (region) return region;
    }

    // ── S2 : pixels sombres→blancs ──────────────────────────────────────────
    {
      const rowC = new Int32Array(cH);
      const colC = new Int32Array(cW);
      let total = 0;
      for (let y = 0; y < cH; y++) {
        for (let x = 0; x < cW; x++) {
          const i = (y * cW + x) * ch;
          const wasDark  = eD[i] < 140 || eD[i+1] < 140 || eD[i+2] < 140;
          const nowLight = wD[i] > 210 && wD[i+1] > 210 && wD[i+2] > 210;
          if (wasDark && nowLight) { rowC[y]++; colC[x]++; total++; }
        }
      }
      console.log(`[findPlate S2] total=${total}`);
      const region = buildRegion(rowC, colC, total, cW, cH, scale, W, H, "S2");
      if (region) return region;
    }

    console.log("[findPlate] Aucune région détectée");
    return null;

  } catch (err) {
    console.warn("[findPlate] Erreur :", err.message);
    return null;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// COMPOSITE LOGO SUR LA RÉGION
// ─────────────────────────────────────────────────────────────────────────────
async function compositeLogoOnRegion(imageBuffer, region) {
  const logo = Buffer.from(AUTOEASY_LOGO_B64, "base64");
  const overlay = await sharp(logo)
    .resize(region.width, region.height, {
      fit:        "fill",
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
  if (!res.ok) throw new Error(`Photoroom ${res.status} : ${await res.text().catch(()=>"")}`);
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

    // ── 0. Preprocessing ────────────────────────────────────────────────────
    const enhanced = await sharp(imageBuffer)
      .sharpen({ sigma: 1.2, flat: 1, jagged: 2 })
      .modulate({ saturation: 1.1 })
      .jpeg({ quality: 96 })
      .toBuffer();

    // ── 1. Watermarkly (detection_threshold:0, logo_size:1.0) ───────────────
    console.log("[Pipeline] Étape 1 — Watermarkly...");
    const watermarklyResult = await blurPlateWatermarkly(enhanced);
    if (!watermarklyResult) console.warn("[Pipeline] Watermarkly échoué");

    // ── 2. Logo garanti (S1 + S2) ────────────────────────────────────────────
    let imageForPhotoroom = watermarklyResult ?? enhanced;
    let plateRegion = null;

    if (watermarklyResult) {
      console.log("[Pipeline] Étape 2 — Logo garanti...");
      try {
        plateRegion = await findPlateRegion(enhanced, watermarklyResult);
        if (plateRegion) {
          imageForPhotoroom = await compositeLogoOnRegion(watermarklyResult, plateRegion);
          console.log("[Pipeline] Logo composite OK");
        } else {
          console.log("[Pipeline] Aucune région — watermarkly conservé");
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
    } catch (e) { console.warn("[Pipeline] Vignette échouée :", e.message); }

    console.log(`[Pipeline] Terminé — ${photoroomBuffer.length} o | region: ${JSON.stringify(plateRegion)}`);

    return res.status(200).json({
      success:       true,
      result:        "data:image/jpeg;base64," + photoroomBuffer.toString("base64"),
      plateDetected: !!watermarklyResult,
      plateRegion,
    });

  } catch (error) {
    console.error("[partner-photo] Erreur :", error);
    return res.status(200).json({ success: false, error: error.message || "Erreur serveur." });
  }
};