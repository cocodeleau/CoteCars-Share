// api/rapid-api-requests.js
//
// SIV via API SIV Autoways (RapidAPI)
// Endpoint : GET https://api-siv-systeme-d-immatriculation-des-vehicules.p.rapidapi.com/{plaque}
// Clés     : RAPIDAPI_KEY et RAPIDAPI_HOST dans les variables d'env Vercel
//
// Reçoit : GET ?plaque=AB123CD
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

  if (!plaque || plaque.length < 5) {
    return res.status(400).json({ error: "Plaque invalide." });
  }

  const apiKey  = process.env.RAPIDAPI_KEY;
  const apiHost = process.env.RAPIDAPI_HOST;

  if (!apiKey || !apiHost) {
    console.error("[SIV] Variables RAPIDAPI_KEY ou RAPIDAPI_HOST manquantes dans Vercel.");
    return res.status(200).json({ error: "Clé API SIV non configurée." });
  }

  const url = `https://${apiHost}/${encodeURIComponent(plaque)}`;

  let json;
  try {
    const response = await fetch(url, {
      method: "GET",
      headers: {
        "Content-Type":    "application/json",
        "x-rapidapi-host": apiHost,
        "x-rapidapi-key":  apiKey,
      },
    });
    const text = await response.text();
    console.log(`[SIV] HTTP ${response.status} | ${text.slice(0, 300)}`);
    json = JSON.parse(text);
  } catch (e) {
    console.error("[SIV] Erreur fetch :", e.message);
    return res.status(200).json({ error: "API injoignable : " + e.message });
  }

  if (json.error || json.code !== 200) {
    const msg = json.message || "Erreur inconnue";
    console.warn("[SIV] Erreur API :", msg);
    return res.status(200).json({ error: msg });
  }

  const d = json.data;
  if (!d?.AWN_marque) {
    return res.status(200).json({ error: "Véhicule non trouvé." });
  }

  // ── Extraction — les champs sont déjà au format AWN_ ──
  const marque  = (d.AWN_marque  || "").toUpperCase().trim();
  const modele  = (d.AWN_modele  || "").trim();
  const version = (d.AWN_version || d.AWN_finition || "").trim();
  const puissCH = parseInt(d.AWN_puissance_chevaux) || null;
  const puissKW = parseInt(d.AWN_puissance_KW)      || null;
  const dateMEC = (d.AWN_date_mise_en_circulation   || "").replace(/-/g, "/");
  const annee   = d.AWN_date_mise_en_circulation_us
    ? d.AWN_date_mise_en_circulation_us.slice(0, 4)
    : "";

  // Énergie
  function toEnergie(raw) {
    if (!raw) return null;
    const r = raw.toUpperCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");
    if (r.includes("DIESEL") || r.includes("GAZOLE") || r === "GO") return "GAZOLE";
    if (r.includes("ELECT") && (r.includes("HYBRID") || r.includes("RECHARG") || r.includes("ELEC"))) return "HYBRIDE";
    if (r.includes("ELECT"))  return "ELECTRIQUE";
    if (r.includes("HYBRID") || r.includes("ELEC")) return "HYBRIDE";
    if (r.includes("GPL"))    return "GPL";
    if (r.includes("ESSENCE") || r.includes("ESSENC") || r === "SP") return "ESSENCE";
    return null;
  }

  const energieA = toEnergie(d.AWN_energie);
  const energieB = toEnergie(d.AWN_energie_description);
  const energieSuspect = !!(energieA && energieB && energieA !== energieB);
  const energie  = energieA || energieB || "ESSENCE";

  // Détecter puissance combinée hybride dans le label (ex: "E-TECH PLUG-IN 160" → 160ch)
  const labelUpper = (d.AWN_label || d.AWN_version || "").toUpperCase();
  let puissanceCombinee = null;
  const hybridePuissMatch = labelUpper.match(/(?:E-TECH|PLUG-IN|PHEV|HYBRID|HEV|E-HYBRID)\s+(?:PLUG-IN\s+)?(\d{2,3})(?:\s|$)/);
  if (hybridePuissMatch) {
    const p = parseInt(hybridePuissMatch[1]);
    if (p > 50 && p < 500) puissanceCombinee = p;
  }
  const puissanceSuspectHybride = !!(puissanceCombinee && puissCH && puissanceCombinee !== puissCH);

  // Boîte
  const boiteRaw = (d.AWN_type_boite_vites || "").toUpperCase();
  const boite = boiteRaw.includes("AUTO") ? "Automatique"
    : boiteRaw.includes("MAN")  ? "Manuelle" : "";

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
    AWN_label:                    d.AWN_label || `${marque} ${modele}`.trim(),
    AWN_boite:                    boite,
    AWN_nb_portes:                parseInt(d.AWN_nbr_portes)    || null,
    AWN_passagers:                parseInt(d.AWN_nbr_de_places) || null,
    AWN_cylindres:                parseInt(d.AWN_nbr_cylindres) || null,
    AWN_puissance_SUSPECT:        (puissCH ? puissCH > 500 : false) || puissanceSuspectHybride,
    AWN_puissance_SUSPECT_valeurs: puissanceSuspectHybride ? [puissCH, puissanceCombinee] : [],
    AWN_energie_SUSPECT:          energieSuspect,
    AWN_energie_SUSPECT_valeurs:  energieSuspect ? [energieA, energieB] : [],
    AWN_energie_DETECTEE:         energie,

    AWN_nom_commercial: d.AWN_nom_commercial || "",
    AWN_modele_prf:     d.AWN_modele_prf    || "",

    AWN_couleur:      d.AWN_couleur      || "",
    AWN_carrosserie:  d.AWN_carrosserie  || "",
    AWN_poids:        d.AWN_PTAC        ? `${d.AWN_PTAC} KG` : "",
    AWN_vin:          d.AWN_VIN         || "",
    AWN_co2:          d.AWN_emission_co_2 ? `${d.AWN_emission_co_2} g/km` : "",
    AWN_code_moteur:  d.AWN_code_moteur  || "",
    AWN_k_type:       d.AWN_k_type       || "",
    AWN_logo_marque:  d.AWN_marque_image || "",
    AWN_photo_modele: d.AWN_model_image  || "",
  };

  console.log(`[SIV] ✓ ${marque} ${modele} — ${puissCH}ch ${energie}`);
  return res.status(200).json({ data: result });
};