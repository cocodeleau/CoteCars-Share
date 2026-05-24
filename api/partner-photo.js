// api/partner-photo.js
//
// Pipeline :
//   1. Gemini Vision  → détecte la plaque (4 coins en % de l'image)
//   2. Sharp          → inset 15% + composite logo AutoEasy (anti-débordement)
//   3. Photoroom v2   → détourage + fond #F2F2F2 + ombre ai.soft
//   4. Sharp          → vignette AE en haut à droite
//
// Variables Vercel : PHOTOROOM_API_KEY  GEMINI_API_KEY  VIGNETTE_URL  AUTOEASY_LOGO_URL

const FormData = require("form-data");
const fetch    = require("node-fetch");
const sharp    = require("sharp");

const BACKGROUND_COLOR = "#F2F2F2";
const GEMINI_API_KEY   = process.env.GEMINI_API_KEY;
const GEMINI_MODEL     = "gemini-2.5-flash";

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
// ÉTAPE 1 — GEMINI VISION
// gemini-2.5-flash + thinkingBudget:0 → JSON complet sans troncature
// ─────────────────────────────────────────────────────────────────────────────
async function detectPlateWithGemini(imageBuffer) {
  try {
    const forGemini = await sharp(imageBuffer)
      .resize(1500, 1500, { fit: "inside", withoutEnlargement: true })
      .jpeg({ quality: 90 })
      .toBuffer();

    const base64 = forGemini.toString("base64");

    const prompt = `Analyze this car photo and locate the vehicle license plate.

If a license plate is visible, return a JSON object with the 4 corners of the plate:
{"found": true, "plate": {"tl": {"x": 0.25, "y": 0.85}, "tr": {"x": 0.45, "y": 0.84}, "br": {"x": 0.45, "y": 0.91}, "bl": {"x": 0.25, "y": 0.91}}}

If no license plate is visible:
{"found": false}

Rules:
- tl=top-left, tr=top-right, br=bottom-right, bl=bottom-left corners of the plate
- x = horizontal fraction (0.0=left edge, 1.0=right edge)
- y = vertical fraction (0.0=top edge, 1.0=bottom edge)
- Fit tightly around the plate only, not the bumper`;

    const url = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${GEMINI_API_KEY}`;

    const res = await withRetry(() =>
      fetch(url, {
        method:  "POST",
        headers: { "Content-Type": "application/json" },
        body:    JSON.stringify({
          contents: [{
            parts: [
              { inlineData: { mimeType: "image/jpeg", data: base64 } },
              { text: prompt },
            ],
          }],
          generationConfig: {
            temperature:      0,
            maxOutputTokens:  8192,
            responseMimeType: "application/json",
            thinkingConfig: { thinkingBudget: 0 },
          },
        }),
      })
    );

    if (!res.ok) {
      console.warn(`[Gemini] Erreur HTTP ${res.status} : ${await res.text().catch(() => "")}`);
      return null;
    }

    const data = await res.json();
    const raw  = (data.candidates?.[0]?.content?.parts || []).map(p => p.text || "").join("");
    console.log(`[Gemini] Réponse (${raw.length} chars) : ${raw.substring(0, 300)}`);

    if (!raw) { console.warn("[Gemini] Réponse vide"); return null; }

    const clean     = raw.replace(/```json|```/g, "").trim();
    const fixedJson = clean.replace(/([{,]\s*)([a-zA-Z_][a-zA-Z0-9_]*)(\s*):/g, '$1"$2"$3:');
    const parsed    = JSON.parse(fixedJson);

    if (!parsed.found) { console.log("[Gemini] Aucune plaque détectée"); return null; }

    const { tl, tr, br, bl } = parsed.plate;
    console.log(`[Gemini] Plaque OK : TL(${tl.x.toFixed(3)},${tl.y.toFixed(3)}) TR(${tr.x.toFixed(3)},${tr.y.toFixed(3)}) BR(${br.x.toFixed(3)},${br.y.toFixed(3)}) BL(${bl.x.toFixed(3)},${bl.y.toFixed(3)})`);
    return parsed.plate;

  } catch (err) {
    console.warn("[Gemini] Erreur :", err.message);
    return null;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// ÉTAPE 2 — CALCUL ZONE LOGO (inset 15% vers le centre)
// ─────────────────────────────────────────────────────────────────────────────
function computeLogoRegion(plate, W, H, insetPct = 0.15) {
  const cx = (plate.tl.x + plate.tr.x + plate.br.x + plate.bl.x) / 4;
  const cy = (plate.tl.y + plate.tr.y + plate.br.y + plate.bl.y) / 4;
  const inset = c => ({ x: c.x + (cx - c.x) * insetPct, y: c.y + (cy - c.y) * insetPct });
  const corners = [inset(plate.tl), inset(plate.tr), inset(plate.br), inset(plate.bl)];
  const xs = corners.map(c => c.x);
  const ys = corners.map(c => c.y);
  const left   = Math.max(0, Math.round(Math.min(...xs) * W));
  const top    = Math.max(0, Math.round(Math.min(...ys) * H));
  const right  = Math.min(W, Math.round(Math.max(...xs) * W));
  const bottom = Math.min(H, Math.round(Math.max(...ys) * H));
  return { left, top, width: right - left, height: bottom - top };
}

// ─────────────────────────────────────────────────────────────────────────────
// ÉTAPE 2 (suite) — COMPOSITE LOGO
// Logo fetché depuis l'URL Vercel (évite le base64 embarqué corrompu)
// ─────────────────────────────────────────────────────────────────────────────
async function compositeLogoOnRegion(imageBuffer, region) {
  const logoUrl = process.env.AUTOEASY_LOGO_URL || "https://cotecars-test.vercel.app/logo-ae.png";
  const logoRes = await fetch(logoUrl);
  if (!logoRes.ok) throw new Error(`Logo fetch ${logoRes.status} : ${logoUrl}`);
  const logoBuf = Buffer.from(await logoRes.arrayBuffer());

  const overlay = await sharp(logoBuf)
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
// ÉTAPE 3 — PHOTOROOM v2
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

    const { width: W, height: H } = await sharp(imageBuffer).metadata();

    // ── 1. Gemini Vision ────────────────────────────────────────────────────
    console.log(`[Pipeline] Étape 1 — Gemini Vision (${GEMINI_MODEL}, thinkingBudget:0)...`);
    const plate = await detectPlateWithGemini(imageBuffer);

    // ── 2. Composite logo ───────────────────────────────────────────────────
    let imageForPhotoroom = imageBuffer;
    let plateRegion       = null;

    if (plate) {
      plateRegion = computeLogoRegion(plate, W, H, 0.15);
      console.log(`[Pipeline] Étape 2 — Logo : (${plateRegion.left},${plateRegion.top}) ${plateRegion.width}x${plateRegion.height}px`);
      try {
        imageForPhotoroom = await compositeLogoOnRegion(imageBuffer, plateRegion);
        console.log("[Pipeline] Logo composite OK");
      } catch (e) {
        console.warn("[Pipeline] Composite échoué :", e.message);
        imageForPhotoroom = imageBuffer;
        plateRegion       = null;
      }
    } else {
      console.log("[Pipeline] Pas de plaque — image originale → Photoroom");
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

    console.log(`[Pipeline] Terminé — ${photoroomBuffer.length} o | region: ${JSON.stringify(plateRegion)}`);

    return res.status(200).json({
      success:       true,
      result:        "data:image/jpeg;base64," + photoroomBuffer.toString("base64"),
      plateDetected: !!plate,
      plateRegion,
    });

  } catch (error) {
    console.error("[partner-photo] Erreur :", error);
    return res.status(200).json({ success: false, error: error.message || "Erreur serveur." });
  }
};