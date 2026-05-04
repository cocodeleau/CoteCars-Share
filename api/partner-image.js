// api/partner-image.js
// Détection plaque uniquement via Gemini Vision
// (remove.bg est appelé directement depuis le frontend)

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const { imageBase64, mimeType } = req.body;
  if (!imageBase64) return res.status(400).json({ error: "Missing imageBase64" });

  const GEMINI_KEY = process.env.GEMINI_API_KEY;

  try {
    const prompt = `Analyse cette photo de véhicule et détecte la ou les plaques d'immatriculation.
Pour chaque plaque, retourne ses coordonnées normalisées (0 à 1) par rapport aux dimensions de l'image.
Réponds UNIQUEMENT avec un JSON valide, sans markdown :
{"plates":[{"x":0.2,"y":0.7,"w":0.15,"h":0.04,"text":"AB-123-CD"}],"count":1}
Si aucune plaque visible : {"plates":[],"count":0}`;

    const geminiRes = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${GEMINI_KEY}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          contents: [{ parts: [
            { inline_data: { mime_type: mimeType || "image/jpeg", data: imageBase64 } },
            { text: prompt }
          ]}],
          generationConfig: { temperature: 0.1, maxOutputTokens: 256 },
        }),
      }
    );

    if (!geminiRes.ok) {
      return res.status(200).json({ plateBox: null, plates: [], error: "Gemini error" });
    }

    const data = await geminiRes.json();
    const raw = data.candidates?.[0]?.content?.parts?.[0]?.text || "";
    const s = raw.indexOf("{"), e = raw.lastIndexOf("}");
    if (s === -1 || e === -1) return res.status(200).json({ plateBox: null, plates: [] });

    const parsed = JSON.parse(raw.slice(s, e + 1));
    const plates = parsed.plates || [];

    return res.status(200).json({
      plateBox: plates[0] || null,
      plates,
      plateDetected: plates.length > 0,
    });

  } catch (err) {
    console.error("partner-image error:", err.message);
    return res.status(200).json({ plateBox: null, plates: [], error: err.message });
  }
}