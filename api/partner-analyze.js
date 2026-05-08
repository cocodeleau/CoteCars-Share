// api/partner-analyze.js
//
// Workflow IC-Light :
//   1. Photoroom  → PNG transparent de la voiture (détourage)
//   2. IC-Light   → zsxkib/ic-light-background
//                   Entrées : voiture PNG + fond showroom Cloudinary
//                   Sortie  : voiture placée sur le showroom avec éclairage et ombres cohérents
//                   (pas de masque, pas de sandwich — le modèle gère la physique lumineuse)
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

const SHOWROOM_URL  = 'https://res.cloudinary.com/di3xa7ldg/image/upload/autoeasy-bg_tdjz2c.jpg';
const IC_LIGHT_MODEL = 'zsxkib/ic-light-background';
const MAX_WAIT_MS   = 55000;

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

    // ── 1. Photoroom → PNG transparent (détourage voiture) ───────
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

    const carPngBuffer = Buffer.from(await prRes.arrayBuffer());
    console.log(`[Photoroom] Détourage OK — ${carPngBuffer.length} octets`);

    // IC-Light attend une image sans canal alpha (il gère le détourage en interne via BriaRMBG)
    // On convertit le PNG transparent en JPEG avec fond blanc neutre
    const carJpegBuffer = await sharp(carPngBuffer)
      .flatten({ background: { r: 255, g: 255, b: 255 } })
      .jpeg({ quality: 95 })
      .toBuffer();

    const carB64  = 'data:image/jpeg;base64,' + carJpegBuffer.toString('base64');

    // ── 2. IC-Light Background → voiture sur showroom avec ombres ─
    // Le modèle calcule la physique lumineuse : comment la lumière du showroom
    // frappe la carrosserie et projette les ombres de contact sur le damier.
    const replicate = new Replicate({ auth: process.env.REPLICATE_API_TOKEN });
    console.log('[IC-Light] Lancement du relighting...');

    const icLightOutput = await Promise.race([
      replicate.run(IC_LIGHT_MODEL, {
        input: {
          image:            carB64,           // voiture détourée (JPEG blanc)
          background_image: SHOWROOM_URL,     // fond showroom Cloudinary (URL directe)
          prompt:           'a luxury car in a showroom, photorealistic, cinematic lighting, 8k',
          num_steps:        25,
          cfg:              2.0,              // guidage prompt (faible = plus fidèle au fond)
          highres_denoise:  0.5,
          lowres_denoise:   0.9,
          number_of_images: 1,
        },
      }),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error(`IC-Light timeout après ${MAX_WAIT_MS / 1000}s`)), MAX_WAIT_MS)
      ),
    ]);

    // IC-Light renvoie un tableau d'URLs ou un objet avec les images relit
    const outputUrl = Array.isArray(icLightOutput)
      ? icLightOutput[0]
      : (icLightOutput?.relit_image || icLightOutput?.output?.[0] || icLightOutput);

    if (!outputUrl) throw new Error('IC-Light : aucune URL de sortie.');
    console.log(`[IC-Light] Output : ${outputUrl}`);

    const icImgRes = await fetch(String(outputUrl));
    if (!icImgRes.ok) throw new Error('Impossible de télécharger le résultat IC-Light.');

    const fusedBuffer = Buffer.from(await icImgRes.arrayBuffer());
    const { width: imgW, height: imgH } = await sharp(fusedBuffer).metadata();
    console.log(`[IC-Light] Image finale : ${imgW}x${imgH}`);

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
//   1. Photoroom  → PNG transparent voiture (carResized)
//   2. Replicate  → FLUX-Fill génère les ombres de contact dans la zone sol
//   3. Sharp      → Sandwich 3 couches :
//                     Base   : showroom Cloudinary original (bgResized)
//                     Milieu : zone d'ombres FLUX extraite, blend 'multiply' → ombres naturelles
//                     Top    : voiture Photoroom intacte par-dessus
//   4. Gemini     → coordonnées plaque pixels absolus
//   5. Sharp      → bandeau AUTOEASY
//
// ⚠️  vercel.json → { "functions": { "api/partner-analyze.js": { "maxDuration": 60 } } }
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
const REPLICATE_MODEL = 'black-forest-labs/flux-fill-pro';
const INPAINT_SIZE    = 1024;
const SHADOW_START_Y  = Math.round(INPAINT_SIZE * 0.72); // zone sol = bottom 28%
const MAX_WAIT_MS     = 55000;

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

    // ── 1. Photoroom → PNG transparent (détourage voiture) ───────
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

    // ── 2. Préparation des calques Sharp ─────────────────────────

    // Fond showroom Cloudinary — couche de base finale (100% préservée)
    const bgRes = await fetch(SHOWROOM_URL);
    if (!bgRes.ok) return res.status(200).json({ success: false, error: 'Fond showroom introuvable.' });

    const bgResized = await sharp(Buffer.from(await bgRes.arrayBuffer()))
      .resize(INPAINT_SIZE, INPAINT_SIZE, { fit: 'cover' })
      .jpeg({ quality: 95 })
      .toBuffer();

    // Voiture redimensionnée (PNG transparent) — couche du dessus finale
    const carResized = await sharp(carPngRaw)
      .resize(INPAINT_SIZE, INPAINT_SIZE, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
      .png()
      .toBuffer();

    // Image d'init pour FLUX : fond + voiture (FLUX voit la voiture → ombres bien placées)
    const initImageBuffer = await sharp(bgResized)
      .composite([{ input: carResized }])
      .jpeg({ quality: 95 })
      .toBuffer();
    const initB64 = 'data:image/jpeg;base64,' + initImageBuffer.toString('base64');

    // ── 3. Masque précis pixel par pixel ─────────────────────────
    // • Blanc : zone sol (bottom 28%) SANS la carrosserie → FLUX peint ici les ombres
    // • Noir  : carrosserie + tout le reste du fond → protégés
    const alphaRaw   = await sharp(carResized).extractChannel('alpha').raw().toBuffer();
    const maskPixels = Buffer.alloc(INPAINT_SIZE * INPAINT_SIZE);

    for (let y = 0; y < INPAINT_SIZE; y++) {
      for (let x = 0; x < INPAINT_SIZE; x++) {
        const i = y * INPAINT_SIZE + x;
        maskPixels[i] = (alphaRaw[i] <= 30 && y >= SHADOW_START_Y) ? 255 : 0;
      }
    }

    const maskBuffer = await sharp(maskPixels, {
      raw: { width: INPAINT_SIZE, height: INPAINT_SIZE, channels: 1 },
    }).blur(6).png().toBuffer();

    const maskB64 = 'data:image/png;base64,' + maskBuffer.toString('base64');

    // ── 4. Replicate FLUX-Fill — génération des ombres ───────────
    const replicate = new Replicate({ auth: process.env.REPLICATE_API_TOKEN });
    console.log('[Replicate] Génération des ombres FLUX...');

    const replicateOutput = await Promise.race([
      replicate.run(REPLICATE_MODEL, {
        input: {
          // FLUX voit fond + voiture → il place les ombres sous les roues réelles
          image:            initB64,
          mask:             maskB64,
          prompt:           'Realistic contact shadows and ambient occlusion under car tires on a shiny checkerboard floor, cinematic studio lighting, 8k resolution.',
          guidance:         20,
          steps:            40,
          output_format:    'jpg',
          safety_tolerance: 2,
        },
      }),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error(`Replicate timeout après ${MAX_WAIT_MS / 1000}s`)), MAX_WAIT_MS)
      ),
    ]);

    const outputUrl = Array.isArray(replicateOutput) ? replicateOutput[0] : replicateOutput;
    if (!outputUrl) throw new Error('Replicate : aucune URL de sortie.');
    console.log(`[Replicate] Output : ${outputUrl}`);

    const fluxImgRes = await fetch(String(outputUrl));
    if (!fluxImgRes.ok) throw new Error('Impossible de télécharger le résultat FLUX.');
    const fluxBuffer = Buffer.from(await fluxImgRes.arrayBuffer());

    // ── 5. Sandwich Sharp — 3 couches ────────────────────────────
    //
    // LOGIQUE :
    //   Couche BASE   : bgResized (showroom Cloudinary, 100% intact)
    //   Couche MILIEU : zone d'ombres FLUX (bottom 28%) en blend 'multiply'
    //                   → multiply assombrit le showroom là où FLUX a créé des ombres
    //                   → zones claires du showroom non affectées
    //   Couche TOP    : carResized (voiture Photoroom, 100% contractuelle)
    //
    // Le mode 'multiply' : résultat = (fond × ombre) / 255
    //   - Pixel d'ombre sombre (ex: 50) × fond (200) / 255 ≈ 39  → zone assombrie = ombre réaliste
    //   - Pixel FLUX clair (ex: 240) × fond (200) / 255 ≈ 188    → presque inchangé

    const shadowZoneH = INPAINT_SIZE - SHADOW_START_Y;

    // Extraire UNIQUEMENT la zone d'ombres du résultat FLUX
    const fluxShadowZone = await sharp(fluxBuffer)
      .extract({
        left:   0,
        top:    SHADOW_START_Y,
        width:  INPAINT_SIZE,
        height: shadowZoneH,
      })
      .png()
      .toBuffer();

    // Sandwich final
    const fusedBuffer = await sharp(bgResized)
      .composite([
        // Milieu : ombres FLUX en multiply → assombrit naturellement le showroom
        {
          input:   fluxShadowZone,
          top:     SHADOW_START_Y,
          left:    0,
          blend:   'multiply',
        },
        // Top : voiture Photoroom intacte, carrosserie contractuelle
        {
          input:   carResized,
          top:     0,
          left:    0,
        },
      ])
      .jpeg({ quality: 92 })
      .toBuffer();

    const { width: imgW, height: imgH } = await sharp(fusedBuffer).metadata();
    console.log(`[Sharp] Sandwich OK — ${imgW}x${imgH}`);

    // ── 6. Gemini → pixels absolus de la plaque ──────────────────
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

    // ── 7. Sharp → bandeau AUTOEASY ──────────────────────────────
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