const { getLbcParams } = require("./lbc-marques-models-codes.js");

const MODELE_NORMALIZE = {
  "DISCOV.SP": "Discovery Sport", "C3 AIRCR.": "C3 Aircross",
  "C5 AIRCR.": "C5 Aircross", "SUBARU XV": "XV",
  "RR SPORT": "Range Rover Sport", "RR EVOQUE": "Range Rover Evoque",
  "L.CRUISER": "Land Cruiser",
};

function normalizeModele(modele) {
  return MODELE_NORMALIZE[(modele || "").toUpperCase()] || modele;
}

function buildLbcUrl({ marque, modele, finition, anneeMin, kmMax, chMin, fuel, gearbox, useStrict = true }) {
  const modeleText = normalizeModele(modele);
  const lbc = useStrict ? getLbcParams(marque, modele) : null;
  const p = new URLSearchParams({ category: "2", owner_type: "pro", sort: "price", order: "asc" });
  if (lbc) {
    p.set("u_car_brand", lbc.brand);
    p.set("u_car_model", lbc.model);
    if (finition) p.set("text", finition);
  } else {
    p.set("text", `${marque} ${modeleText}${finition ? " " + finition : ""}`);
  }
  if (anneeMin) p.set("regdate", `${anneeMin}-max`);
  if (kmMax)    p.set("mileage", `min-${kmMax}`);
  if (chMin)    p.set("horse_power_din", `${chMin}-max`);
  if (fuel)     p.set("fuel", fuel);
  if (gearbox === "2") p.set("gearbox", gearbox);
  return `https://www.leboncoin.fr/recherche?${p.toString()}`;
}

function buildLbcFinitionUrl({ marque, modele, finition, anneeMin, fuel, gearbox }) {
  const lbc = getLbcParams(marque, modele);
  const p = new URLSearchParams({ category: "2", owner_type: "pro", sort: "price", order: "asc" });
  if (lbc) { p.set("u_car_brand", lbc.brand); p.set("u_car_model", lbc.model); p.set("text", finition); }
  else { p.set("text", `${marque} ${modele} ${finition}`); }
  if (anneeMin) p.set("regdate", `${anneeMin}-max`);
  if (fuel)     p.set("fuel", fuel);
  if (gearbox)  p.set("gearbox", gearbox);
  return `https://www.leboncoin.fr/recherche?${p.toString()}`;
}

function deduplicateAds(adsArrays) {
  const seen = new Set();
  const result = [];
  for (const ad of adsArrays.flat()) {
    if (!seen.has(ad.list_id)) { seen.add(ad.list_id); result.push(ad); }
  }
  return result;
}

module.exports = { buildLbcUrl, buildLbcFinitionUrl, deduplicateAds, normalizeModele };
