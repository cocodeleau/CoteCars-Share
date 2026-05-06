// api/partner-analyze.js
// Analyse Gemini Vision : détection car_box + license_plate
// Retry avec Exponential Backoff sur 503/429

const GEMINI_URL = "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent";
const MAX_RETRIES = 3;
const BASE_DELAY_MS = 2000; // 2s, 4s, 8s

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

async function callGemini(imageBase64, mimeType, apiKey) {
  const prompt = `Analyse cette photo de voiture et retourne UNIQUEMENT un JSON valide. Ne génère aucun texte avant ou après, pas de balises markdown. Je veux les coordonnées en pourcentages (de 0.0 à 1.0) par rapport à la taille de l'image. Structure attendue : { "car_box": { "x_center": float, "y_center": float, "width": float, "height": float }, "license_plate": { "x_center": float, "y_center": float, "width": float, "height": float } }`;

  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    if (attempt > 0) {
      const delay = BASE_DELAY_MS * Math.pow(2, attempt - 1); // 2s, 4s
      console.log(`Retry ${attempt}/${MAX_RETRIES - 1} — waiting ${delay}ms...`);
      await sleep(delay);
    }

    const res = await fetch(`${GEMINI_URL}?key=${apiKey}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [{ parts: [
          { inline_data: { mime_type: mimeType || "image/jpeg", data: imageBase64 } },
          { text: prompt }
        ]}],
        generationConfig: { temperature: 0.1, maxOutputTokens: 512 },
      }),
    });

    if (res.ok) {
      const data = await res.json();
      const raw = data.candidates?.[0]?.content?.parts?.[0]?.text || "";
      console.log(`Gemini OK (attempt ${attempt + 1}):`, raw.slice(0, 200));
      const s = raw.indexOf("{"), e = raw.lastIndexOf("}");
      if (s !== -1 && e !== -1) {
        return { success: true, parsed: JSON.parse(raw.slice(s, e + 1)) };
      }
      return { success: false, error: "No JSON in response" };
    }

    // 503 surcharge ou 429 quota -> retry
    if (res.status === 503 || res.status === 429) {
      const errText = await res.text();
      console.warn(`Gemini ${res.status} (attempt ${attempt + 1}):`, errText.slice(0, 200));
      if (attempt === MAX_RETRIES - 1) {
        return { success: false, error: `Gemini ${res.status} après ${MAX_RETRIES} tentatives` };
      }
      continue;
    }

    // Autre erreur -> pas de retry
    const errText = await res.text();
    console.error(`Gemini ${res.status}:`, errText.slice(0, 300));
    return { success: false, error: `Gemini ${res.status}: ${errText.slice(0, 200)}` };
  }

  return { success: false, error: "Max retries reached" };
}

module.exports = async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  const { imageBase64, mimeType } = req.body;
  if (!imageBase64) return res.status(400).json({ error: "Missing imageBase64" });

  const GEMINI_KEY = process.env.GEMINI_API_KEY;

  try {
    const result = await callGemini(imageBase64, mimeType, GEMINI_KEY);
    if (!result.success) {
      return res.status(200).json({ success: false, error: result.error });
    }
    return res.status(200).json({ success: true, ...result.parsed });
  } catch (err) {
    console.error("partner-analyze error:", err.message);
    return res.status(200).json({ success: false, error: err.message });
  }
};