// api/partner-analyze.js
// Analyse Gemini Vision : détection car_box + license_plate
// Payload léger - seulement l'analyse, pas de génération d'image

module.exports = async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  const { imageBase64, mimeType } = req.body;
  if (!imageBase64) return res.status(400).json({ error: "Missing imageBase64" });

  const GEMINI_KEY = process.env.GEMINI_API_KEY;

  const prompt = `Analyse cette photo de voiture et retourne UNIQUEMENT un JSON valide. Ne génère aucun texte avant ou après, pas de balises markdown. Je veux les coordonnées en pourcentages (de 0.0 à 1.0) par rapport à la taille de l'image. Structure attendue : { "car_box": { "x_center": float, "y_center": float, "width": float, "height": float }, "license_plate": { "x_center": float, "y_center": float, "width": float, "height": float } }`;

  try {
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
          generationConfig: { temperature: 0.1, maxOutputTokens: 512 },
        }),
      }
    );

    if (!geminiRes.ok) {
      const err = await geminiRes.text();
      console.error("Gemini error:", geminiRes.status, err);
      return res.status(200).json({ success: false, error: err });
    }

    const data = await geminiRes.json();
    const raw = data.candidates?.[0]?.content?.parts?.[0]?.text || "";
    console.log("Gemini raw:", raw.slice(0, 300));

    const s = raw.indexOf("{"), e = raw.lastIndexOf("}");
    if (s === -1 || e === -1) {
      return res.status(200).json({ success: false, error: "No JSON in response", raw });
    }

    const parsed = JSON.parse(raw.slice(s, e + 1));
    return res.status(200).json({ success: true, ...parsed });

  } catch (err) {
    console.error("partner-analyze error:", err.message);
    return res.status(200).json({ success: false, error: err.message });
  }
};
