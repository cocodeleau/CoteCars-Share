const MERCEDES_VIN = {
  "168": "Classe A", "169": "Classe A", "176": "Classe A", "177": "Classe A",
  "245": "Classe B", "246": "Classe B", "247": "Classe B",
  "202": "Classe C", "203": "Classe C", "204": "Classe C", "205": "Classe C", "206": "Classe C",
  "210": "Classe E", "211": "Classe E", "212": "Classe E", "213": "Classe E", "214": "Classe E",
  "140": "Classe S", "220": "Classe S", "221": "Classe S", "222": "Classe S", "223": "Classe S",
  "460": "Classe G", "461": "Classe G", "463": "Classe G",
  "163": "Classe M", "164": "Classe GLE", "166": "Classe GLE", "167": "Classe GLS",
  "253": "Classe GLC", "254": "Classe GLC",
  "156": "Classe GLA",
  "117": "Classe CLA", "118": "Classe CLA",
  "208": "Classe CLK", "209": "Classe CLK",
  "219": "Classe CLS", "218": "Classe CLS", "257": "Classe CLS",
  "107": "Classe SL", "129": "Classe SL", "230": "Classe SL", "231": "Classe SL", "232": "Classe SL",
  "170": "Classe SLK", "171": "Classe SLK", "172": "Classe SLK", "296": "Classe SLC",
  "638": "Classe V", "639": "Classe V", "447": "Classe V",
  "251": "Classe R", "470": "Classe X",
  "243": "EQA", "293": "EQC", "294": "EQE", "297": "EQS",
};

const BMW_VIN = {
  "E81": "Série 1", "E82": "Série 1", "E87": "Série 1", "E88": "Série 1",
  "F20": "Série 1", "F21": "Série 1", "F40": "Série 1",
  "E36": "Série 3", "E46": "Série 3",
  "E90": "Série 3", "E91": "Série 3", "E92": "Série 3", "E93": "Série 3",
  "F30": "Série 3", "F31": "Série 3", "F34": "Série 3", "G20": "Série 3", "G21": "Série 3",
  "E38": "Série 7", "E65": "Série 7", "E66": "Série 7",
  "F01": "Série 7", "F02": "Série 7", "G11": "Série 7", "G12": "Série 7",
};

function normalizeVehicle(data) {
  if (!data || !data.data) return data;
  const d = data.data;

  const marque = (d.marque || "").toUpperCase().trim();
  const vin    = (d.vin    || "").toUpperCase().trim();

  // Normalisation marque/modele
  if (marque === "MERCEDES") {
    d.AWN_marque = "MERCEDES-BENZ";
    const vinCode = vin.substring(3, 6);
    d.AWN_modele = MERCEDES_VIN[vinCode] || d.modele || "";
  } else if (marque === "B.M.W." || marque === "BMW") {
    d.AWN_marque = "BMW";
    const vinCode = vin.substring(3, 6);
    d.AWN_modele = BMW_VIN[vinCode] || d.modele || "";
  } else {
    d.AWN_marque = d.marque || "";
    d.AWN_modele = d.modele || "";
  }

  // Energie
  const ENERGIE_MAP = {
    "DIESEL": "GAZOLE", "ESSENCE": "ESSENCE", "ELECTRIC": "ELECTRIQUE",
    "HYBRID": "HYBRIDE", "GPL": "GPL", "GNV": "GAZ NATUREL (GNV)",
  };
  const energieUp = (d.energieNGC || "").toUpperCase();
  d.AWN_energie = ENERGIE_MAP[energieUp] || d.energieNGC || "";
  if (energieUp.includes("ELECTRIC")) d.AWN_energie = "ELECTRIQUE";
  if (energieUp.includes("HYBRID"))   d.AWN_energie = "HYBRIDE";

  // Champs standards
  d.AWN_date_mise_en_circulation = d.date1erCir_fr || "";
  d.AWN_VIN     = vin;
  d.AWN_label   = d.version || "";

  // Puissance CH directe
  const chRaw = (d.puisFiscReelCH || "").replace(/\s*CH\s*/i, "").trim();
  d.AWN_puissance_CH = chRaw ? parseInt(chRaw) : null;

  // Boite de vitesse
  const bv = (d.boite_vitesse || "").toUpperCase();
  d.AWN_boite = bv === "M" ? "Manuelle" : bv === "A" ? "Automatique" : "";

  // Infos supplémentaires
  d.AWN_version   = d.version      || "";
  d.AWN_nb_portes = d.nb_portes    || "";
  d.AWN_passagers = d.nr_passagers || "";
  d.AWN_cylindres = d.cylindres    || "";
  d.AWN_couleur   = d.couleur      || "";

  return data;
}

function getFuelCode(energieRaw) {
  const FUEL_CODES = {
    "ESSENCE": "1", "GAZOLE": "2", "GPL": "3", "ELECTRIQUE": "4",
    "AUTRE": "5", "HYBRIDE": "6", "HYBRIDE ESSENCE ELECTRIQUE": "6",
    "HYBRIDE RECHARGEABLE": "6", "HYBRIDE DIESEL ELECTRIQUE": "6",
    "GAZ NATUREL (GNV)": "5", "HYDROGENE": "5",
  };
  const up = (energieRaw || "").toUpperCase();
  if (FUEL_CODES[up]) return FUEL_CODES[up];
  if (up.includes("HYBRIDE")) return "6";
  if (up.includes("ELECTR"))  return "4";
  if (up.includes("GPL"))     return "3";
  return "";
}

module.exports = { normalizeVehicle, getFuelCode };