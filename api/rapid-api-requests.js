const { normalizeVehicle } = require("./utils/normalizers.js");
const { KEYS, URLS, CORS_HEADERS } = require("./utils/constants.js");

module.exports = async function handler(req, res) {
  Object.entries(CORS_HEADERS).forEach(([k, v]) => res.setHeader(k, v));
  if (req.method === "OPTIONS") return res.status(200).end();

  const { plaque } = req.query;
  if (!plaque) return res.status(400).json({ error: "Plaque manquante" });

  try {
    const response = await fetch(`${URLS.rapidApi}/?plaque=${plaque}`, {
      method: "GET",
      headers: {
        "x-rapidapi-key":  KEYS.rapidApi,
        "x-rapidapi-host": "france-license-plate-api-siv-lite2.p.rapidapi.com",
      },
    });
    const data = await response.json();
    return res.status(200).json(normalizeVehicle(data));
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
};
