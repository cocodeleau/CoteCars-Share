// api/partner-analyze.js
// Analyse Gemini Vision : détection car_box + license_plate
// Retry avec Exponential Backoff sur 503/429

const MAX_RETRIES = 3;
const BASE_DELAY_MS = 2000;
const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

async function callGemini(imageBase64, mimeType, apiKey) {
  // Nettoyer le préfixe base64 si présent (canvas.toDataURL inclut "data:image/...;base64,")
  const cleanBase64 = imageBase64.replace(/^data:image\/\w+;base64,/, "");

  const prompt = `Analyse cette photo de voiture et retourne UNIQUEMENT un JSON valide. Ne génère aucun texte avant ou après, pas de balises markdown. Je veux les coordonnées en pourcentages (de 0.0 à 1.0) par rapport à la taille de l'image. Structure attendue : { "car_box": { "x_center": float, "y_center": float, "width": float, "height": float }, "license_plate": { "x_center": float, "y_center": float, "width": float, "height": float } }`;

  const MODELS = [
    "gemini-2.5-flash",
    "gemini-flash-latest",
  ];

  for (const model of MODELS) {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;
    console.log(`\n========== TRYING MODEL: ${model} ==========`);

    for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
      if (attempt > 0) {
        const delay = BASE_DELAY_MS * Math.pow(2, attempt - 1);
        console.log(`[${model}] Retry ${attempt}/${MAX_RETRIES - 1} — waiting ${delay}ms...`);
        await sleep(delay);
      }

      try {
        const res = await fetch(url, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            contents: [{ parts: [
              { inline_data: { mime_type: "image/jpeg", data: cleanBase64 } },
              { text: prompt }
            ]}],
            generationConfig: {
              temperature: 0.1,
              maxOutputTokens: 512,
              responseMimeType: "application/json",
            },
            safetySettings: [
              { category: "HARM_CATEGORY_DANGEROUS_CONTENT", threshold: "BLOCK_NONE" },
              { category: "HARM_CATEGORY_HARASSMENT",        threshold: "BLOCK_NONE" },
              { category: "HARM_CATEGORY_HATE_SPEECH",       threshold: "BLOCK_NONE" },
              { category: "HARM_CATEGORY_SEXUALLY_EXPLICIT", threshold: "BLOCK_NONE" },
            ],
          }),
        });

        // Lire le body UNE seule fois
        const rawText = await res.text();

        if (res.ok) {
          let data;
          try { data = JSON.parse(rawText); } catch(e) {
            console.error(`[${model}] JSON parse error:`, rawText.slice(0, 500));
            break;
          }

          // LOG MASSIF — visible dans les logs Vercel
          console.log("=== RAW GOOGLE DATA ===");
          console.log(JSON.stringify(data, null, 2));
          console.log("=== END RAW GOOGLE DATA ===");

          const raw = data.candidates?.[0]?.content?.parts?.[0]?.text || "";
          const finishReason = data.candidates?.[0]?.finishReason || "unknown";
          const safetyRatings = JSON.stringify(data.candidates?.[0]?.safetyRatings || []);
          console.log(`[${model}] raw.length=${raw.length}, finishReason=${finishReason}`);
          console.log(`[${model}] safetyRatings=${safetyRatings}`);

          // Nettoyage : retirer balises markdown éventuelles
          const cleaned = raw.replace(/```json|```/gi, "").trim();
          const s = cleaned.indexOf("{"), e = cleaned.lastIndexOf("}");
          if (s !== -1 && e !== -1) {
            return { success: true, parsed: JSON.parse(cleaned.slice(s, e + 1)), model };
          }

          console.error(`[${model}] No JSON found. raw="${raw}"`);
          // Retourner l'objet complet Google pour debug frontend
          return {
            success: false,
            error: "No JSON in response",
            rawText: raw,
            finishReason,
            googleData: data,
          };
        }

        // ===== ERREUR BRUTE COMPLÈTE =====
        console.error(`\n[${model}] HTTP ${res.status} — FULL ERROR RESPONSE:`);
        console.error("=== RAW ERROR START ===");
        console.error(rawText);
        console.error("=== RAW ERROR END ===\n");

        // 503 surcharge ou 429 quota → retry
        if (res.status === 503 || res.status === 429) {
          if (attempt < MAX_RETRIES - 1) continue;
          break; // passer au modèle suivant
        }

        // Autre erreur → pas de retry, passer au modèle suivant
        break;

      } catch (e) {
        console.error(`[${model}] Fetch exception:`, e.message);
        break;
      }
    }
  }

  return { success: false, error: "Tous les modèles ont échoué — voir logs Vercel pour détails" };
}

module.exports = async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  const { imageBase64, mimeType } = req.body;
  if (!imageBase64) return res.status(400).json({ error: "Missing imageBase64" });

  const GEMINI_KEY = process.env.GEMINI_API_KEY;
  console.log("GEMINI_KEY present:", !!GEMINI_KEY, "length:", GEMINI_KEY?.length);

  try {
    const result = await callGemini(imageBase64, mimeType, GEMINI_KEY);
    if (!result.success) {
      return res.status(200).json({ success: false, error: result.error });
    }
    return res.status(200).json({ success: true, ...result.parsed, model: result.model });
  } catch (err) {
    console.error("partner-analyze EXCEPTION:", err.message, err.stack);
    return res.status(200).json({ success: false, error: err.message });
  }
};