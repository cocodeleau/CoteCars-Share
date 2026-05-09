// api/rapid-api-requests.js
//
// Remplace l'appel RapidAPI (Autoways) par un lookup gratuit sur les APIs
// internes de Mister-Auto et Oscaro (sites de pièces auto FR).
//
// Sources interrogées dans l'ordre :
//   1. Mister-Auto (API JSON interne)
//   2. Oscaro (API JSON interne, fallback)
//
// ⚠️  Ces endpoints sont les APIs internes que leurs propres frontends utilisent.
//     Si un site change son API, cherche l'endpoint réel dans l'onglet Réseau
//     de Chrome sur mister-auto.com/oscaro.com en faisant une recherche par plaque.
//
// Reçoit : GET ?plaque=AB123CD
// Renvoie : { data: { AWN_marque, AWN_modele, ... } }  ← compatible frontend actuel
//           + { marque, modele, puissance, motorisation, annee } ← nouvelle structure

import fetch from 'node-fetch';

// ── User-Agents réalistes (rotation pour éviter le blocage) ──────
const USER_AGENTS = [
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/119.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:121.0) Gecko/20100101 Firefox/121.0',
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/118.0.0.0 Safari/537.36',
];
const randomUA = () => USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)];

// ── Source 1 : Mister-Auto ────────────────────────────────────────
async function lookupMisterAuto(plate) {
  // Endpoint interne utilisé par le widget de sélection véhicule de Mister-Auto
  const url = `https://www.mister-auto.com/api/vehicle/licence-plate/${encodeURIComponent(plate)}?country=FR`;

  const res = await fetch(url, {
    method: 'GET',
    headers: {
      'User-Agent':      randomUA(),
      'Accept':          'application/json, text/plain, */*',
      'Accept-Language': 'fr-FR,fr;q=0.9',
      'Referer':         'https://www.mister-auto.com/',
      'Origin':          'https://www.mister-auto.com',
    },
    timeout: 9000,
  });

  if (!res.ok) throw new Error(`Mister-Auto HTTP ${res.status}`);
  const json = await res.json();
  console.log('[Mister-Auto] Réponse brute:', JSON.stringify(json).slice(0, 300));
  return parseMisterAuto(json);
}

function parseMisterAuto(json) {
  // Mister-Auto retourne souvent { vehicle: { brand, model, engine, year } }
  // ou directement { brand, model, engine, year }
  const v = json.vehicle || json.data || json;

  const marque  = (v.brand       || v.marque || v.make         || '').toUpperCase().trim();
  const modele  = (v.model       || v.modele || v.model_name   || '').trim();
  const libelle = (v.engine      || v.libelle || v.description || v.version || '').trim();
  const annee   = String(v.year  || v.annee  || v.millesime    || '').replace(/\D/g,'').slice(0,4);

  return buildResult({ marque, modele, libelle, annee });
}

// ── Source 2 : Oscaro (fallback) ─────────────────────────────────
async function lookupOscaro(plate) {
  // Endpoint interne Oscaro — POST JSON avec la plaque
  const res = await fetch('https://www.oscaro.com/api/v2/vehicle/plate', {
    method: 'POST',
    headers: {
      'User-Agent':    randomUA(),
      'Accept':        'application/json',
      'Content-Type':  'application/json',
      'Referer':       'https://www.oscaro.com/',
      'Origin':        'https://www.oscaro.com',
    },
    body: JSON.stringify({ plate: plate.toUpperCase(), country: 'FR' }),
    timeout: 9000,
  });

  if (!res.ok) throw new Error(`Oscaro HTTP ${res.status}`);
  const json = await res.json();
  console.log('[Oscaro] Réponse brute:', JSON.stringify(json).slice(0, 300));
  return parseOscaro(json);
}

function parseOscaro(json) {
  const v = json.vehicle || json.data || json;

  const marque  = (v.make    || v.brand  || v.marque      || '').toUpperCase().trim();
  const modele  = (v.model   || v.modele || v.range        || '').trim();
  const libelle = (v.version || v.engine || v.motorization || '').trim();
  const annee   = String(v.year || v.registration_year || v.millesime || '').replace(/\D/g,'').slice(0,4);

  return buildResult({ marque, modele, libelle, annee });
}

// ── Parsing commun + extraction regex ────────────────────────────
function extractPower(libelle) {
  // Cherche "90ch", "90 ch", "90CV", "90 cv", "90kW", "66 kw"
  const match = libelle.match(/(\d{2,4})\s*(ch|cv|kw)/i);
  if (!match) return { ch: null, kw: null };
  const val  = parseInt(match[1]);
  const unit = match[2].toLowerCase();
  if (unit === 'kw') return { ch: Math.round(val * 1.36), kw: val };
  return { ch: val, kw: Math.round(val / 1.36) };
}

function extractEnergie(libelle) {
  const l = libelle.toLowerCase();
  if (l.includes('diesel') || l.includes('dci') || l.includes('hdi') || l.includes('tdci') || l.includes('crd'))
    return 'GAZOLE';
  if (l.includes('electric') || l.includes('électr') || l.includes('ev'))
    return 'ELECTRIQUE';
  if (l.includes('hybrid') || l.includes('hybride'))
    return 'HYBRIDE';
  if (l.includes('gpl') || l.includes('lpg'))
    return 'GPL';
  return 'ESSENCE'; // défaut
}

function buildResult({ marque, modele, libelle, annee }) {
  if (!marque && !modele) throw new Error('Données véhicule vides ou introuvables.');

  const { ch, kw } = extractPower(libelle);
  const energie     = extractEnergie(libelle);

  // Motorisation = libelle sans le bloc de puissance (ex: "1.2 PureTech 110ch" → "1.2 PureTech")
  const motorisation = libelle.replace(/\d{2,4}\s*(ch|cv|kw)/gi, '').trim();

  // Date de mise en circulation (fictive si on n'a que l'année)
  const dateMEC = annee ? `01/01/${annee}` : '';

  return {
    // ── Nouvelle structure simple ────────────────────────────────
    marque,
    modele,
    motorisation,
    puissance:  ch ? `${ch}ch` : '',
    annee,

    // ── Structure AWN_ compatible frontend actuel ────────────────
    // Le frontend index.html utilise ces champs — ne pas les supprimer
    AWN_marque:                   marque,
    AWN_modele:                   modele,
    AWN_date_mise_en_circulation: dateMEC,
    AWN_energie:                  energie,
    AWN_puissance_CH:             ch   || null,
    AWN_puissance_KW:             kw   || null,
    AWN_version:                  libelle,
    AWN_label:                    `${marque} ${modele}`.trim(),
    AWN_boite:                    '',   // non fourni par ces sources
    AWN_nb_portes:                null,
    AWN_passagers:                null,
    AWN_cylindres:                null,
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
    console.log(`[SIV] Mister-Auto OK pour ${plaque}`);
  } catch (e) {
    console.warn('[SIV] Mister-Auto échec:', e.message);
    errors.push('Mister-Auto: ' + e.message);
  }

  // Source 2 : Oscaro (si Mister-Auto a échoué)
  if (!result) {
    try {
      result = await lookupOscaro(plaque);
      console.log(`[SIV] Oscaro OK pour ${plaque}`);
    } catch (e) {
      console.warn('[SIV] Oscaro échec:', e.message);
      errors.push('Oscaro: ' + e.message);
    }
  }

  // Toutes les sources ont échoué
  if (!result) {
    console.error('[SIV] Toutes les sources ont échoué:', errors);
    return res.status(404).json({
      error:  'Véhicule non trouvé.',
      detail: errors.join(' | '),
    });
  }

  // Réponse — wrappé dans { data: ... } comme l'ancienne API RapidAPI
  return res.status(200).json({ data: result });
}