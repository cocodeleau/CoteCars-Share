// api/partner-image.js
// Gemini Vision : détection plaque + positionnement optimal de la voiture
// Le fond showroom AutoEasy est une image fixe (autoeasy-bg.jpg)
// Gemini analyse la photo voiture pour :
// 1. Localiser la plaque d'immatriculation
// 2. Calculer le bon positionnement dans le fond showroom

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const { imageBase64, mimeType } = req.body;
  if (!imageBase64) return res.status(400).json({ error: "Missing imageBase64" });

  const GEMINI_KEY = process.env.GEMINI_API_KEY;

  try {
    const prompt = `Tu analyses une photo de véhicule automobile pour un montage professionnel.

Le fond de destination est un showroom avec ces caractéristiques :
- Sol damier vert/noir brillant qui commence à environ 58% de la hauteur de l'image
- Mur végétal à gauche
- Enseigne AUTOEASY lumineuse au centre-droite
- Dimensions du canvas final : 1024x768 pixels

Analyse la photo et retourne UNIQUEMENT un JSON valide avec :

1. "plates" : tableau des plaques détectées avec coordonnées normalisées (0 à 1) par rapport à l'image originale
2. "carPlacement" : comment positionner la voiture dans le fond showroom :
   - "solRatio" : à quelle hauteur (0 à 1) les roues doivent toucher le sol du showroom (généralement entre 0.55 et 0.65)
   - "scaleRatio" : quelle proportion de la largeur du canvas la voiture doit occuper (entre 0.65 et 0.80)
   - "offsetXRatio" : décalage horizontal depuis le centre (entre -0.05 et 0.05, positif = droite)
3. "carAngle" : angle de prise de vue ("front", "rear", "side", "three_quarter_front", "three_quarter_rear")

Exemple de réponse :
{
  "plates": [{"x": 0.35, "y": 0.72, "w": 0.18, "h": 0.055, "text": "ET-088-NQ", "position": "front"}],
  "carPlacement": {"solRatio": 0.60, "scaleRatio": 0.72, "offsetXRatio": 0.02},
  "carAngle": "three_quarter_front"
}

Si aucune plaque visible : "plates": []
Réponds UNIQUEMENT avec le JSON, sans markdown, sans texte.`;

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
      return res.status(200).json({
        plateBox: null,
        plates: [],
        carPlacement: { solRatio: 0.60, scaleRatio: 0.72, offsetXRatio: 0.02 },
        error: "Gemini error"
      });
    }

    const data = await geminiRes.json();
    const raw = data.candidates?.[0]?.content?.parts?.[0]?.text || "";

    const s = raw.indexOf("{");
    const e = raw.lastIndexOf("}");

    if (s === -1 || e === -1) {
      return res.status(200).json({
        plateBox: null,
        plates: [],
        carPlacement: { solRatio: 0.60, scaleRatio: 0.72, offsetXRatio: 0.02 },
      });
    }

    const parsed = JSON.parse(raw.slice(s, e + 1));
    const plates = parsed.plates || [];

    // Valider et borner les valeurs de placement
    const placement = parsed.carPlacement || {};
    const carPlacement = {
      solRatio: Math.min(0.70, Math.max(0.50, placement.solRatio || 0.60)),
      scaleRatio: Math.min(0.82, Math.max(0.60, placement.scaleRatio || 0.72)),
      offsetXRatio: Math.min(0.08, Math.max(-0.08, placement.offsetXRatio || 0.02)),
    };

    return res.status(200).json({
      plateBox: plates[0] || null,
      plates,
      plateDetected: plates.length > 0,
      carPlacement,
      carAngle: parsed.carAngle || "three_quarter_front",
    });

  } catch (err) {
    console.error("partner-image error:", err.message);
    return res.status(200).json({
      plateBox: null,
      plates: [],
      carPlacement: { solRatio: 0.60, scaleRatio: 0.72, offsetXRatio: 0.02 },
      error: err.message
    });
  }
}