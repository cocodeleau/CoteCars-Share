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
  const label   = (data.data.AWN_label   || "").toUpperCase();
  const modele  = (data.data.AWN_modele  || "").toUpperCase();
  const marque  = (data.data.AWN_marque  || "").toUpperCase();
  const energie = (data.data.AWN_energie || "").toUpperCase();
  const vin     = (data.data.AWN_VIN     || "").toUpperCase();

  if (marque === "MERCEDES") {
    data.data.AWN_marque = "MERCEDES-BENZ";
    const vinCode = vin.substring(3, 6);
    if (MERCEDES_VIN[vinCode]) {
      data.data.AWN_modele = MERCEDES_VIN[vinCode];
    } else if (modele === "CLASSE") {
      if      (label.includes("SLK"))                              data.data.AWN_modele = "Classe SLK";
      else if (label.includes("SLC"))                              data.data.AWN_modele = "Classe SLC";
      else if (label.includes("SL ") || label.endsWith("SL"))     data.data.AWN_modele = "Classe SL";
      else if (label.includes("CLA"))                              data.data.AWN_modele = "Classe CLA";
      else if (label.includes("CLK"))                              data.data.AWN_modele = "Classe CLK";
      else if (label.includes("CLS"))                              data.data.AWN_modele = "Classe CLS";
      else if (label.includes("GLA"))                              data.data.AWN_modele = "Classe GLA";
      else if (label.includes("GLB"))                              data.data.AWN_modele = "Classe GLB";
      else if (label.includes("GLC"))                              data.data.AWN_modele = "Classe GLC";
      else if (label.includes("GLE"))                              data.data.AWN_modele = "Classe GLE";
      else if (label.includes("GLK"))                              data.data.AWN_modele = "Classe GLK";
      else if (label.includes("GLS"))                              data.data.AWN_modele = "Classe GLS";
      else if (label.includes("CLASSE A") || label.match(/\bA\s+\d{3}/)) data.data.AWN_modele = "Classe A";
      else if (label.includes("CLASSE B") || label.match(/\bB\s+\d{3}/)) data.data.AWN_modele = "Classe B";
      else if (label.includes("CLASSE C") || label.match(/\bC\s+\d{3}/)) data.data.AWN_modele = "Classe C";
      else if (label.includes("CLASSE E") || label.match(/\bE\s+\d{3}/)) data.data.AWN_modele = "Classe E";
      else if (label.includes("CLASSE G"))                         data.data.AWN_modele = "Classe G";
      else if (label.includes("CLASSE M") || label.includes("ML")) data.data.AWN_modele = "Classe M";
      else if (label.includes("CLASSE R"))                         data.data.AWN_modele = "Classe R";
      else if (label.includes("CLASSE S") || label.match(/\bS\s+\d{3}/)) data.data.AWN_modele = "Classe S";
      else if (label.includes("CLASSE V"))                         data.data.AWN_modele = "Classe V";
      else if (label.includes("CLASSE X"))                         data.data.AWN_modele = "Classe X";
    }
  }

  if (marque === "B.M.W." || marque === "BMW") {
    data.data.AWN_marque = "BMW";
    const vinCode = vin.substring(3, 6);
    if (BMW_VIN[vinCode]) data.data.AWN_modele = BMW_VIN[vinCode];
  }

  if (modele === "IONIQ") {
    if (label.includes("IONIQ 6") || label.includes("IONIQ6")) data.data.AWN_modele = "IONIQ 6";
    else if (energie.includes("ELECTR") || label.includes("58 KWH") || label.includes("72 KWH") || label.includes("77 KWH")) data.data.AWN_modele = "IONIQ 5";
  }

  if (modele === "MEGANE" && (energie.includes("ELECTR") || label.includes("E-TECH"))) data.data.AWN_modele = "MEGANE E-TECH";
  if (modele === "208"  && energie.includes("ELECTR")) data.data.AWN_modele = "E-208";
  if (modele === "2008" && energie.includes("ELECTR")) data.data.AWN_modele = "E-2008";

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
