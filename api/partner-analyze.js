// api/partner-analyze.js
//
// Workflow hybride :
//   1. Photoroom   → détourage PNG transparent
//   2. Sharp       → placement mathématique GROUND_LINE 85% sur le fond showroom
//                    + création du masque "sol uniquement" pixel par pixel
//   3. FLUX Fill   → génère les ombres de contact UNIQUEMENT dans la zone sol
//   4. Gemini      → coordonnées plaque
//   5. Sharp       → bandeau AUTOEASY
//
// Reçoit : POST JSON { image: "data:image/jpeg;base64,..." }
// Renvoie : { success: true, result: "data:image/jpeg;base64,...", plateDetected: bool }
//        ou { success: false, error: "..." }
//
// Variables d'env Vercel requises :
//   PHOTOROOM_API_KEY
//   REPLICATE_API_TOKEN
//   GEMINI_API_KEY

const Replicate = require("replicate");
const FormData  = require("form-data");
const fetch     = require("node-fetch");
const sharp     = require("sharp");
const { GoogleGenerativeAI } = require("@google/generative-ai");

const SHOWROOM_URL = "https://res.cloudinary.com/di3xa7ldg/image/upload/autoeasy-bg_tdjz2c.jpg";
const FLUX_MODEL   = "black-forest-labs/flux-fill-pro";
const CANVAS_W     = 1024;
const CANVAS_H     = 1024;
const GROUND_LINE  = 0.82;
const MAX_WAIT_MS  = 55000;

module.exports = async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ success: false, error: "Method not allowed" });
  }

  try {
    // ── 0. Lecture du base64 ─────────────────────────────────────
    const { image } = req.body;
    if (!image) return res.status(200).json({ success: false, error: 'Champ "image" manquant.' });

    const base64Data  = image.includes(",") ? image.split(",")[1] : image;
    const mimeType    = image.includes("data:") ? image.split(";")[0].split(":")[1] : "image/jpeg";
    const imageBuffer = Buffer.from(base64Data, "base64");

    // ── 1. Photoroom → PNG transparent ───────────────────────────
    const photoroomForm = new FormData();
    photoroomForm.append("imageFile",        imageBuffer, { filename: "car.jpg", contentType: mimeType });
    photoroomForm.append("format",           "png");
    photoroomForm.append("background.color", "transparent");
    photoroomForm.append("padding",          "0.02");

    let prRes;
    try {
      prRes = await fetch("https://image-api.photoroom.com/v2/edit", {
        method:  "POST",
        headers: { "x-api-key": process.env.PHOTOROOM_API_KEY, ...photoroomForm.getHeaders() },
        body:    photoroomForm,
      });
    } catch (e) {
      return res.status(200).json({ success: false, error: "Photoroom injoignable : " + e.message });
    }
    if (!prRes.ok) {
      const t = await prRes.text().catch(() => "");
      return res.status(200).json({ success: false, error: `Photoroom erreur ${prRes.status} : ${t}` });
    }

    const carPngBuffer = Buffer.from(await prRes.arrayBuffer());
    const { width: prW, height: prH } = await sharp(carPngBuffer).metadata();
    console.log(`[Photoroom] OK — ${prW}x${prH}`);

    // ── 2. Placement mathématique + création du masque ────────────
    const bgRes = await fetch(SHOWROOM_URL);
    if (!bgRes.ok) return res.status(200).json({ success: false, error: "Fond showroom introuvable." });
    const bgBuffer = await sharp(Buffer.from(await bgRes.arrayBuffer()))
      .resize(CANVAS_W, CANVAS_H, { fit: "cover" })
      .jpeg({ quality: 95 })
      .toBuffer();

    const maxCarW = Math.round(CANVAS_W * 0.82);
    const maxCarH = Math.round(CANVAS_H * GROUND_LINE * 0.96);
    const scale   = Math.min(maxCarW / prW, maxCarH / prH, 1);
    const carW    = Math.round(prW * scale);
    const carH    = Math.round(prH * scale);

    const groundY = Math.round(CANVAS_H * GROUND_LINE);
    const carLeft = Math.round((CANVAS_W - carW) / 2);
    const carTop  = groundY - carH;

    console.log(`[Sharp] Voiture ${carW}x${carH} | left:${carLeft} top:${carTop} | groundY:${groundY}`);

    const carResized = await sharp(carPngBuffer)
      .resize(carW, carH, { fit: "fill" })
      .png()
      .toBuffer();
    const alphaRaw = await sharp(carResized).extractChannel("alpha").raw().toBuffer();

    const initBuffer = await sharp(bgBuffer)
      .composite([{ input: carResized, left: carLeft, top: carTop }])
      .jpeg({ quality: 95 })
      .toBuffer();

    const SHADOW_MARGIN_X = 80;
    const SHADOW_ABOVE    = 40;
    const SHADOW_BELOW    = 120;

    const shadowXmin = carLeft - SHADOW_MARGIN_X;
    const shadowXmax = carLeft + carW + SHADOW_MARGIN_X;
    const shadowYmin = groundY - SHADOW_ABOVE;
    const shadowYmax = groundY + SHADOW_BELOW;

    const maskPixels = Buffer.alloc(CANVAS_W * CANVAS_H);
    for (let y = 0; y < CANVAS_H; y++) {
      for (let x = 0; x < CANVAS_W; x++) {
        const i = y * CANVAS_W + x;
        const inShadowZone = (x >= shadowXmin && x <= shadowXmax && y >= shadowYmin && y <= shadowYmax);
        if (!inShadowZone) { maskPixels[i] = 0; continue; }
        const carPixelX   = x - carLeft;
        const carPixelY   = y - carTop;
        const inCarBounds = (carPixelX >= 0 && carPixelX < carW && carPixelY >= 0 && carPixelY < carH);
        const isCar       = inCarBounds && alphaRaw[carPixelY * carW + carPixelX] > 30;
        maskPixels[i]     = isCar ? 0 : 255;
      }
    }

    const maskBuffer = await sharp(maskPixels, {
      raw: { width: CANVAS_W, height: CANVAS_H, channels: 1 },
    }).blur(8).png().toBuffer();

    const initB64 = "data:image/jpeg;base64," + initBuffer.toString("base64");
    const maskB64 = "data:image/png;base64,"  + maskBuffer.toString("base64");

    // ── 3. FLUX Fill Pro → ombres de contact ─────────────────────
    const replicate = new Replicate({ auth: process.env.REPLICATE_API_TOKEN });
    console.log("[FLUX] Génération des ombres...");

    const fluxOutput = await Promise.race([
      replicate.run(FLUX_MODEL, {
        input: {
          image:  initB64,
          mask:   maskB64,
          prompt: [
            "Photorealistic car showroom floor.",
            "Keep the exact same black and white checkerboard floor pattern, same tile size, high reflections.",
            "Strong ambient occlusion under the car.",
            "Heavy car contact shadows integrated into the checkerboard.",
            "Shadows integrated into the checkerboard tiles.",
            "Cinematic studio lighting, 8k resolution.",
          ].join(" "),
          guidance:         10,
          steps:            35,
          output_format:    "jpg",
          safety_tolerance: 2,
        },
      }),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error(`FLUX timeout après ${MAX_WAIT_MS / 1000}s`)), MAX_WAIT_MS)
      ),
    ]);

    const outputUrl = Array.isArray(fluxOutput) ? fluxOutput[0] : fluxOutput;
    if (!outputUrl) throw new Error("FLUX : aucune URL de sortie.");
    console.log(`[FLUX] Output : ${outputUrl}`);

    const fluxImgRes = await fetch(String(outputUrl));
    if (!fluxImgRes.ok) throw new Error("Impossible de télécharger le résultat FLUX.");

    const fusedBuffer            = Buffer.from(await fluxImgRes.arrayBuffer());
    const { width: imgW, height: imgH } = await sharp(fusedBuffer).metadata();
    console.log(`[FLUX] Image finale : ${imgW}x${imgH}`);

    // ── 4. Gemini → pixels absolus de la plaque ──────────────────
    const genAI  = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
    const gModel = genAI.getGenerativeModel({ model: "gemini-2.5-flash" });
    const b64Fused = fusedBuffer.toString("base64");

    const geminiPrompt = `The image size is ${imgW} pixels wide and ${imgH} pixels high. Find the license plate on the car. Return ONLY a valid JSON object with absolute pixel coordinates (integers): {"license_plate": {"x": int, "y": int, "width": int, "height": int}} where x and y are the top-left corner. If no plate is visible, return: {"license_plate": null} No explanation, no markdown.`;

    const MAX_ATTEMPTS = 3;
    const BACKOFF_MS   = [0, 2000, 4000];
    let plateCoords    = null;
    let geminiSuccess  = false;

    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
      if (BACKOFF_MS[attempt] > 0) {
        await new Promise(r => setTimeout(r, BACKOFF_MS[attempt]));
        console.log(`[Gemini] Tentative ${attempt + 1}/${MAX_ATTEMPTS}...`);
      }
      try {
        const result  = await gModel.generateContent({
          contents: [{ role: "user", parts: [
            { inlineData: { mimeType: "image/jpeg", data: b64Fused } },
            { text: geminiPrompt },
          ]}],
          generationConfig: { responseMimeType: "application/json", maxOutputTokens: 4096 },
        });
        const rawText = result.response.text();
        console.log("[Gemini]", rawText);
        plateCoords   = JSON.parse(rawText).license_plate;
        geminiSuccess = true;
        break;
      } catch (err) {
        const msg         = err.message || "";
        const isRetryable = msg.includes("503") || msg.includes("429") ||
                            msg.includes("Service Unavailable") || msg.includes("Too Many Requests");
        console.warn(`[Gemini] Tentative ${attempt + 1} échouée — ${msg}`);
        if (!isRetryable || attempt === MAX_ATTEMPTS - 1) break;
      }
    }

    // ── 5. Sharp → bandeau AUTOEASY ──────────────────────────────
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
      finalBuffer = await sharp(fusedBuffer)
        .composite([{ input: Buffer.from(bannerSvg), left: sx, top: sy }])
        .jpeg({ quality: 92 })
        .toBuffer();
    } else {
      console.warn("[Sharp] Plaque non détectée.");
      finalBuffer = await sharp(fusedBuffer).jpeg({ quality: 92 }).toBuffer();
    }

    console.log(`[Sharp] Terminé — ${finalBuffer.length} octets`);
    return res.status(200).json({
      success:       true,
      result:        "data:image/jpeg;base64," + finalBuffer.toString("base64"),
      plateDetected: !!(plateCoords && geminiSuccess),
    });

  } catch (error) {
    console.error("[partner-analyze] Erreur:", error);
    return res.status(200).json({
      success: false,
      error:   error.message || "Erreur serveur inconnue.",
      stack:   error.stack   || "",
    });
  }
};