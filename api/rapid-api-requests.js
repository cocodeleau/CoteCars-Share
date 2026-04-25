const { normalizeVehicle } = require("./utils/normalizers.js");
const { KEYS, CORS_HEADERS } = require("./utils/constants.js");

module.exports = async function handler(req, res) {
  Object.entries(CORS_HEADERS).forEach(([k, v]) => res.setHeader(k, v));
  if (req.method === "OPTIONS") return res.status(200).end();

  const { plaque } = req.query;
  if (!plaque) return res.status(400).json({ error: "Plaque manquante" });

  try {
    const url = `https://api-plaque-immatriculation-siv.p.rapidapi.com/get-vehicule-info?host_name=https%3A%2F%2Fapiplaqueimmatriculation.com&immatriculation=${plaque}`;
    const response = await fetch(url, {
      method: "GET",
      headers: {
        "x-rapidapi-key":  KEYS.rapidApi,
        "x-rapidapi-host": "api-plaque-immatriculation-siv.p.rapidapi.com",
        "Content-Type":    "application/json",
      },
    });
    const data = await response.json();
    return res.status(200).json(normalizeVehicle(data));
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
};