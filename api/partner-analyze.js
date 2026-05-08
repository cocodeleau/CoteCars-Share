// api/partner-analyze.js
//
// Workflow :
//   1. Photoroom  → détourage PNG transparent
//   2. Replicate  → logerfo/sdxl-controlnet-inpaint-background
//                   Masque flouté (blur 20px) pour ombres de contact sous les pneus
//   3. Gemini     → coordonnées plaque en pixels absolus
//   4. Sharp      → bandeau AUTOEASY
//
// Reçoit : POST JSON { image: "data:image/jpeg;base64,..." }
// Renvoie : { success: true, result: "data:image/jpeg;base64,...", plateDetected: bool }
//        ou { success: false, error: "..." }

import Replicate from 'replicate';
import FormData  from 'form-data';
import fetch     from 'node-fetch';
import sharp     from 'sharp';
import { GoogleGenerativeAI } from '@google/generative-ai';

const SHOWROOM_URL    = 'https://res.cloudinary.com/di3xa7ldg/image/upload/autoeasy-bg_tdjz2c.jpg';
// Hash de stability-ai/stable-diffusion-inpainting — source : replicate.com/stability-ai/stable-diffusion-inpainting
const REPLICATE_VERSION = 'black-forest-labs/flux-fill-pro';
const INPAINT_SIZE    = 1024;
const POLL_INTERVAL   = 2500;  // ms entre chaque vérification de statut
const MAX_WAIT_MS     = 55000; // 55s max (sous la limite maxDuration: 60s de Vercel)

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

    // ── 1. Photoroom → PNG transparent ───────────────────────────
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
    console.log(`[Photoroom] OK — ${carPngRaw.length} octets`);

    // ── 2. Replicate — Inpainting avec masque flouté ──────────────

    // 2a. Redimensionner fond + voiture à 1024×1024
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

    // 2b. Image d'init : fond + voiture
    const initImageBuffer = await sharp(bgResized)
      .composite([{ input: carResized }])
      .jpeg({ quality: 95 })
      .toBuffer();

    // 2c. Masque précis — UNIQUEMENT la zone sol directement sous les pneus
    //
    // Logique pixel par pixel :
    //   • Voiture (alpha > 30)           → noir (carrosserie 100% protégée)
    //   • Zone sol bas 28% SANS voiture  → blanc (IA peint les ombres ici)
    //   • Reste du fond (haut + côtés)   → noir (showroom préservé intact)
    //
    // Résultat : FLUX ne touche qu'une fine bande sous les roues.

    const alphaRaw    = await sharp(carResized).extractChannel('alpha').raw().toBuffer();
    const shadowStart = Math.round(INPAINT_SIZE * 0.72); // zone sol = bottom 28%
    const maskPixels  = Buffer.alloc(INPAINT_SIZE * INPAINT_SIZE);

    for (let y = 0; y < INPAINT_SIZE; y++) {
      for (let x = 0; x < INPAINT_SIZE; x++) {
        const i            = y * INPAINT_SIZE + x;
        const isCar        = alphaRaw[i] > 30;
        const inShadowZone = y >= shadowStart;
        // Blanc uniquement : dans la zone sol ET pas sur la voiture
        maskPixels[i] = (!isCar && inShadowZone) ? 255 : 0;
      }
    }

    // Feathering léger pour une transition naturelle entre l'ombre et le sol
    const maskBuffer = await sharp(maskPixels, {
      raw: { width: INPAINT_SIZE, height: INPAINT_SIZE, channels: 1 },
    })
      .blur(6)
      .png()
      .toBuffer();

    const initB64 = 'data:image/jpeg;base64,' + initImageBuffer.toString('base64');
    const maskB64 = 'data:image/png;base64,'  + maskBuffer.toString('base64');

    // 2d. Appel Replicate — replicate.run() gère la résolution de version automatiquement.
    // Promise.race() garantit qu'on ne dépasse jamais MAX_WAIT_MS (55s).
    const replicate  = new Replicate({ auth: process.env.REPLICATE_API_TOKEN });
    const startTime  = Date.now();

    console.log(`[Replicate] Lancement de ${REPLICATE_VERSION}...`);

    const replicateOutput = await Promise.race([
      replicate.run(REPLICATE_VERSION, {
        input: {
          // image : fond showroom Cloudinary seul (sans la voiture)
          // FLUX préserve tout ce qui est hors du masque → showroom intact
          image:           'data:image/jpeg;base64,' + bgResized.toString('base64'),
          mask:            maskB64,
          prompt:          'A luxury car in a showroom, high-end checkerboard floor, realistic contact shadows under tires, 8k resolution, cinematic lighting.',
          guidance:        15,
          steps:           40,
          output_format:   'jpg',
          safety_tolerance: 2,
        },
      }),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error(`Replicate timeout après ${MAX_WAIT_MS/1000}s — plan Pro requis pour maxDuration: 60`)), MAX_WAIT_MS)
      ),
    ]);

    const elapsed = Math.round((Date.now() - startTime) / 1000);
    console.log(`[Replicate] Terminé en ${elapsed}s`);

    const outputUrl = Array.isArray(replicateOutput) ? replicateOutput[0] : replicateOutput;
    if (!outputUrl) throw new Error('Replicate : aucune URL de sortie.');

    const replicateImgRes = await fetch(String(outputUrl));
    if (!replicateImgRes.ok) throw new Error('Impossible de télécharger le résultat Replicate.');

    // FLUX a travaillé sur le fond seul → on recompose la voiture Photoroom par-dessus.
    // Résultat : ombres IA au sol + carrosserie 100% originale et contractuelle.
    const fusedBuffer = await sharp(Buffer.from(await replicateImgRes.arrayBuffer()))
      .composite([{ input: carResized }])
      .jpeg({ quality: 92 })
      .toBuffer();
    const { width: imgW, height: imgH } = await sharp(fusedBuffer).metadata();

    // ── 3. Gemini → pixels absolus de la plaque ──────────────────
    const genAI    = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
    const model    = genAI.getGenerativeModel({ model: 'gemini-2.5-flash' });
    const b64Fused = fusedBuffer.toString('base64');

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
        const result  = await model.generateContent({
          contents: [{ role: 'user', parts: [
            { inlineData: { mimeType: 'image/jpeg', data: b64Fused } },
            { text: geminiPrompt },
          ]}],
          generationConfig: { responseMimeType: 'application/json', maxOutputTokens: 4096 },
        });
        const rawText = result.response.text();
        console.log('[Gemini] Réponse:', rawText);
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

    // ── 4. Sharp → bandeau AUTOEASY ──────────────────────────────
    let finalBuffer;

    if (plateCoords && geminiSuccess) {
      const { x, y, width, height } = plateCoords;
      const sx = Math.max(0, Math.min(x,     imgW - 1));
      const sy = Math.max(0, Math.min(y,     imgH - 1));
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
      console.warn('[Sharp] Plaque non détectée — image sans bandeau.');
      finalBuffer = await sharp(fusedBuffer).jpeg({ quality: 92 }).toBuffer();
    }

    console.log(`[Sharp] Terminé — ${finalBuffer.length} octets`);

    return res.status(200).json({
      success:       true,
      result:        'data:image/jpeg;base64,' + finalBuffer.toString('base64'),
      plateDetected: !!(plateCoords && geminiSuccess),
    });

  } catch (error) {
    console.error('[partner-analyze] Erreur:', error);
    return res.status(200).json({
      success: false,
      error:   error.message || 'Erreur serveur inconnue.',
      stack:   error.stack   || '',
    });
  }
}