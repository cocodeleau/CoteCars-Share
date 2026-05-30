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

  const OFFSET_P2 = 35;

  try {
    if (finition) {
      const urlFin1  = buildLbcFinitionUrl({ marque, modele, finition, anneeMin, fuel, gearbox });
      const urlFin2  = buildLbcFinitionUrl({ marque, modele, finition, anneeMin, fuel, gearbox, offset: OFFSET_P2 });
      const urlSans1 = buildLbcUrl({ marque, modele, anneeMin, kmMax, chMin, fuel, gearbox, useStrict: true });
      const urlSans2 = buildLbcUrl({ marque, modele, anneeMin, kmMax, chMin, fuel, gearbox, useStrict: true, offset: OFFSET_P2 });
      const [d1, d2, d3, d4] = await Promise.all([
        fetchPiloterr(urlFin1).catch(() => ({ ads: [] })),
        fetchPiloterr(urlFin2).catch(() => ({ ads: [] })),
        fetchPiloterr(urlSans1).catch(() => ({ ads: [] })),
        fetchPiloterr(urlSans2).catch(() => ({ ads: [] })),
      ]);
      return res.status(200).json({ ads: deduplicateAds([d1.ads || [], d2.ads || [], d3.ads || [], d4.ads || []]) });
    }

    try {
      const strictUrl1 = buildLbcUrl({ marque, modele, anneeMin, kmMax, chMin, fuel, gearbox, useStrict: true });
      const strictUrl2 = buildLbcUrl({ marque, modele, anneeMin, kmMax, chMin, fuel, gearbox, useStrict: true, offset: OFFSET_P2 });
      const [data1, data2] = await Promise.all([
        fetchPiloterr(strictUrl1),
        fetchPiloterr(strictUrl2).catch(() => ({ ads: [] })),
      ]);
      const allAds = deduplicateAds([data1.ads || [], data2.ads || []]);
      if (allAds.length > 0) return res.status(200).json({ ads: allAds });
    } catch (_) {}

    const textUrl1 = buildLbcUrl({ marque, modele, anneeMin, kmMax, chMin, fuel, gearbox, useStrict: false });
    const textUrl2 = buildLbcUrl({ marque, modele, anneeMin, kmMax, chMin, fuel, gearbox, useStrict: false, offset: OFFSET_P2 });
    const [td1, td2] = await Promise.all([
      fetchPiloterr(textUrl1),
      fetchPiloterr(textUrl2).catch(() => ({ ads: [] })),
    ]);
    return res.status(200).json({ ads: deduplicateAds([td1.ads || [], td2.ads || []]) });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
};