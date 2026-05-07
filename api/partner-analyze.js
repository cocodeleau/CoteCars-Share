// api/partner-analyze.js
// Reçoit : POST JSON { image: "data:image/jpeg;base64,..." }
// Renvoie : JSON { success: true, result: "data:image/jpeg;base64,...", plateDetected: bool }
//        ou JSON { success: false, error: "..." }

import FormData from 'form-data';
import fetch from 'node-fetch';
import sharp from 'sharp';
import { GoogleGenerativeAI } from '@google/generative-ai';

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

    // ── 1. Photoroom — détourage + fond showroom + ombre ─────────
    const photoroomForm = new FormData();
    photoroomForm.append('imageFile', imageBuffer, {
      filename: 'car.jpg',
      contentType: mimeType,
    });
    photoroomForm.append('background.color', 'EAEAEA');
    photoroomForm.append('shadow.mode', 'ai.soft');
    photoroomForm.append('padding', '0.08');

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
      return res.status(200).json({ success: false, error: `Photoroom a retourné une erreur ${prRes.status}. ${errText}` });
    }

    const photoroomBuffer = Buffer.from(await prRes.arrayBuffer());
    console.log('[Photoroom] OK —', photoroomBuffer.length, 'octets');

    // ── 2. Gemini — détection plaque avec retry + backoff ─────────
    const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
    const model = genAI.getGenerativeModel({ model: 'gemini-2.5-flash' });

    const base64PR = photoroomBuffer.toString('base64');
    const prompt = `You are a license plate detector for automotive images.
Find the license plate in this image.
Return ONLY a valid JSON object with normalized coordinates (float 0-1, relative to image size):
{"license_plate": {"x_center": float, "y_center": float, "width": float, "height": float}}
If no plate is visible, return exactly: {"license_plate": null}
No explanation, no markdown.`;

    const MAX_ATTEMPTS = 3;
    const BACKOFF_MS   = [0, 2000, 4000]; // attente avant chaque tentative

    let plateCoords   = null;
    let geminiSuccess = false;

    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
      if (BACKOFF_MS[attempt] > 0) {
        console.log(`[Gemini] Tentative ${attempt + 1}/${MAX_ATTEMPTS} — attente ${BACKOFF_MS[attempt]}ms...`);
        await new Promise(r => setTimeout(r, BACKOFF_MS[attempt]));
      }

      try {
        const geminiResult = await model.generateContent({
          contents: [{
            role: 'user',
            parts: [
              { inlineData: { mimeType: 'image/png', data: base64PR } },
              { text: prompt },
            ],
          }],
          generationConfig: {
            responseMimeType: 'application/json',
            maxOutputTokens: 4096,
          },
        });

        const rawText = geminiResult.response.text();
        console.log('[Gemini] Réponse brute:', rawText);
        const parsed  = JSON.parse(rawText);
        plateCoords   = parsed.license_plate;
        geminiSuccess = true;
        break; // succès → sortie de boucle

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

    // Si Gemini a totalement échoué, on continue sans bandeau
    // (la photo Photoroom est quand même un bon résultat)
    if (!geminiSuccess) {
      console.warn('[Gemini] Toutes les tentatives ont échoué — image retournée sans bandeau.');
    }

    // ── 3. Sharp — incrustation du bandeau AUTOEASY ───────────────
    let finalBuffer;

    if (plateCoords && geminiSuccess) {
      const { width: prW, height: prH } = await sharp(photoroomBuffer).metadata();

      const pw = Math.round(plateCoords.width    * prW);
      const ph = Math.round(plateCoords.height   * prH);
      const px = Math.round(plateCoords.x_center * prW - pw / 2);
      const py = Math.round(plateCoords.y_center * prH - ph / 2);

      const sx = Math.max(0, Math.min(px, prW - 1));
      const sy = Math.max(0, Math.min(py, prH - 1));
      const sw = Math.min(pw, prW - sx);
      const sh = Math.min(ph, prH - sy);

      console.log(`[Sharp] Bandeau → x:${sx} y:${sy} w:${sw} h:${sh}`);

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
      finalBuffer = await sharp(photoroomBuffer).jpeg({ quality: 92 }).toBuffer();
    }

    // ── 4. Réponse ────────────────────────────────────────────────
    return res.status(200).json({
      success:       true,
      result:        'data:image/jpeg;base64,' + finalBuffer.toString('base64'),
      plateDetected: !!(plateCoords && geminiSuccess),
    });

  } catch (error) {
    // Catch global — Vercel ne crashe jamais en 500 muet
    console.error('[partner-analyze] Erreur non catchée:', error);
    return res.status(200).json({
      success: false,
      error:   error.message || 'Erreur serveur inconnue.',
      stack:   error.stack   || '',
    });
  }
}