// api/partner-analyze.js
//
// Workflow :
//   1. Photoroom  → envoie la voiture + background.imageUrl du fond AutoEasy.
//                   Photoroom analyse l'angle, détoure, redimensionne, pose la voiture
//                   sur le fond avec ombre. Il renvoie l'image fusionnée finale (JPEG).
//
//   2. Gemini     → analyse cette image fusionnée et retourne les coordonnées
//                   PIXEL ABSOLUS (x, y, width, height) de la plaque.
//
//   3. Sharp      → AUCUN calcul de scale ou d'offset.
//                   On prend l'image Photoroom telle quelle et on composite
//                   le bandeau AUTOEASY exactement à left=x, top=y.
//
// Reçoit : POST JSON { image: "data:image/jpeg;base64,..." }
// Renvoie : JSON { success: true, result: "data:image/jpeg;base64,...", plateDetected: bool }
//        ou JSON { success: false, error: "..." }

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
    if (!image) {
      return res.status(200).json({ success: false, error: 'Champ "image" manquant.' });
    }
    const base64Data  = image.includes(',') ? image.split(',')[1] : image;
    const mimeType    = image.includes('data:') ? image.split(';')[0].split(':')[1] : 'image/jpeg';
    const imageBuffer = Buffer.from(base64Data, 'base64');

    // ── 1. Photoroom — compositing IA complet ────────────────────
    // On envoie la voiture + l'URL du fond AutoEasy.
    // Photoroom détecte l'angle, détoure, positionne et fusionne tout seul.
    // On récupère directement l'image finale avec ombre et fond.
    const photoroomForm = new FormData();
    photoroomForm.append('imageFile', imageBuffer, {
      filename: 'car.jpg',
      contentType: mimeType,
    });
    photoroomForm.append('background.imageUrl', SHOWROOM_URL);
    photoroomForm.append('shadow.mode', 'ai.soft');
    photoroomForm.append('padding', '0.05');

    let prRes;
    try {
      prRes = await fetch('https://image-api.photoroom.com/v2/edit', {
        method: 'POST',
        headers: {
          'x-api-key': process.env.PHOTOROOM_API_KEY,
          ...photoroomForm.getHeaders(),
        },
        body: photoroomForm,
      });
    } catch (fetchErr) {
      return res.status(200).json({ success: false, error: 'Photoroom injoignable : ' + fetchErr.message });
    }

    if (!prRes.ok) {
      const errText = await prRes.text().catch(() => '');
      console.error('[Photoroom] Erreur:', prRes.status, errText);
      return res.status(200).json({ success: false, error: `Photoroom erreur ${prRes.status} : ${errText}` });
    }

    const fusedBuffer = Buffer.from(await prRes.arrayBuffer());
    const { width: imgW, height: imgH } = await sharp(fusedBuffer).metadata();
    console.log(`[Photoroom] Image fusionnée : ${imgW}x${imgH}`);

    // ── 2. Gemini — pixels absolus sur l'image fusionnée ─────────
    // Gemini analyse l'image finale (celle que verra l'utilisateur).
    // Les coordonnées retournées correspondent directement aux pixels de cette image.
    const genAI   = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
    const model   = genAI.getGenerativeModel({ model: 'gemini-2.5-flash' });
    const base64Fused = fusedBuffer.toString('base64');

    const prompt = `The image size is ${imgW} pixels wide and ${imgH} pixels high. Find the license plate on the car. Return ONLY a valid JSON object with absolute pixel coordinates (integers): {"license_plate": {"x": int, "y": int, "width": int, "height": int}} where x and y are the top-left corner of the plate. If no plate is visible, return exactly: {"license_plate": null} No explanation, no markdown.`;

    const MAX_ATTEMPTS = 3;
    const BACKOFF_MS   = [0, 2000, 4000];
    let plateCoords    = null;
    let geminiSuccess  = false;

    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
      if (BACKOFF_MS[attempt] > 0) {
        console.log(`[Gemini] Tentative ${attempt + 1}/${MAX_ATTEMPTS} — attente ${BACKOFF_MS[attempt]}ms...`);
        await new Promise(r => setTimeout(r, BACKOFF_MS[attempt]));
      }
      try {
        const result  = await model.generateContent({
          contents: [{
            role: 'user',
            parts: [
              { inlineData: { mimeType: 'image/jpeg', data: base64Fused } },
              { text: prompt },
            ],
          }],
          generationConfig: { responseMimeType: 'application/json', maxOutputTokens: 4096 },
        });
        const rawText = result.response.text();
        console.log('[Gemini] Réponse brute:', rawText);
        plateCoords   = JSON.parse(rawText).license_plate;
        geminiSuccess = true;
        break;
      } catch (geminiErr) {
        const msg         = geminiErr.message || '';
        const isRetryable = msg.includes('503') || msg.includes('429') ||
                            msg.includes('Service Unavailable') || msg.includes('Too Many Requests');
        console.warn(`[Gemini] Tentative ${attempt + 1} échouée — ${msg}`);
        if (!isRetryable || attempt === MAX_ATTEMPTS - 1) {
          console.error('[Gemini] Abandon après', attempt + 1, 'tentative(s).');
          break;
        }
      }
    }

    // ── 3. Sharp — bandeau AUTOEASY uniquement ───────────────────
    // Aucun calcul de scale, carTop, CANVAS_H ou offset.
    // On utilise directement les pixels renvoyés par Gemini.
    let finalBuffer;

    if (plateCoords && geminiSuccess) {
      const { x, y, width, height } = plateCoords;

      // Clamping de sécurité pour rester dans les bounds de l'image
      const sx = Math.max(0, Math.min(x,     imgW - 1));
      const sy = Math.max(0, Math.min(y,     imgH - 1));
      const sw = Math.min(width,  imgW - sx);
      const sh = Math.min(height, imgH - sy);

      console.log(`[Sharp] Bandeau AUTOEASY → left:${sx} top:${sy} w:${sw} h:${sh}`);

      const fontSize  = Math.round(sh * 0.52);
      const bannerSvg = `<svg width="${sw}" height="${sh}" xmlns="http://www.w3.org/2000/svg">
  <rect width="${sw}" height="${sh}" fill="#111111" rx="3"/>
  <text x="50%" y="52%"
    dominant-baseline="middle" text-anchor="middle"
    fill="#FFFFFF" font-family="Arial Black, Arial, sans-serif"
    font-weight="900" font-size="${fontSize}" letter-spacing="1">AUTOEASY</text>
</svg>`;

      finalBuffer = await sharp(fusedBuffer)
        .composite([{ input: Buffer.from(bannerSvg), left: sx, top: sy }])
        .jpeg({ quality: 92 })
        .toBuffer();

    } else {
      // Pas de plaque détectée → on retourne l'image Photoroom telle quelle
      console.warn('[Sharp] Plaque non détectée — image retournée sans bandeau.');
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