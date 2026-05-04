// api/partner-image.js
// Détection de plaque d'immatriculation via Gemini Vision

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const { imageBase64, mimeType } = req.body;

  if (!imageBase64) {
    return res.status(400).json({ error: "Missing imageBase64" });
  }

  const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
  if (!GEMINI_API_KEY) {
    return res.status(500).json({ error: "GEMINI_API_KEY not configured" });
  }

  const prompt = `Tu es un expert en analyse d'images automobiles.

Analyse cette photo de véhicule et détecte la ou les plaques d'immatriculation.

Pour CHAQUE plaque trouvée, retourne ses coordonnées normalisées (valeurs entre 0 et 1 par rapport aux dimensions de l'image) :
- x : position horizontale du coin supérieur gauche
- y : position verticale du coin supérieur gauche  
- w : largeur de la plaque
- h : hauteur de la plaque

Réponds UNIQUEMENT avec un objet JSON valide, sans markdown, sans texte avant ou après :
{
  "plates": [
    { "x": 0.2, "y": 0.7, "w": 0.15, "h": 0.04, "text": "ET-088-NQ" }
  ],
  "count": 1
}

Si aucune plaque n'est visible, réponds : {"plates": [], "count": 0}`;

  try {
    const geminiRes = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${GEMINI_API_KEY}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          contents: [{
            parts: [
              {
                inline_data: {
                  mime_type: mimeType || "image/jpeg",
                  data: imageBase64,
                },
              },
              { text: prompt },
            ],
          }],
          generationConfig: {
            temperature: 0.1,
            maxOutputTokens: 512,
          },
        }),
      }
    );

    if (!geminiRes.ok) {
      const errText = await geminiRes.text();
      console.error("Gemini error:", errText);
      return res.status(500).json({ error: "Gemini API error", plateBox: null });
    }

    const geminiData = await geminiRes.json();
    const raw = geminiData.candidates?.[0]?.content?.parts?.[0]?.text || "";

    // Parse JSON from response
    const startIdx = raw.indexOf("{");
    const endIdx = raw.lastIndexOf("}");
    if (startIdx === -1 || endIdx === -1) {
      return res.status(200).json({ plateBox: null, plates: [], raw });
    }

    const parsed = JSON.parse(raw.slice(startIdx, endIdx + 1));
    const plates = parsed.plates || [];

    // Retourner la première plaque trouvée comme plateBox principal
    const plateBox = plates.length > 0 ? {
      x: plates[0].x,
      y: plates[0].y,
      w: plates[0].w,
      h: plates[0].h,
      text: plates[0].text || "",
    } : null;

    return res.status(200).json({
      plateBox,
      plates,
      count: parsed.count || plates.length,
    });

  } catch (err) {
    console.error("partner-image error:", err);
    // On retourne plateBox null - le frontend utilisera le fallback
    return res.status(200).json({ plateBox: null, plates: [], error: err.message });
  }
}
