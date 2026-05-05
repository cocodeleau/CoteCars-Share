// api/partner-cloudinary.js
// Pipeline Cloudinary :
// 1. Upload photo voiture
// 2. Transformation : suppression fond + composition sur showroom AutoEasy
// 3. Retourne l'image finale en base64

const crypto = require("crypto");

function sign(params, secret) {
  const str = Object.keys(params).sort()
    .map(k => `${k}=${params[k]}`).join("&") + secret;
  return crypto.createHash("sha1").update(str).digest("hex");
}

module.exports = async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  const { imageBase64, mimeType } = req.body;
  if (!imageBase64) return res.status(400).json({ error: "Missing imageBase64" });

  const CLOUD  = process.env.CLOUDINARY_CLOUD_NAME;
  const KEY    = process.env.CLOUDINARY_API_KEY;
  const SECRET = process.env.CLOUDINARY_API_SECRET;

  try {
    const timestamp = Math.floor(Date.now() / 1000);

    // Transformation Cloudinary en une seule URL :
    // 1. Fond showroom autoeasy-bg en 1024x768
    // 2. Voiture par-dessus avec background removal + centrée sur le sol
    // 3. Ombre portée sous la voiture
    // 4. Cache plaque (texte AUTOEASY)
    const eager = [
      // Fond showroom
      `l_autoeasy-bg,w_1024,h_768,c_fill`,
      `fl_layer_apply`,
      // Voiture découpée centrée, posée sur le sol (~62% de hauteur)
      `l_fetch:${Buffer.from(`data:${mimeType||"image/jpeg"};base64,${imageBase64.slice(0,100)}`).toString("base64")}`,
    ].join("/");

    // Approche simplifiée : upload + transformation URL
    const uploadParams = {
      timestamp,
      eager: `e_background_removal/c_fit,w_820,h_500/e_shadow:40,x_4,y_12/l_autoeasy-bg,w_1024,h_768,c_fill,fl_layer_apply,fl_tiled/fl_layer_apply,g_south,y_80`,
      eager_async: "false",
      public_id: `autoeasy_studio/${timestamp}`,
    };

    const signature = sign(uploadParams, SECRET);

    const form = new FormData();
    form.append("file", `data:${mimeType || "image/jpeg"};base64,${imageBase64}`);
    form.append("api_key", KEY);
    form.append("timestamp", timestamp);
    form.append("public_id", uploadParams.public_id);
    form.append("eager", uploadParams.eager);
    form.append("eager_async", "false");
    form.append("signature", signature);

    console.log("Uploading to Cloudinary...");
    const uploadRes = await fetch(
      `https://api.cloudinary.com/v1_1/${CLOUD}/image/upload`,
      { method: "POST", body: form }
    );

    const uploadData = await uploadRes.json();
    console.log("Upload response:", JSON.stringify(uploadData).slice(0, 500));

    if (!uploadRes.ok || uploadData.error) {
      return res.status(200).json({ success: false, error: uploadData.error?.message || "Upload failed" });
    }

    // URL de transformation finale
    const publicId = uploadData.public_id;

    // Construire l'URL avec toutes les transformations
    // underlay = fond showroom, la voiture par-dessus avec bg removal
    const transformUrl = 
      `https://res.cloudinary.com/${CLOUD}/image/upload/` +
      `e_background_removal/` +          // 1. Supprimer fond voiture
      `c_fit,w_820,h_500/` +             // 2. Redimensionner voiture
      `e_shadow:50,x_5,y_15/` +          // 3. Ombre portée
      `u_autoeasy-bg,w_1024,h_768,c_fill/fl_layer_apply,g_center/` +  // 4. Fond showroom en underlay
      `fl_layer_apply,g_south,y_30/` +   // 5. Positionner voiture sur le sol
      `c_fill,w_1024,h_768,f_jpg,q_90/` + // 6. Format final
      `${publicId}`;

    console.log("Transform URL:", transformUrl);

    // Fetch l'image transformée
    const imgRes = await fetch(transformUrl);
    if (!imgRes.ok) {
      // Retourner l'URL directement si on ne peut pas fetch
      return res.status(200).json({ success: true, url: transformUrl, publicId });
    }

    const imgBuffer = await imgRes.arrayBuffer();
    const imgBase64 = Buffer.from(imgBuffer).toString("base64");

    return res.status(200).json({
      success: true,
      imageBase64: imgBase64,
      mimeType: "image/jpeg",
      url: transformUrl,
    });

  } catch (err) {
    console.error("partner-cloudinary error:", err.message);
    return res.status(200).json({ success: false, error: err.message });
  }
};
