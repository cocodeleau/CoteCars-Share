// api/partner-analyze.js
// Workflow :
//   1. Photoroom → PNG transparent + ombre de contact
//   2. Gemini    → coordonnées plaque sur CE PNG (coords parfaitement alignées)
//   3. Sharp     → Sandwich : fond showroom + PNG Photoroom + bandeau AUTOEASY
//
// Reçoit : POST JSON { image: "data:image/jpeg;base64,..." }
// Renvoie : JSON { success: true, result: "data:image/jpeg;base64,...", plateDetected: bool }
//        ou JSON { success: false, error: "..." }

import FormData from 'form-data';
import fetch from 'node-fetch';
import sharp from 'sharp';
import { GoogleGenerativeAI } from '@google/generative-ai';

// ── Génère le fond showroom en SVG (damier + mur dégradé) ────────
function createShowroomBackground(width, height) {
  const horizonY = Math.round(height * 0.58);
  const tile     = 52; // taille d'une case du damier

  const svg = `<svg width="${width}" height="${height}" xmlns="http://www.w3.org/2000/svg">
    <defs>
      <linearGradient id="wall" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0%"   stop-color="#ADADAD"/>
        <stop offset="100%" stop-color="#D4D4D4"/>
      </linearGradient>
      <pattern id="checker" width="${tile * 2}" height="${tile * 2}" patternUnits="userSpaceOnUse">
        <rect width="${tile}"  height="${tile}"  fill="#BEBEBE"/>
        <rect x="${tile}" y="${tile}" width="${tile}" height="${tile}" fill="#BEBEBE"/>
        <rect x="${tile}" width="${tile}"  height="${tile}"  fill="#D2D2D2"/>
        <rect y="${tile}" width="${tile}"  height="${tile}"  fill="#D2D2D2"/>
      </pattern>
    </defs>
    <!-- Mur -->
    <rect width="${width}" height="${horizonY}" fill="url(#wall)"/>
    <!-- Sol damier -->
    <rect y="${horizonY}" width="${width}" height="${height - horizonY}" fill="url(#checker)"/>
    <!-- Ligne d'horizon subtile -->
    <rect y="${horizonY - 1}" width="${width}" height="2" fill="rgba(0,0,0,0.08)"/>
  </svg>`;

  return Buffer.from(svg);
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
    // Pas de background.color → Photoroom retourne un PNG transparent.
    // L'ombre (shadow.mode ai.soft) est intégrée comme pixels semi-transparents
    // dans ce PNG → elle se fondera naturellement sur notre fond Sharp.
    const photoroomForm = new FormData();
    photoroomForm.append('imageFile', imageBuffer, {
      filename: 'car.jpg',
      contentType: mimeType,
    });
    photoroomForm.append('shadow.mode', 'ai.soft');
    photoroomForm.append('padding', '0.08');
    // NE PAS ajouter background.color → fond transparent

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
    console.log(`[Photoroom] OK — ${prW}x${prH} PNG transparent`);

    // ── 2. Gemini → détection plaque sur le PNG Photoroom ────────
    // Gemini analyse le PNG Photoroom (pas l'originale) → les coordonnées
    // correspondent exactement aux pixels du canvas final.
    const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
    const model = genAI.getGenerativeModel({ model: 'gemini-2.5-flash' });

    const base64PR = photoroomBuffer.toString('base64');
    const prompt   = `You are a license plate detector for automotive images.
Find the license plate in this image.
Return ONLY a valid JSON object with normalized coordinates (float 0-1, relative to image dimensions):
{"license_plate": {"x_center": float, "y_center": float, "width": float, "height": float}}
If no plate is visible, return exactly: {"license_plate": null}
No explanation, no markdown.`;

    const MAX_ATTEMPTS = 3;
    const BACKOFF_MS   = [0, 2000, 4000];

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

    if (!geminiSuccess) {
      console.warn('[Gemini] Toutes les tentatives ont échoué — bandeau ignoré.');
    }

    // ── 3. Sharp — Sandwich en 3 couches ─────────────────────────
    //   Couche 0 (base) : fond showroom damier (SVG → PNG)
    //   Couche 1        : PNG Photoroom (voiture + ombre transparente)
    //   Couche 2        : Bandeau AUTOEASY (si plaque détectée)

    // Couche 0 : fond showroom aux mêmes dimensions que le PNG Photoroom
    const showroomSvgBuf = createShowroomBackground(prW, prH);
    const showroomBuffer = await sharp(showroomSvgBuf).png().toBuffer();

    // Préparer les calques à composer
    const layers = [
      { input: photoroomBuffer }, // Couche 1 : voiture + ombre
    ];

    // Couche 2 : bandeau AUTOEASY (si coordonnées disponibles)
    if (plateCoords && geminiSuccess) {
      const pw = Math.round(plateCoords.width    * prW);
      const ph = Math.round(plateCoords.height   * prH);
      const px = Math.round(plateCoords.x_center * prW - pw / 2);
      const py = Math.round(plateCoords.y_center * prH - ph / 2);

      // Clamping dans les bounds
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

      layers.push({
        input: Buffer.from(bannerSvg),
        left: sx,
        top: sy,
      });
    }

    // Assemblage final : fond showroom + calques
    const finalBuffer = await sharp(showroomBuffer)
      .composite(layers)
      .jpeg({ quality: 92 })
      .toBuffer();

    console.log(`[Sharp] Image finale : ${finalBuffer.length} octets`);

    // ── 4. Réponse ────────────────────────────────────────────────
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