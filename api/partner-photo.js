// api/partner-photo.js
//
// Pipeline par photo :
//   1. Photoroom v2       → détourage + fond #F2F2F2 + ombre portée ai.soft
//   2. PlateRecognizer    → bounding box + polygone 4 coins (mmc=true)
//   3. /api/warp-plate    → warp perspective OpenCV (Python) + bandeau AUTOEASY
//      └─ fallback SVG    → rectangle plat si warp échoue
//
// Reçoit : POST JSON { image: "data:image/jpeg;base64,..." }
// Renvoie : { success: true, result: "data:image/jpeg;base64,...", plateDetected: bool }
//        ou { success: false, error: "..." }
//
// Variables d'env Vercel requises :
//   PHOTOROOM_API_KEY
//   PLATERECOGNIZER_TOKEN
//   VERCEL_URL  (injecté automatiquement par Vercel)

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
// ÉTAPE 1 — PHOTOROOM
// Détourage + fond uni gris clair + ombre portée réaliste
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
// ÉTAPE 2 — PLATERECOGNIZER
// mmc=true active le retour du polygone 4 coins réels.
// Retourne { box, angle, polygon } ou null — NE THROW JAMAIS.
// ─────────────────────────────────────────────────────────────────────────────
async function detectPlate(imageBuffer) {
  try {
    const form = new FormData();
    form.append("upload",  imageBuffer, { filename: "car.jpg", contentType: "image/jpeg" });
    form.append("regions", "fr");    // France métropolitaine
    form.append("regions", "re");    // Réunion (DOM)
    form.append("mmc",     "true");  // active le polygone 4 coins

    const res = await withRetry(() =>
      fetch("https://api.platerecognizer.com/v1/plate-reader/", {
        method:  "POST",
        headers: {
          "Authorization": `Token ${process.env.PLATERECOGNIZER_TOKEN}`,
          ...form.getHeaders(),
        },
        body: form,
      })
    );

    if (!res.ok) {
      console.warn(`[PlateRecognizer] Erreur ${res.status} — image sans masque`);
      return null;
    }

    const data = await res.json();

    if (!data.results?.length) {
      console.log("[PlateRecognizer] Aucune plaque détectée");
      return null;
    }

    // Meilleur résultat par score de confiance
    const best = data.results.reduce((a, b) =>
      (b.score ?? 0) > (a.score ?? 0) ? b : a
    );

    // Extraction du polygone — PlateRecognizer le retourne dans
    // candidates[0].polygon quand mmc=true
    const polygon = best.candidates?.[0]?.polygon ?? null;

    console.log(
      `[PlateRecognizer] OK — score: ${best.score}` +
      ` | polygon: ${polygon ? "oui" : "non (fallback bbox)"}` +
      ` | box: ${JSON.stringify(best.box)}`
    );

    return {
      box:     best.box,       // { xmin, ymin, xmax, ymax }
      angle:   best.angle ?? 0,
      polygon: polygon,        // [{ x, y }×4] ou null
    };

  } catch (err) {
    console.warn("[PlateRecognizer] Erreur inattendue — image sans masque :", err.message);
    return null;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// ÉTAPE 3A — WARP PERSPECTIVE via /api/warp-plate (Python)
// Appel fetch interne Vercel — même domaine, pas de CORS.
// ─────────────────────────────────────────────────────────────────────────────
async function applyPlateMask(imageBuffer, plateResult, imgW, imgH) {

  // Aucune plaque détectée → image Photoroom telle quelle
  if (!plateResult) {
    return sharp(imageBuffer).jpeg({ quality: 92 }).toBuffer();
  }

  try {
    // VERCEL_URL est injecté automatiquement par Vercel en production
    const baseUrl = process.env.VERCEL_URL
      ? `https://${process.env.VERCEL_URL}`
      : "http://localhost:3000";

    const response = await fetch(`${baseUrl}/api/warp-plate`, {
      method:  "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        car_image:  imageBuffer.toString("base64"),
        polygon:    plateResult.polygon ?? null,
        bbox:       plateResult.box,
        img_width:  imgW,   // largeur image pour calcul côté fuyant Fake3D
        // logo_image: ajouter ici si logo PNG en base64
      }),
    });

    if (!response.ok) {
      throw new Error(`warp-plate HTTP ${response.status}`);
    }

    const data = await response.json();

    if (data.error) {
      throw new Error(data.error);
    }

    console.log(`[applyPlateMask] Warp OK — méthode: ${data.method}`);
    return Buffer.from(data.result, "base64");

  } catch (err) {
    // Fallback SVG plat — ne bloque jamais le lot
    console.warn("[applyPlateMask] Warp échoué, fallback SVG plat :", err.message);
    return applyFlatMask(imageBuffer, plateResult, imgW, imgH);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// ÉTAPE 3B — FALLBACK : rectangle SVG plat (si warp-plate échoue)
// ─────────────────────────────────────────────────────────────────────────────
async function applyFlatMask(imageBuffer, plateResult, imgW, imgH) {
  const { xmin, ymin, xmax, ymax } = plateResult.box;
  const pw     = xmax - xmin;
  const ph     = ymax - ymin;
  const cx     = xmin + pw / 2;
  const cy     = ymin + ph / 2;
  const angle  = plateResult.angle ?? 0;
  const fontSize = Math.max(10, Math.round(ph * 0.48));

  const svg = `<svg width="${imgW}" height="${imgH}" xmlns="http://www.w3.org/2000/svg">
    <g transform="rotate(${angle}, ${cx}, ${cy})">
      <rect x="${xmin}" y="${ymin}" width="${pw}" height="${ph}"
        fill="#111111" rx="3"/>
      <text x="${cx}" y="${cy}"
        dominant-baseline="middle" text-anchor="middle"
        fill="#FFFFFF" font-family="Arial Black, Arial, sans-serif"
        font-weight="900" font-size="${fontSize}" letter-spacing="1">AUTOEASY</text>
    </g>
  </svg>`;

  return sharp(imageBuffer)
    .composite([{ input: Buffer.from(svg), top: 0, left: 0 }])
    .jpeg({ quality: 92 })
    .toBuffer();
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

    if (imageBuffer.length > 20 * 1024 * 1024) {
      return res.status(200).json({ success: false, error: "Image trop volumineuse (max 20 Mo)." });
    }

    // ── 1. Photoroom ─────────────────────────────────────────────
    console.log("[Pipeline] Étape 1 — Photoroom...");
    let photoroomBuffer;
    try {
      photoroomBuffer = await runPhotoroom(imageBuffer, mimeType);
    } catch (err) {
      return res.status(200).json({ success: false, error: err.message });
    }

    const { width: imgW, height: imgH } = await sharp(photoroomBuffer).metadata();
    console.log(`[Pipeline] Photoroom OK — ${imgW}x${imgH}`);

    // ── 2. PlateRecognizer ────────────────────────────────────────
    console.log("[Pipeline] Étape 2 — PlateRecognizer...");
    const plateResult = await detectPlate(photoroomBuffer);

    // ── 3. Warp perspective ou fallback SVG ──────────────────────
    console.log("[Pipeline] Étape 3 — Masque plaque...");
    const finalBuffer = await applyPlateMask(photoroomBuffer, plateResult, imgW, imgH);

    console.log(`[Pipeline] Terminé — ${finalBuffer.length} octets | plaque: ${!!plateResult}`);

    return res.status(200).json({
      success:       true,
      result:        "data:image/jpeg;base64," + finalBuffer.toString("base64"),
      plateDetected: !!plateResult,
    });

  } catch (error) {
    console.error("[partner-photo] Erreur inattendue :", error);
    return res.status(200).json({
      success: false,
      error:   error.message || "Erreur serveur inconnue.",
    });
  }
};