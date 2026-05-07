// api/partner-analyze.js
//
// Workflow :
//   1. Photoroom  → PNG transparent forcé (format=png) + ombre de contact
//   2. Gemini     → coordonnées plaque en PIXELS ABSOLUS (x, y, width, height)
//   3. Sharp      → Sandwich sur canvas 1920×1080 :
//                     Couche 0 : fond showroom damier (SVG)
//                     Couche 1 : voiture Photoroom redimensionnée et positionnée
//                     Couche 2 : bandeau AUTOEASY (pixels Gemini × scale + offset)
//
// Reçoit : POST JSON { image: "data:image/jpeg;base64,..." }
// Renvoie : JSON { success: true, result: "data:image/jpeg;base64,...", plateDetected: bool }
//        ou JSON { success: false, error: "..." }

import FormData from 'form-data';
import fetch    from 'node-fetch';
import sharp    from 'sharp';
import { GoogleGenerativeAI } from '@google/generative-ai';

const CANVAS_W   = 1920;
const CANVAS_H   = 1080;
const BOTTOM_PAD = 30;

function buildShowroomSVG(w, h) {
  const horizonY = Math.round(h * 0.56);
  const tile     = 54;
  return `<svg width="${w}" height="${h}" xmlns="http://www.w3.org/2000/svg">
    <defs>
      <linearGradient id="wall" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0%"   stop-color="#AAAAAA"/>
        <stop offset="100%" stop-color="#CECECE"/>
      </linearGradient>
      <pattern id="checker" width="${tile * 2}" height="${tile * 2}" patternUnits="userSpaceOnUse">
        <rect width="${tile}"  height="${tile}"  fill="#B8B8B8"/>
        <rect x="${tile}" y="${tile}" width="${tile}" height="${tile}" fill="#B8B8B8"/>
        <rect x="${tile}" width="${tile}"  height="${tile}"  fill="#D0D0D0"/>
        <rect y="${tile}" width="${tile}"  height="${tile}"  fill="#D0D0D0"/>
      </pattern>
    </defs>
    <rect width="${w}" height="${horizonY}" fill="url(#wall)"/>
    <rect y="${horizonY}" width="${w}" height="${h - horizonY}" fill="url(#checker)"/>
    <rect y="${horizonY - 1}" width="${w}" height="2" fill="rgba(0,0,0,0.10)"/>
  </svg>`;
}

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

    // ── 1. Photoroom → PNG transparent + ombre de contact ────────
    // CORRECTION : 'format=png' force Photoroom à retourner un vrai PNG
    // avec canal alpha. Sans ça, Photoroom renvoie du JPEG blanc par défaut.
    const photoroomForm = new FormData();
    photoroomForm.append('imageFile', imageBuffer, {
      filename: 'car.jpg',
      contentType: mimeType,
    });
    photoroomForm.append('format', 'png');       // ← OBLIGATOIRE pour la transparence
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

    const photoroomBuffer = Buffer.from(await prRes.arrayBuffer());
    const { width: prW, height: prH } = await sharp(photoroomBuffer).metadata();
    console.log(`[Photoroom] OK — ${prW}x${prH} | content-type: ${prRes.headers.get('content-type')}`);

    // ── 2. Gemini → plaque en PIXELS ABSOLUS ─────────────────────
    // CORRECTION : on donne les dimensions réelles à Gemini et on lui demande
    // des entiers (x, y, width, height) plutôt que des flottants normalisés.
    // Gemini est bien plus précis avec des pixels qu'avec des ratios 0-1.
    const genAI    = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
    const model    = genAI.getGenerativeModel({ model: 'gemini-2.5-flash' });
    const base64PR = photoroomBuffer.toString('base64');

    const prompt = `The image size is ${prW} pixels wide and ${prH} pixels high. Find the license plate. Return ONLY a valid JSON object with absolute pixel coordinates (integers): {"license_plate": {"x": int, "y": int, "width": int, "height": int}} where x and y are the top-left corner of the plate. If no plate is visible, return exactly: {"license_plate": null} No explanation, no markdown.`;

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
              { inlineData: { mimeType: 'image/png', data: base64PR } },
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

    // ── 3. Sharp — Sandwich 3 couches ────────────────────────────

    // Couche 0 : fond showroom 1920×1080
    const showroomBuffer = await sharp(Buffer.from(buildShowroomSVG(CANVAS_W, CANVAS_H)))
      .png()
      .toBuffer();

    // Calcul du placement de la voiture
    const scale   = Math.min(CANVAS_W * 0.90 / prW, CANVAS_H * 0.92 / prH, 1);
    const carW    = Math.round(prW * scale);
    const carH    = Math.round(prH * scale);
    const carLeft = Math.round((CANVAS_W - carW) / 2);
    const carTop  = Math.max(0, CANVAS_H - carH - BOTTOM_PAD);

    console.log(`[Sharp] Voiture: ${carW}x${carH} | left=${carLeft} top=${carTop} | scale=${scale.toFixed(3)}`);

    // Couche 1 : voiture redimensionnée (PNG transparent → l'ombre se fond sur le damier)
    const resizedCarBuffer = await sharp(photoroomBuffer)
      .resize(carW, carH, { fit: 'fill' })
      .png()
      .toBuffer();

    const layers = [
      { input: resizedCarBuffer, left: carLeft, top: carTop },
    ];

    // Couche 2 : bandeau AUTOEASY
    // CORRECTION : Gemini donne maintenant des pixels absolus sur le PNG Photoroom.
    // La transformation est simple :
    //   pixel_canvas = offset_voiture + pixel_photoroom × scale
    if (plateCoords && geminiSuccess) {
      const px = Math.round(carLeft + plateCoords.x     * scale);
      const py = Math.round(carTop  + plateCoords.y     * scale);
      const pw = Math.round(plateCoords.width            * scale);
      const ph = Math.round(plateCoords.height           * scale);

      // Clamping dans les bounds du canvas
      const sx = Math.max(0, Math.min(px, CANVAS_W - 1));
      const sy = Math.max(0, Math.min(py, CANVAS_H - 1));
      const sw = Math.min(pw, CANVAS_W - sx);
      const sh = Math.min(ph, CANVAS_H - sy);

      console.log(`[Sharp] Bandeau → x:${sx} y:${sy} w:${sw} h:${sh}`);

      const fontSize  = Math.round(sh * 0.52);
      const bannerSvg = `<svg width="${sw}" height="${sh}" xmlns="http://www.w3.org/2000/svg">
  <rect width="${sw}" height="${sh}" fill="#111111" rx="3"/>
  <text x="50%" y="52%"
    dominant-baseline="middle" text-anchor="middle"
    fill="#FFFFFF" font-family="Arial Black, Arial, sans-serif"
    font-weight="900" font-size="${fontSize}" letter-spacing="1">AUTOEASY</text>
</svg>`;

      layers.push({ input: Buffer.from(bannerSvg), left: sx, top: sy });
    } else {
      console.warn('[Sharp] Plaque non détectée ou Gemini KO — bandeau ignoré.');
    }

    // Assemblage final
    const finalBuffer = await sharp(showroomBuffer)
      .composite(layers)
      .jpeg({ quality: 92 })
      .toBuffer();

    console.log(`[Sharp] Image finale : ${CANVAS_W}x${CANVAS_H} — ${finalBuffer.length} octets`);

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