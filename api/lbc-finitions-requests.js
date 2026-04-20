const { CORS_HEADERS, URLS } = require("./utils/constants.js");

module.exports = async function handler(req, res) {
  Object.entries({ ...CORS_HEADERS, "Access-Control-Allow-Methods": "GET, OPTIONS" })
    .forEach(([k, v]) => res.setHeader(k, v));
  if (req.method === "OPTIONS") return res.status(200).end();

  const { marque, modele } = req.query;
  if (!marque || !modele) return res.status(400).json({ error: "Marque et modèle requis" });

  try {
    const response = await fetch(
      `${URLS.lbcSearch}?q=${encodeURIComponent(modele)}&brand=${encodeURIComponent(marque)}`,
      { headers: { "User-Agent": "Mozilla/5.0", "Accept": "application/json" } }
    );
    if (!response.ok) throw new Error(`Leboncoin API ${response.status}`);
    return res.status(200).json(await response.json());
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
};
