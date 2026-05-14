// api/rapid-api-requests.js
//
// SIV via apiplaqueimmatriculation.com
// Endpoint : POST https://api.apiplaqueimmatriculation.com/plaque
// Token    : variable d'env PLAQUE_API_TOKEN (Vercel)
//
// Reçoit : GET ?plaque=AB123CD  ou  GET ?vin=WP1ZZZ9PZ4LA51880
// Renvoie : { data: { AWN_marque, AWN_modele, ... } }

const fetch = require("node-fetch");

const CORS_HEADERS = {
  "Access-Control-Allow-Origin":  "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

module.exports = async function handler(req, res) {
  Object.entries(CORS_HEADERS).forEach(([k, v]) => res.setHeader(k, v));
  if (req.method === "OPTIONS") return res.status(200).end();

  const plaque = (req.query.plaque || "").replace(/[-\s]/g, "").toUpperCase();
  const vin    = (req.query.vin    || "").replace(/[-\s]/g, "").toUpperCase();

  if (!plaque && !vin) {
    return res.status(400).json({ error: "Plaque ou VIN requis." });
  }
  if (plaque && plaque.length < 5) {
    return res.status(400).json({ error: "Plaque invalide." });
  }
  if (vin && vin.length < 11) {
    return res.status(400).json({ error: "VIN invalide." });
  }

  const token = process.env.PLAQUE_API_TOKEN;
  if (!token) {
    console.error("[SIV] Variable PLAQUE_API_TOKEN manquante dans Vercel.");
    return res.status(200).json({ error: "Clé API SIV non configurée." });
  }

  const url = vin
    ? `https://api.apiplaqueimmatriculation.com/vin?vin=${encodeURIComponent(vin)}&token=${token}`
    : `https://api.apiplaqueimmatriculation.com/plaque?immatriculation=${encodeURIComponent(plaque)}&token=${token}&pays=FR`;

  let json;
  try {
    const response = await fetch(url, {
      method:  "POST",
      headers: { "Accept": "application/json" },
    });
    const text = await response.text();
    console.log(`[SIV] HTTP ${response.status} | ${text.slice(0, 300)}`);
    json = JSON.parse(text);
  } catch (e) {
    console.error("[SIV] Erreur fetch :", e.message);
    return res.status(200).json({ error: "API injoignable : " + e.message });
  }

  if (json.code_erreur !== 200 || (json.data?.erreur && json.data.erreur !== "")) {
    const msg = json.data?.erreur || json.message || "Erreur inconnue";
    console.warn("[SIV] Erreur API :", msg);
    return res.status(200).json({ error: msg });
  }

  const d = json.data;
  if (!d?.marque) {
    return res.status(200).json({ error: "Véhicule non trouvé." });
  }

  const marque   = (d.marque          || "").toUpperCase().trim();
  const modele   = (d.modele          || "").trim();
  const version  = (d.sra_commercial  || d.version || "").trim();
  const puissCH  = parseInt(d.puisFiscReelCH) || null;
  const puissKW  = parseInt(d.puisFiscReelKW) || null;
  const dateMEC  = (d.date1erCir_fr   || "").replace(/-/g, "/");
  const annee    = d.date1erCir_us ? d.date1erCir_us.slice(0, 4) : "";

  const energieNGC = (d.energieNGC  || "").toUpperCase();
  const typeMoteur = (d.type_moteur || "").toUpperCase();

  function toEnergie(raw) {
    if (!raw) return null;
    if (raw.includes("DIESEL") || raw.includes("GAZOLE")) return "GAZOLE";
    if (raw.includes("ELECT"))  return "ELECTRIQUE";
    if (raw.includes("HYBRID")) return "HYBRIDE";
    if (raw.includes("GPL"))    return "GPL";
    if (raw.includes("ESSENCE") || raw.includes("ESSENC")) return "ESSENCE";
    return null;
  }

  const energieA = toEnergie(energieNGC);
  const energieB = toEnergie(typeMoteur);
  const energieSuspect = !!(energieA && energieB && energieA !== energieB);
  const energie = energieA || energieB || "ESSENCE";

  const boite = d.boite_vitesse === "A" ? "Automatique"
    : d.boite_vitesse === "M" ? "Manuelle" : "";

  const result = {
    marque, modele,
    motorisation: version,
    puissance:    puissCH ? `${puissCH}ch` : "",
    annee,

    AWN_marque:                   marque,
    AWN_modele:                   modele,
    AWN_date_mise_en_circulation: dateMEC,
    AWN_energie:                  energie,
    AWN_puissance_CH:             puissCH,
    AWN_puissance_KW:             puissKW,
    AWN_version:                  version,
    AWN_label:                    `${marque} ${modele}`.trim(),
    AWN_boite:                    boite,
    AWN_nb_portes:                parseInt(d.nb_portes)    || null,
    AWN_passagers:                parseInt(d.nr_passagers) || null,
    AWN_cylindres:                parseInt(d.cylindres)    || null,
    AWN_puissance_SUSPECT:        puissCH ? puissCH > 500 : false,
    AWN_energie_SUSPECT:          energieSuspect,
    AWN_energie_SUSPECT_valeurs:  energieSuspect ? [energieA, energieB] : [],

    AWN_couleur:      d.couleur      || "",
    AWN_carrosserie:  d.carrosserie  || "",
    AWN_poids:        d.poids        || "",
    AWN_vin:          d.vin          || "",
    AWN_co2:          d.co2          || "",
    AWN_code_moteur:  d.code_moteur  || "",
    AWN_k_type:       d.k_type       || "",
    AWN_logo_marque:  d.logo_marque  || "",
    AWN_photo_modele: d.photo_modele || "",
  };

  console.log(`[SIV] ✓ ${marque} ${modele} — ${puissCH}ch ${energie}${vin ? " (VIN)" : " (plaque)"}`);
  return res.status(200).json({ data: result });
};