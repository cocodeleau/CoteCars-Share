// api/partner-analyze.js
//
// Workflow :
//   1. Photoroom  → PNG transparent (voiture + ombre de contact)
//   2. Gemini     → coordonnées plaque normalisées (0-1) sur ce PNG
//   3. Sharp      → Sandwich sur canvas 1920×1080 :
//                     Couche 0 : fond showroom damier (généré en SVG)
//                     Couche 1 : voiture Photoroom redimensionnée et positionnée
//                     Couche 2 : bandeau AUTOEASY (coords Gemini × scale + offset voiture)
//
// Reçoit : POST JSON { image: "data:image/jpeg;base64,..." }
// Renvoie : JSON { success: true, result: "data:image/jpeg;base64,...", plateDetected: bool }
//        ou JSON { success: false, error: "..." }

import FormData from 'form-data';
import fetch    from 'node-fetch';
import sharp    from 'sharp';
import { GoogleGenerativeAI } from '@google/generative-ai';

// ── Dimensions du canvas final (showroom) ───────────────────────
const CANVAS_W    = 1920;
const CANVAS_H    = 1080;
const BOTTOM_PAD  = 30;  // marge entre la voiture et le bas du canvas

// ── Génère le fond showroom en SVG ──────────────────────────────
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
    // IMPORTANT : on n'envoie AUCUN paramètre background.* → Photoroom
    // retourne automatiquement un PNG avec canal alpha transparent.
    // L'ombre (shadow.mode=ai.soft) est rendue en pixels semi-transparents
    // directement dans ce PNG.
    const photoroomForm = new FormData();
    photoroomForm.append('imageFile', imageBuffer, {
      filename: 'car.jpg',
      contentType: mimeType,
    });
    photoroomForm.append('shadow.mode', 'ai.soft');
    photoroomForm.append('padding', '0.05');
    // Pas de background.color → fond transparent garanti

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

    // On force la conversion en PNG pour garantir le canal alpha,
    // quelle que soit la réponse brute de Photoroom.
    const rawPhotoroomBuffer = Buffer.from(await prRes.arrayBuffer());
    const photoroomBuffer    = await sharp(rawPhotoroomBuffer).png().toBuffer();

    const { width: prW, height: prH } = await sharp(photoroomBuffer).metadata();
    const prContentType = prRes.headers.get('content-type') || 'inconnu';
    console.log(`[Photoroom] OK — ${prW}x${prH} (content-type: ${prContentType})`);

    // ── 2. Gemini → détection plaque sur le PNG Photoroom ────────
    // Gemini analyse le PNG Photoroom (dimensions prW x prH).
    // Il retourne des coordonnées normalisées (0-1) relatives à ces dimensions.
    const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
    const model = genAI.getGenerativeModel({ model: 'gemini-2.5-flash' });
    const base64PR = photoroomBuffer.toString('base64');

    const prompt = `You are a license plate detector for automotive images.
Find the license plate in this image.
Return ONLY a valid JSON object with normalized coordinates (float 0-1, relative to image dimensions):
{"license_plate": {"x_center": float, "y_center": float, "width": float, "height": float}}
If no plate is visible, return exactly: {"license_plate": null}
No explanation, no markdown.`;

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

    // ── Couche 0 : fond showroom damier 1920×1080 ────────────────
    const showroomBuffer = await sharp(Buffer.from(buildShowroomSVG(CANVAS_W, CANVAS_H)))
      .png()
      .toBuffer();

    // ── Calcul du placement de la voiture sur le canvas ──────────
    // On scale la voiture pour qu'elle tienne dans 90%×92% du canvas.
    // On ne la scale jamais au-dessus de sa taille originale (scale ≤ 1).
    const maxCarW = Math.round(CANVAS_W * 0.90);
    const maxCarH = Math.round(CANVAS_H * 0.92);
    const scale   = Math.min(maxCarW / prW, maxCarH / prH, 1);

    const carW    = Math.round(prW * scale);
    const carH    = Math.round(prH * scale);
    const carLeft = Math.round((CANVAS_W - carW) / 2);         // centré horizontalement
    const carTop  = Math.max(0, CANVAS_H - carH - BOTTOM_PAD); // ancré en bas

    console.log(`[Sharp] Voiture redimensionnée: ${carW}x${carH} | position: left=${carLeft} top=${carTop} | scale=${scale.toFixed(3)}`);

    // Redimensionner le PNG Photoroom (transparent) aux dimensions calculées
    const resizedCarBuffer = await sharp(photoroomBuffer)
      .resize(carW, carH, { fit: 'fill' })
      .png()
      .toBuffer();

    // ── Couche 1 : voiture positionnée sur le canvas ──────────────
    const layers = [
      { input: resizedCarBuffer, left: carLeft, top: carTop },
    ];

    // ── Couche 2 : bandeau AUTOEASY ───────────────────────────────
    // Transformation des coordonnées Gemini (normalisées sur prW×prH)
    // vers le canvas final (1920×1080) :
    //
    //   coordGemini (0-1) × dimensionPhotoroom × scale  → pixels dans la voiture redimensionnée
    //   + offset (carLeft / carTop)                     → pixels dans le canvas final
    //
    if (plateCoords && geminiSuccess) {
      // Taille de la plaque dans le canvas final
      const pw = Math.round(plateCoords.width  * prW * scale);
      const ph = Math.round(plateCoords.height * prH * scale);

      // Coin supérieur-gauche de la plaque dans le canvas final
      const px = Math.round(carLeft + plateCoords.x_center * prW * scale - pw / 2);
      const py = Math.round(carTop  + plateCoords.y_center * prH * scale - ph / 2);

      // Clamping pour rester dans le canvas
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
      console.warn('[Sharp] Plaque non détectée — bandeau ignoré.');
    }

    // ── Assemblage final ──────────────────────────────────────────
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