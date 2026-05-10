// api/rapid-api-requests.js
//
// Lookup SIV gratuit via l'endpoint interne de Mister-Auto.
// URL confirmée par inspection DevTools le 10/05/2026.
//
// ⚠️  IMPORTANT : Au premier déploiement, check les logs Vercel pour voir
//     le JSON brut retourné et corriger le parsing si nécessaire.
//
// Reçoit : GET ?plaque=AB123CD
// Renvoie : { data: { AWN_marque, AWN_modele, ... } }

import fetch from 'node-fetch';

const USER_AGENTS = [
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/119.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:121.0) Gecko/20100101 Firefox/121.0',
];
const randomUA = () => USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)];

// ── Mister-Auto — endpoint confirmé par DevTools ──────────────────
async function lookupMisterAuto(plate) {
  const url = [
    'https://www.mister-auto.com/nwsAjax/Plate',
    '?captcha_token=',
    '&family_id=0',
    '&generic_id=0',
    '&category_id=0',
    '&locale=fr_FR',
    '&device=desktop',
    '&pageType=homepage',
    '&country=FR',
    '&lang=fr',
    '&captchaVersion=v3',
    '&plate_selector_vof=',
    `&immatriculation=${encodeURIComponent(plate)}`,
  ].join('');

  console.log(`[MA] Appel : ${url}`);

  const res = await fetch(url, {
    method: 'GET',
    headers: {
      'User-Agent':      randomUA(),
      'Accept':          'application/json, text/plain, */*',
      'Accept-Language': 'fr-FR,fr;q=0.9',
      'Referer':         'https://www.mister-auto.com/',
    },
    // node-fetch v2 : timeout via signal
    signal: AbortSignal.timeout ? AbortSignal.timeout(9000) : undefined,
  });

  const text = await res.text();

  // Log complet pour débug — à retirer une fois le parsing confirmé
  console.log(`[MA] HTTP ${res.status} | Réponse brute : ${text.slice(0, 600)}`);

  if (!res.ok) throw new Error(`HTTP ${res.status}`);

  let json;
  try { json = JSON.parse(text); }
  catch (e) { throw new Error('Réponse non-JSON : ' + text.slice(0, 100)); }

  return parseMisterAuto(json);
}

function parseMisterAuto(json) {
  // status "3" = plaque inconnue
  // status "1" ou "2" = trouvé (à confirmer dans les logs)
  if (json.status === '3' || json.status === 3) {
    throw new Error('Plaque inconnue (status 3)');
  }

  // Le tableau vehicule[] contient les motorisations disponibles
  const vehicules = json.vehicule || json.vehicle || json.vehicles || [];

  if (!Array.isArray(vehicules) || vehicules.length === 0) {
    // Log le JSON complet pour comprendre la structure
    console.log('[MA] Structure inattendue, JSON complet :', JSON.stringify(json).slice(0, 800));
    throw new Error('Tableau vehicule vide ou absent');
  }

  // On prend le premier véhicule
  const v = vehicules[0];
  console.log('[MA] Premier véhicule :', JSON.stringify(v).slice(0, 400));

  // Extraction flexible — les vrais noms de champs apparaîtront dans les logs
  const marque  = (v.marque  || v.brand  || v.make   || v.manufacturer || '').toUpperCase().trim();
  const modele  = (v.modele  || v.model  || v.range  || v.model_name   || '').trim();
  const libelle = (v.libelle || v.type   || v.engine || v.version      || v.app_type || '').trim();
  const annee   = String(
    v.annee || v.year || v.millesime ||
    v.first_registration_year || json.firstRegistrationDate || ''
  ).replace(/\D/g, '').slice(0, 4);

  if (!marque && !modele) {
    console.log('[MA] Champs vides — objet complet :', JSON.stringify(v));
    throw new Error('Marque et modèle vides');
  }

  return buildResult({ marque, modele, libelle, annee });
}

// ── Oscaro — fallback (endpoint GET confirmé par DevTools) ────────
async function lookupOscaro(plate) {
  const url = `https://www.oscaro.com/xhr/dionysos-search/fr/fr?plate=${encodeURIComponent(plate)}`;
  console.log(`[Oscaro] Appel : ${url}`);

  const res = await fetch(url, {
    method: 'GET',
    headers: {
      'User-Agent':      randomUA(),
      'Accept':          'application/json, text/plain, */*',
      'Accept-Language': 'fr-FR,fr;q=0.9',
      'Referer':         'https://www.oscaro.com/',
    },
    signal: AbortSignal.timeout ? AbortSignal.timeout(9000) : undefined,
  });

  // 204 = plaque inconnue
  if (res.status === 204) throw new Error('Plaque inconnue (204 No Content)');
  if (!res.ok) throw new Error(`HTTP ${res.status}`);

  const text = await res.text();
  console.log(`[Oscaro] HTTP ${res.status} | Réponse brute : ${text.slice(0, 600)}`);

  let json;
  try { json = JSON.parse(text); }
  catch (e) { throw new Error('Réponse non-JSON : ' + text.slice(0, 100)); }

  return parseOscaro(json);
}

function parseOscaro(json) {
  // Structure à confirmer dans les logs
  const v = json.vehicle || json.vehicule || json.data || json;

  const marque  = (v.make  || v.brand  || v.marque || '').toUpperCase().trim();
  const modele  = (v.model || v.modele || v.range  || '').trim();
  const libelle = (v.type  || v.engine || v.version || v.libelle || '').trim();
  const annee   = String(v.year || v.annee || v.registration_year || '').replace(/\D/g, '').slice(0, 4);

  if (!marque && !modele) {
    console.log('[Oscaro] Structure inattendue :', JSON.stringify(json).slice(0, 400));
    throw new Error('Marque et modèle vides');
  }

  return buildResult({ marque, modele, libelle, annee });
}

// ── Parsing commun ────────────────────────────────────────────────
function extractPower(libelle) {
  const match = libelle.match(/(\d{2,4})\s*(ch|cv|kw)/i);
  if (!match) return { ch: null, kw: null };
  const val  = parseInt(match[1]);
  const unit = match[2].toLowerCase();
  if (unit === 'kw') return { ch: Math.round(val * 1.36), kw: val };
  return { ch: val, kw: Math.round(val / 1.36) };
}

function extractEnergie(libelle) {
  const l = libelle.toLowerCase();
  if (l.includes('diesel') || l.includes('dci') || l.includes('hdi') ||
      l.includes('tdci')   || l.includes('cdi') || l.includes('crd'))
    return 'GAZOLE';
  if (l.includes('electr') || l.includes('ev')) return 'ELECTRIQUE';
  if (l.includes('hybrid'))  return 'HYBRIDE';
  if (l.includes('gpl') || l.includes('lpg')) return 'GPL';
  return 'ESSENCE';
}

function buildResult({ marque, modele, libelle, annee }) {
  const { ch, kw } = extractPower(libelle);
  const energie     = extractEnergie(libelle);
  const motorisation = libelle.replace(/\d{2,4}\s*(ch|cv|kw)/gi, '').trim();
  const dateMEC      = annee ? `01/01/${annee}` : '';

  return {
    marque, modele, motorisation,
    puissance: ch ? `${ch}ch` : '',
    annee,
    // Champs AWN_ pour compatibilité frontend
    AWN_marque:                   marque,
    AWN_modele:                   modele,
    AWN_date_mise_en_circulation: dateMEC,
    AWN_energie:                  energie,
    AWN_puissance_CH:             ch   || null,
    AWN_puissance_KW:             kw   || null,
    AWN_version:                  libelle,
    AWN_label:                    `${marque} ${modele}`.trim(),
    AWN_boite:                    '',
    AWN_nb_portes:                null,
    AWN_puissance_SUSPECT:        ch ? ch > 500 : false,
  };
}

// ── Handler Vercel ────────────────────────────────────────────────
export default async function handler(req, res) {
  const plaque = (req.query.plaque || '').replace(/[-\s]/g, '').toUpperCase();

  if (!plaque || plaque.length < 5) {
    return res.status(400).json({ error: 'Plaque invalide.' });
  }

  let result = null;
  const errors = [];

  // Source 1 : Mister-Auto
  try {
    result = await lookupMisterAuto(plaque);
    console.log(`[SIV] ✓ Mister-Auto OK — ${plaque}`);
  } catch (e) {
    console.warn(`[SIV] ✗ Mister-Auto : ${e.message}`);
    errors.push('Mister-Auto: ' + e.message);
  }

  // Source 2 : Oscaro
  if (!result) {
    try {
      result = await lookupOscaro(plaque);
      console.log(`[SIV] ✓ Oscaro OK — ${plaque}`);
    } catch (e) {
      console.warn(`[SIV] ✗ Oscaro : ${e.message}`);
      errors.push('Oscaro: ' + e.message);
    }
  }

  if (!result) {
    return res.status(200).json({
      error:  'Véhicule non trouvé.',
      detail: errors.join(' | '),
    });
  }

  return res.status(200).json({ data: result });
}