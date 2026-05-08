// api/partner-analyze.js
//
// Workflow léger et stable (zéro Replicate) :
//   1. Photoroom /v2/edit → pose la voiture sur le fond showroom Cloudinary
//                           avec ombres IA natives (shadow.mode: ai.soft)
//   2. Gemini             → coordonnées plaque en pixels absolus
//   3. Sharp              → bandeau AUTOEASY
//
// Reçoit : POST JSON { image: "data:image/jpeg;base64,..." }
// Renvoie : { success: true, result: "data:image/jpeg;base64,...", plateDetected: bool }
//        ou { success: false, error: "..." }

import FormData from 'form-data';
import fetch    from 'node-fetch';
import sharp    from 'sharp';
import { GoogleGenerativeAI } from '@google/generative-ai';

const SHOWROOM_URL = 'https://res.cloudinary.com/di3xa7ldg/image/upload/autoeasy-bg_tdjz2c.jpg';

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ success: false, error: 'Method not allowed' });
  }

  try {
    // ── 0. Lecture du base64 ─────────────────────────────────────
    const { image } = req.body;
    if (!image) return res.status(200).json({ success: false, error: 'Champ "image" manquant.' });

    const base64Data  = image.includes(',') ? image.split(',')[1] : image;
    const mimeType    = image.includes('data:') ? image.split(';')[0].split(':')[1] : 'image/jpeg';
    const imageBuffer = Buffer.from(base64Data, 'base64');

    // ── 1. Photoroom → composition complète ──────────────────────
    // Photoroom détecte l'angle de la voiture, la détoure, la pose sur le
    // fond showroom et génère les ombres de contact avec son IA native.
    const photoroomForm = new FormData();
    photoroomForm.append('imageFile',                 imageBuffer, { filename: 'car.jpg', contentType: mimeType });
    photoroomForm.append('background.imageUrl',       SHOWROOM_URL); // fond showroom Cloudinary
    photoroomForm.append('shadow.mode',               'ai.soft');    // ombres de contact IA
    photoroomForm.append('padding',                   '0.1');        // marge autour de la voiture
    photoroomForm.append('outputSize',                '1920x1080'); // format final
    photoroomForm.append('subject.verticalAlignment', 'bottom');     // voiture ancrée en bas

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
      console.error('[Photoroom] Erreur:', prRes.status, t);
      return res.status(200).json({ success: false, error: `Photoroom erreur ${prRes.status} : ${t}` });
    }

    const fusedBuffer = Buffer.from(await prRes.arrayBuffer());
    const { width: imgW, height: imgH } = await sharp(fusedBuffer).metadata();
    console.log(`[Photoroom] OK — ${imgW}x${imgH}`);

    // ── 2. Gemini → pixels absolus de la plaque ──────────────────
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

    // ── 3. Sharp → bandeau AUTOEASY ──────────────────────────────
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

    console.log(`[Sharp] Image finale : ${finalBuffer.length} octets`);

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