const { CORS_HEADERS, LBC_HEADERS, URLS } = require("./utils/constants.js");

module.exports = async function handler(req, res) {
  Object.entries({ ...CORS_HEADERS, "Access-Control-Allow-Methods": "GET, OPTIONS" })
    .forEach(([k, v]) => res.setHeader(k, v));
  if (req.method === "OPTIONS") return res.status(200).end();

  const { type, brand } = req.query;
  try {
    if (type === "brands") {
      const response = await fetch(`${URLS.lbc}?category=2&key=u_car_brand`, { headers: LBC_HEADERS });
      if (!response.ok) return res.status(response.status).json({ error: `LBC ${response.status}` });
      return res.status(200).json(await response.json());
    }
    if (type === "models" && brand) {
      const response = await fetch(`${URLS.lbc}?category=2&key=u_car_model&filters=u_car_brand%3D${encodeURIComponent(brand)}`, { headers: LBC_HEADERS });
      if (!response.ok) return res.status(response.status).json({ error: `LBC ${response.status}` });
      return res.status(200).json(await response.json());
    }
    return res.status(400).json({ error: "type=brands ou type=models&brand=MARQUE requis" });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
};
