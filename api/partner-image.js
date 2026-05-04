// api/partner-image.js
// Pipeline complet : remove.bg (suppression fond) + Gemini Vision (détection plaque)

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const { imageBase64, mimeType } = req.body;
  if (!imageBase64) return res.status(400).json({ error: "Missing imageBase64" });

  const REMOVE_BG_KEY = process.env.REMOVE_BG_API_KEY;
  const GEMINI_KEY    = process.env.GEMINI_API_KEY;

  const results = {};

  // ── 1. Suppression de fond via remove.bg ──────────────────────
  try {
    const imageBuffer = Buffer.from(imageBase64, "base64");

    const { FormData: NodeFormData, Blob: NodeBlob } = await import("node:buffer").catch(() => ({}));

    // Utiliser undici FormData ou native
    const fd = new FormData();
    const imgBlob = new Blob([imageBuffer], { type: mimeType || "image/jpeg" });
    fd.append("image_file", imgBlob, "photo.jpg");
    fd.append("size", "auto");
    fd.append("type", "car");

    const removeBgRes = await fetch("https://api.remove.bg/v1.0/removebg", {
      method: "POST",
      headers: { "X-Api-Key": REMOVE_BG_KEY },
      body: fd,
    });

    if (removeBgRes.ok) {
      const pngBuffer = await removeBgRes.arrayBuffer();
      results.removedBgBase64 = Buffer.from(pngBuffer).toString("base64");
      results.removeBgSuccess = true;
    } else {
      const errText = await removeBgRes.text();
      console.error("remove.bg error:", removeBgRes.status, errText);
      results.removeBgSuccess = false;
      results.removeBgError = errText;
    }
  } catch (err) {
    console.error("remove.bg exception:", err.message);
    results.removeBgSuccess = false;
    results.removeBgError = err.message;
  }

  // ── 2. Détection plaque via Gemini Vision ─────────────────────
  try {
    const prompt = `Analyse cette photo de véhicule et détecte la ou les plaques d'immatriculation.
Pour chaque plaque, retourne ses coordonnées normalisées (0 à 1) par rapport aux dimensions de l'image.
Réponds UNIQUEMENT avec un JSON valide, sans markdown :
{"plates":[{"x":0.2,"y":0.7,"w":0.15,"h":0.04,"text":"AB-123-CD"}],"count":1}
Si aucune plaque : {"plates":[],"count":0}`;

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

    if (geminiRes.ok) {
      const data = await geminiRes.json();
      const raw = data.candidates?.[0]?.content?.parts?.[0]?.text || "";
      const s = raw.indexOf("{"), e = raw.lastIndexOf("}");
      if (s !== -1 && e !== -1) {
        const parsed = JSON.parse(raw.slice(s, e + 1));
        const plates = parsed.plates || [];
        results.plateBox = plates[0] || null;
        results.plates = plates;
        results.plateDetected = plates.length > 0;
      }
    }
  } catch (err) {
    console.error("Gemini error:", err.message);
    results.plateBox = null;
    results.plateDetected = false;
  }

  return res.status(200).json(results);
}