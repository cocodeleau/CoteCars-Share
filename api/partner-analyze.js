// api/partner-analyze.js
//
// Workflow :
//   1. Photoroom  → détourage PNG transparent (voiture seule)
//   2. Replicate  → SDXL Inpainting : voiture posée sur le fond damier Cloudinary,
//                   IA génère ombres + reflets réalistes dans la zone fond uniquement
//                   Safeguard : voiture originale re-composée par-dessus (100% contractuel)
//   3. Gemini     → coordonnées plaque en pixels absolus sur l'image fusionnée
//   4. Sharp      → bandeau AUTOEASY à left=x, top=y (zéro calcul)
//
// ⚠️  TIMEOUT : ajoute dans vercel.json :
//     { "functions": { "api/partner-analyze.js": { "maxDuration": 60 } } }
//     (plan Pro requis pour dépasser 10s — SDXL prend ~20-40s)
//
// Reçoit : POST JSON { image: "data:image/jpeg;base64,..." }
// Renvoie : { success: true,  result: "data:image/jpeg;base64,...", plateDetected: bool }
//        ou { success: false, error: "...", stack: "..." }

import Replicate   from 'replicate';
import FormData    from 'form-data';
import fetch       from 'node-fetch';
import sharp       from 'sharp';
import { GoogleGenerativeAI } from '@google/generative-ai';

const SHOWROOM_URL    = 'https://res.cloudinary.com/di3xa7ldg/image/upload/autoeasy-bg_tdjz2c.jpg';
const REPLICATE_MODEL = 'stability-ai/sdxl-inpainting'; // SDK utilise la dernière version
const INPAINT_SIZE    = 1024; // résolution cible SDXL

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ success: false, error: 'Method not allowed' });
  }

  try {
    // ── 0. Lecture du base64 ─────────────────────────────────────
    const { image } = req.body;
    if (!image) {
      return res.status(200).json({ success: false, error: 'Champ "image" manquant.' });
    }
    const base64Data  = image.includes(',') ? image.split(',')[1] : image;
    const mimeType    = image.includes('data:') ? image.split(';')[0].split(':')[1] : 'image/jpeg';
    const imageBuffer = Buffer.from(base64Data, 'base64');

    // ── 1. Photoroom → PNG transparent (détourage seul) ──────────
    // Aucun fond ni ombre ici : on veut uniquement la voiture découpée
    // avec son canal alpha pour générer le masque Replicate.
    const photoroomForm = new FormData();
    photoroomForm.append('imageFile', imageBuffer, { filename: 'car.jpg', contentType: mimeType });
    photoroomForm.append('format', 'png');
    photoroomForm.append('background.color', 'transparent');
    photoroomForm.append('padding', '0.05');

    let prRes;
    try {
      prRes = await fetch('https://image-api.photoroom.com/v2/edit', {
        method:  'POST',
        headers: { 'x-api-key': process.env.PHOTOROOM_API_KEY, ...photoroomForm.getHeaders() },
        body:    photoroomForm,
      });
    } catch (e) {
      return res.status(200).json({ success: false, error: 'Photoroom injoignable : ' + e.message });
    }
    if (!prRes.ok) {
      const t = await prRes.text().catch(() => '');
      return res.status(200).json({ success: false, error: `Photoroom erreur ${prRes.status} : ${t}` });
    }

    const carPngRaw = Buffer.from(await prRes.arrayBuffer());
    console.log(`[Photoroom] Détourage OK — ${carPngRaw.length} octets`);

    // ── 2. Replicate — SDXL Inpainting ───────────────────────────

    // 2a. Fond showroom + voiture redimensionnés à 1024×1024 pour SDXL
    const bgRes = await fetch(SHOWROOM_URL);
    if (!bgRes.ok) return res.status(200).json({ success: false, error: 'Fond showroom introuvable.' });

    const bgResized = await sharp(Buffer.from(await bgRes.arrayBuffer()))
      .resize(INPAINT_SIZE, INPAINT_SIZE, { fit: 'cover' })
      .jpeg({ quality: 95 })
      .toBuffer();

    const carResized = await sharp(carPngRaw)
      .resize(INPAINT_SIZE, INPAINT_SIZE, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
      .png()
      .toBuffer();

    // 2b. Image d'init : fond showroom + voiture posée par-dessus
    const initImageBuffer = await sharp(bgResized)
      .composite([{ input: carResized }])
      .jpeg({ quality: 95 })
      .toBuffer();

    // 2c. Masque de protection
    // Convention SDXL : BLANC = zone à générer, NOIR = zone protégée
    // On extrait le canal alpha de la voiture et on l'inverse :
    //   voiture (alpha > 0) → noir  (0)   → protégée, IA ne touche pas
    //   fond    (alpha = 0) → blanc (255) → IA génère ombres + reflets
    const maskBuffer = await sharp(carResized)
      .extractChannel('alpha')
      .negate()
      .png()
      .toBuffer();

    // 2d. Conversion en data URIs (format attendu par Replicate)
    const initB64 = 'data:image/jpeg;base64,' + initImageBuffer.toString('base64');
    const maskB64 = 'data:image/png;base64,'  + maskBuffer.toString('base64');

    // 2e. Appel Replicate via SDK (gère le polling automatiquement)
    console.log('[Replicate] Envoi vers SDXL Inpainting...');
    const replicate = new Replicate({ auth: process.env.REPLICATE_API_TOKEN });

    const replicateOutput = await replicate.run(REPLICATE_MODEL, {
      input: {
        image:               initB64,
        mask:                maskB64,
        prompt:              'Photorealistic car in a modern high-end showroom with a shiny black and white checkerboard floor. Perfect grounding shadows under the tires, highly detailed floor reflections, studio lighting, 8k resolution, photorealistic.',
        negative_prompt:     'floating, levitation, distorted, cartoon, illustration, low quality, altered car body, missing tires, blurry, deformed wheels.',
        num_inference_steps: 30,
        guidance_scale:      8,
        strength:            0.75,
        width:               INPAINT_SIZE,
        height:              INPAINT_SIZE,
      },
    });

    // 2f. Récupérer l'image générée (Replicate renvoie une URL ou un tableau d'URLs)
    const outputUrl = Array.isArray(replicateOutput) ? replicateOutput[0] : replicateOutput;
    if (!outputUrl) throw new Error('Replicate : aucune URL de sortie dans la réponse.');
    console.log(`[Replicate] Output : ${outputUrl}`);

    const replicateImgRes = await fetch(String(outputUrl));
    if (!replicateImgRes.ok) throw new Error('Impossible de télécharger le résultat Replicate.');
    const replicateRaw = Buffer.from(await replicateImgRes.arrayBuffer());

    // 2g. Safeguard contractuel : re-composer la voiture originale par-dessus
    // Garantit que la carrosserie est pixel-perfect identique à l'originale.
    const fusedBuffer = await sharp(replicateRaw)
      .composite([{ input: carResized }])
      .jpeg({ quality: 92 })
      .toBuffer();

    const { width: imgW, height: imgH } = await sharp(fusedBuffer).metadata();
    console.log(`[Replicate+Sharp] Image fusionnée safeguard : ${imgW}x${imgH}`);

    // ── 3. Gemini → pixels absolus de la plaque ──────────────────
    const genAI    = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
    const model    = genAI.getGenerativeModel({ model: 'gemini-2.5-flash' });
    const b64Fused = fusedBuffer.toString('base64');

    const prompt = `The image size is ${imgW} pixels wide and ${imgH} pixels high. Find the license plate on the car. Return ONLY a valid JSON object with absolute pixel coordinates (integers): {"license_plate": {"x": int, "y": int, "width": int, "height": int}} where x and y are the top-left corner of the plate. If no plate is visible, return exactly: {"license_plate": null} No explanation, no markdown.`;

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
        const result  = await model.generateContent({
          contents: [{ role: 'user', parts: [
            { inlineData: { mimeType: 'image/jpeg', data: b64Fused } },
            { text: prompt },
          ]}],
          generationConfig: { responseMimeType: 'application/json', maxOutputTokens: 4096 },
        });
        const rawText = result.response.text();
        console.log('[Gemini] Réponse brute:', rawText);
        plateCoords   = JSON.parse(rawText).license_plate;
        geminiSuccess = true;
        break;
      } catch (err) {
        const msg         = err.message || '';
        const isRetryable = msg.includes('503') || msg.includes('429') ||
                            msg.includes('Service Unavailable') || msg.includes('Too Many Requests');
        console.warn(`[Gemini] Tentative ${attempt + 1} échouée — ${msg}`);
        if (!isRetryable || attempt === MAX_ATTEMPTS - 1) break;
      }
    }

    // ── 4. Sharp → bandeau AUTOEASY (coordonnées directes Gemini) ──
    let finalBuffer;

    if (plateCoords && geminiSuccess) {
      const { x, y, width, height } = plateCoords;
      const sx = Math.max(0, Math.min(x,      imgW - 1));
      const sy = Math.max(0, Math.min(y,      imgH - 1));
      const sw = Math.min(width,  imgW - sx);
      const sh = Math.min(height, imgH - sy);

      console.log(`[Sharp] Bandeau AUTOEASY → left:${sx} top:${sy} w:${sw} h:${sh}`);

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
      console.warn('[Sharp] Plaque non détectée — image sans bandeau.');
      finalBuffer = await sharp(fusedBuffer).jpeg({ quality: 92 }).toBuffer();
    }

    console.log(`[Sharp] Image finale : ${finalBuffer.length} octets`);

    return res.status(200).json({
      success:       true,
      result:        'data:image/jpeg;base64,' + finalBuffer.toString('base64'),
      plateDetected: !!(plateCoords && geminiSuccess),
    });

  } catch (error) {
    console.error('[partner-analyze] Erreur non catchée:', error);
    return res.status(200).json({
      success: false,
      error:   error.message || 'Erreur serveur inconnue.',
      stack:   error.stack   || '',
    });
  }
}