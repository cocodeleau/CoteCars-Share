const { KEYS, URLS, CORS_HEADERS } = require("./utils/constants.js");

module.exports = async function handler(req, res) {
  Object.entries(CORS_HEADERS).forEach(([k, v]) => res.setHeader(k, v));
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).end();

  try {
    const { prompt } = req.body;
    const response = await fetch(`${URLS.gemini}?key=${KEYS.gemini}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: { temperature: 0.7 },
      }),
    });
    const data = await response.json();
    const text = (data.candidates?.[0]?.content?.parts?.[0]?.text || "").replace(/\*+/g, "").trim();
    return res.status(200).json({ text });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
};
