const { buildLbcUrl, buildLbcFinitionUrl, deduplicateAds } = require("./utils/lbc-url-builder.js");
const { KEYS, CORS_HEADERS } = require("./utils/constants.js");

async function fetchPiloterr(url) {
  const response = await fetch(
    `https://piloterr.com/api/v2/leboncoin/search?query=${encodeURIComponent(url)}`,
    { method: "GET", headers: { "x-api-key": KEYS.piloterr } }
  );
  if (response.status === 404) return { ads: [] };
  if (!response.ok) throw new Error(`Piloterr ${response.status}`);
  return response.json();
}

module.exports = async function handler(req, res) {
  Object.entries(CORS_HEADERS).forEach(([k, v]) => res.setHeader(k, v));
  if (req.method === "OPTIONS") return res.status(200).end();

  const { marque, modele, annee, km, ch, fuel, gearbox, finition } = req.query;
  if (!marque || !modele) return res.status(400).json({ error: "Marque et modèle requis" });

  const anneeMin = annee ? parseInt(annee) - 1 : undefined;
  const kmMax    = km    ? parseInt(km) + 30000 : undefined;
  const chMin    = ch    ? Math.floor(parseInt(ch) / 10) * 10 : undefined;

  try {
    if (finition) {
      const urlFinition     = buildLbcFinitionUrl({ marque, modele, finition, anneeMin, fuel, gearbox });
      const urlSansFinition = buildLbcUrl({ marque, modele, anneeMin, kmMax, chMin, fuel, gearbox, useStrict: true });
      const [dataFin, dataSans] = await Promise.all([
        fetchPiloterr(urlFinition).catch(() => ({ ads: [] })),
        fetchPiloterr(urlSansFinition).catch(() => ({ ads: [] })),
      ]);
      return res.status(200).json({ ads: deduplicateAds([dataFin.ads || [], dataSans.ads || []]) });
    }

    try {
      const strictUrl = buildLbcUrl({ marque, modele, anneeMin, kmMax, chMin, fuel, gearbox, useStrict: true });
      const data = await fetchPiloterr(strictUrl);
      if (data.ads && data.ads.length > 0) return res.status(200).json(data);
    } catch (_) {}

    const textUrl = buildLbcUrl({ marque, modele, anneeMin, kmMax, chMin, fuel, gearbox, useStrict: false });
    return res.status(200).json(await fetchPiloterr(textUrl));
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
};
