// api/partner-gemini-compose.js
// Gemini 2.0 Flash image generation
// Reçoit : photo véhicule + fond showroom (depuis le frontend)

const PROMPT = `Tu reçois deux images en entrée.
Image 1 : Le fond (un showroom AutoEasy avec un sol damier).
Image 2 : La photo d'un véhicule à détourer.
Ta tâche est de générer une image finale composite en respectant STRICTEMENT les consignes suivantes :
1. Intégration : Place le véhicule de l'image 2 sur le sol damier du showroom de l'image 1.
2. Conservation absolue : Le véhicule de l'image 2 (couleur, carrosserie, reflets, style) et le fond de l'image 1 doivent rester EXACTEMENT tels quels. N applique aucun filtre, aucune modification de texture ou de couleur.
3. Anonymisation de la plaque : Masque intégralement la plaque d immatriculation du véhicule avec un rectangle noir opaque. Sur ce rectangle noir, inscris le texte AUTOEASY en majuscules blanches, centré et aligné avec la perspective de la plaque.
4. Ombrage : Ajoute uniquement une ombre portée naturelle de contact sous les pneus et le châssis du véhicule pour l ancrer de façon réaliste sur le sol damier.`;

module.exports = async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  const { imageBase64, bgBase64, mimeType } = req.body;
  if (!imageBase64) return res.status(400).json({ error: "Missing imageBase64" });
  if (!bgBase64) return res.status(400).json({ error: "Missing bgBase64" });

  const GEMINI_KEY = process.env.GEMINI_API_KEY;

  try {
    const geminiRes = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash-preview-image-generation:generateContent?key=${GEMINI_KEY}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          contents: [{
            parts: [
              { inline_data: { mime_type: "image/jpeg", data: bgBase64 } },
              { text: "Image 1 : Le fond showroom AutoEasy." },
              { inline_data: { mime_type: mimeType || "image/jpeg", data: imageBase64 } },
              { text: "Image 2 : Le véhicule à intégrer." },
              { text: PROMPT },
            ]
          }],
          generationConfig: {
            responseModalities: ["image", "text"],
            temperature: 0.1,
          },
        }),
      }
    );

    if (!geminiRes.ok) {
      const err = await geminiRes.text();
      console.error("Gemini 2.0 error:", geminiRes.status, err);
      return res.status(200).json({ success: false, error: err });
    }

    const data = await geminiRes.json();
    const parts = data?.candidates?.[0]?.content?.parts || [];
    const imagePart = parts.find(p => p.inline_data?.mime_type?.startsWith("image/"));

    if (!imagePart) {
      const textPart = parts.find(p => p.text);
      console.error("No image:", textPart?.text?.slice(0, 300));
      return res.status(200).json({ success: false, error: "No image generated", text: textPart?.text });
    }

    return res.status(200).json({
      success: true,
      imageBase64: imagePart.inline_data.data,
      mimeType: imagePart.inline_data.mime_type,
    });

  } catch (err) {
    console.error("Error:", err.message);
    return res.status(200).json({ success: false, error: err.message });
  }
};