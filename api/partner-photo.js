// api/partner-photo.js
//
// Pipeline :
//   1. Photoroom v2  → détourage + fond gris studio IA (prompt + seed fixe 42)
//   2. Gemini        → coordonnées plaque (pixels absolus)
//   3. Sharp         → bandeau AUTOEASY sur la plaque
//
// Reçoit : POST JSON { image: "data:image/jpeg;base64,..." }
// Renvoie : { success: true, result: "data:image/jpeg;base64,...", plateDetected: bool }
//        ou { success: false, error: "..." }
//
// Variables d'env Vercel requises :
//   PHOTOROOM_API_KEY
//   GEMINI_API_KEY

const FormData = require("form-data");
const fetch    = require("node-fetch");
const sharp    = require("sharp");
const { GoogleGenerativeAI } = require("@google/generative-ai");

// Fond gris studio neutre — seed fixe pour cohérence entre tous les lots
const PHOTOROOM_PROMPT = [
  "Professional car photography studio.",
  "Smooth light grey concrete floor with subtle reflections.",
  "Light grey studio wall in background.",
  "Soft diffused studio lighting, no harsh shadows.",
  "Clean, minimal, premium automotive dealership atmosphere.",
  "Photorealistic, 8K.",
].join(" ");

const PHOTOROOM_SEED = 42;

// Retry helper — tente jusqu'à maxAttempts fois avec backoff exponentiel
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
                          msg.includes("Service Unavailable") || msg.includes("Too Many Requests");
      console.warn(`[retry] Tentative ${attempt + 1}/${maxAttempts} échouée — ${msg}`);
      if (!isRetryable || attempt === maxAttempts - 1) throw err;
    }
  }
}

module.exports = async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ success: false, error: "Method not allowed" });
  }

  try {
    // ── 0. Lecture du base64 ──────────────────────────────────────
    const { image } = req.body;
    if (!image) {
      return res.status(200).json({ success: false, error: 'Champ "image" manquant.' });
    }

    const base64Data  = image.includes(",") ? image.split(",")[1] : image;
    const mimeType    = image.includes("data:") ? image.split(";")[0].split(":")[1] : "image/jpeg";
    const imageBuffer = Buffer.from(base64Data, "base64");

    // Vérification taille (limite 20 Mo)
    if (imageBuffer.length > 20 * 1024 * 1024) {
      return res.status(200).json({ success: false, error: "Image trop volumineuse (max 20 Mo)." });
    }

    // ── 1. Photoroom v2 → détourage + fond gris studio ───────────
    console.log("[Photoroom] Envoi de la requête...");

    const photoroomForm = new FormData();
    photoroomForm.append("imageFile",           imageBuffer, { filename: "car.jpg", contentType: mimeType });
    photoroomForm.append("format",              "jpeg");
    photoroomForm.append("outputSize",          "preset:output_size_a");   // 1500×1000 landscape
    photoroomForm.append("padding",             "0.05");
    photoroomForm.append("background.prompt",   PHOTOROOM_PROMPT);
    photoroomForm.append("background.seed",     String(PHOTOROOM_SEED));

    let prRes;
    try {
      prRes = await withRetry(() =>
        fetch("https://image-api.photoroom.com/v2/edit", {
          method:  "POST",
          headers: {
            "x-api-key": process.env.PHOTOROOM_API_KEY,
            ...photoroomForm.getHeaders(),
          },
          body: photoroomForm,
        })
      );
    } catch (e) {
      return res.status(200).json({ success: false, error: "Photoroom injoignable : " + e.message });
    }

    if (!prRes.ok) {
      const errText = await prRes.text().catch(() => "");
      console.error(`[Photoroom] Erreur ${prRes.status} :`, errText);
      return res.status(200).json({
        success: false,
        error:   `Photoroom erreur ${prRes.status} : ${errText}`,
      });
    }

    const photoroomBuffer = Buffer.from(await prRes.arrayBuffer());
    const { width: imgW, height: imgH } = await sharp(photoroomBuffer).metadata();
    console.log(`[Photoroom] OK — ${imgW}x${imgH}`);

    // ── 2. Gemini → pixels absolus de la plaque ──────────────────
    const genAI  = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
    const gModel = genAI.getGenerativeModel({ model: "gemini-2.5-flash" });
    const b64Photo = photoroomBuffer.toString("base64");

    const geminiPrompt = `The image size is ${imgW} pixels wide and ${imgH} pixels high. ` +
      `Find the license plate on the car. ` +
      `Return ONLY a valid JSON object with absolute pixel coordinates (integers): ` +
      `{"license_plate": {"x": int, "y": int, "width": int, "height": int}} ` +
      `where x and y are the top-left corner. ` +
      `If no plate is visible, return: {"license_plate": null} ` +
      `No explanation, no markdown.`;

    let plateCoords   = null;
    let geminiSuccess = false;

    try {
      await withRetry(async () => {
        const result  = await gModel.generateContent({
          contents: [{ role: "user", parts: [
            { inlineData: { mimeType: "image/jpeg", data: b64Photo } },
            { text: geminiPrompt },
          ]}],
          generationConfig: { responseMimeType: "application/json", maxOutputTokens: 256 },
        });
        const rawText = result.response.text();
        console.log("[Gemini]", rawText);
        plateCoords   = JSON.parse(rawText).license_plate;
        geminiSuccess = true;
      });
    } catch (err) {
      console.warn("[Gemini] Échec définitif :", err.message);
      // On continue sans bandeau plutôt que de bloquer toute la photo
    }

    // ── 3. Sharp → bandeau AUTOEASY sur la plaque ────────────────
    let finalBuffer;

    if (plateCoords && geminiSuccess) {
      const { x, y, width, height } = plateCoords;
      const sx = Math.max(0, Math.min(x,      imgW - 1));
      const sy = Math.max(0, Math.min(y,      imgH - 1));
      const sw = Math.min(width,  imgW - sx);
      const sh = Math.min(height, imgH - sy);
      console.log(`[Sharp] Bandeau → left:${sx} top:${sy} w:${sw} h:${sh}`);

      const fontSize  = Math.round(sh * 0.52);
      const bannerSvg = `<svg width="${sw}" height="${sh}" xmlns="http://www.w3.org/2000/svg">
  <rect width="${sw}" height="${sh}" fill="#111111" rx="3"/>
  <text x="50%" y="52%" dominant-baseline="middle" text-anchor="middle"
    fill="#FFFFFF" font-family="Arial Black, Arial, sans-serif"
    font-weight="900" font-size="${fontSize}" letter-spacing="1">AUTOEASY</text>
</svg>`;

      finalBuffer = await sharp(photoroomBuffer)
        .composite([{ input: Buffer.from(bannerSvg), left: sx, top: sy }])
        .jpeg({ quality: 92 })
        .toBuffer();
    } else {
      console.warn("[Sharp] Plaque non détectée — image sans bandeau.");
      finalBuffer = await sharp(photoroomBuffer).jpeg({ quality: 92 }).toBuffer();
    }

    console.log(`[partner-photo] Terminé — ${finalBuffer.length} octets`);
    return res.status(200).json({
      success:       true,
      result:        "data:image/jpeg;base64," + finalBuffer.toString("base64"),
      plateDetected: !!(plateCoords && geminiSuccess),
    });

  } catch (error) {
    console.error("[partner-photo] Erreur inattendue :", error);
    return res.status(200).json({
      success: false,
      error:   error.message || "Erreur serveur inconnue.",
      stack:   error.stack   || "",
    });
  }
};
