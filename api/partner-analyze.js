// api/partner-analyze.js
// Reçoit : POST JSON { image: "data:image/jpeg;base64,..." }
// Renvoie : JSON { result: "data:image/jpeg;base64,..." , plateDetected: bool }

import FormData from 'form-data';
import fetch from 'node-fetch';
import sharp from 'sharp';
import { GoogleGenerativeAI } from '@google/generative-ai';

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    // ── 0. Lecture du base64 envoyé par le frontend ──────────────────────
    const { image } = req.body;
    if (!image) {
      return res.status(400).json({ error: 'Champ "image" manquant.' });
    }

    // Supporte "data:image/jpeg;base64,..." ou base64 brut
    const base64Data  = image.includes(',') ? image.split(',')[1] : image;
    const mimeType    = image.includes('data:') ? image.split(';')[0].split(':')[1] : 'image/jpeg';
    const imageBuffer = Buffer.from(base64Data, 'base64');

    // ── 1. Photoroom — détourage + fond showroom + ombre de contact ───────
    const photoroomForm = new FormData();
    photoroomForm.append('imageFile', imageBuffer, {
      filename: 'car.jpg',
      contentType: mimeType,
    });
    photoroomForm.append('background.color', 'EAEAEA'); // gris clair showroom
    photoroomForm.append('shadow.mode', 'ai.soft');     // ombre de contact au sol
    photoroomForm.append('padding', '0.08');            // 8% de marge autour de la voiture

    const prRes = await fetch('https://image-api.photoroom.com/v2/edit', {
      method: 'POST',
      headers: {
        'x-api-key': process.env.PHOTOROOM_API_KEY,
        ...photoroomForm.getHeaders(),
      },
      body: photoroomForm,
    });

    if (!prRes.ok) {
      const errText = await prRes.text();
      console.error('[Photoroom] Erreur:', prRes.status, errText);
      return res.status(502).json({ error: 'Erreur Photoroom', detail: errText });
    }

    const photoroomBuffer = Buffer.from(await prRes.arrayBuffer());
    console.log('[Photoroom] OK — taille:', photoroomBuffer.length, 'octets');

    // ── 2. Gemini — localisation de la plaque sur l'image Photoroom ───────
    // On analyse l'image PHOTOROOM (pas l'originale) → coords directement
    // alignées avec le canvas final, zéro problème de recadrage.
    const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
    const model = genAI.getGenerativeModel({ model: 'gemini-2.5-flash' });

    const base64PR = photoroomBuffer.toString('base64');

    const prompt = `You are a license plate detector for automotive images.
Find the license plate in this image.
Return ONLY a valid JSON object with normalized coordinates (float 0-1, relative to image size):
{"license_plate": {"x_center": float, "y_center": float, "width": float, "height": float}}
If no plate is visible, return exactly: {"license_plate": null}
No explanation, no markdown.`;

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

    let plateCoords = null;
    try {
      const parsed = JSON.parse(geminiResult.response.text());
      plateCoords = parsed.license_plate;
      console.log('[Gemini] Plaque:', plateCoords);
    } catch (e) {
      console.warn('[Gemini] Parse error:', e.message);
    }

    // ── 3. Sharp — incrustation du bandeau AUTOEASY ───────────────────────
    let finalBuffer;

    if (plateCoords) {
      const { width: prW, height: prH } = await sharp(photoroomBuffer).metadata();

      // Coordonnées normalisées → pixels
      const pw = Math.round(plateCoords.width    * prW);
      const ph = Math.round(plateCoords.height   * prH);
      const px = Math.round(plateCoords.x_center * prW - pw / 2);
      const py = Math.round(plateCoords.y_center * prH - ph / 2);

      // Clamping dans les bounds de l'image
      const sx = Math.max(0, Math.min(px, prW - 1));
      const sy = Math.max(0, Math.min(py, prH - 1));
      const sw = Math.min(pw, prW - sx);
      const sh = Math.min(ph, prH - sy);

      console.log(`[Sharp] Bandeau -> x:${sx} y:${sy} w:${sw} h:${sh}`);

      const fontSize = Math.round(sh * 0.52);
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
      console.warn('[Sharp] Pas de plaque — image Photoroom renvoyee sans bandeau.');
      finalBuffer = await sharp(photoroomBuffer).jpeg({ quality: 92 }).toBuffer();
    }

    // ── 4. Réponse JSON avec base64 ───────────────────────────────────────
    return res.status(200).json({
      result:        'data:image/jpeg;base64,' + finalBuffer.toString('base64'),
      plateDetected: !!plateCoords,
    });

  } catch (err) {
    console.error('[partner-analyze] Erreur:', err);
    return res.status(500).json({ error: 'Erreur serveur', detail: err.message });
  }
}