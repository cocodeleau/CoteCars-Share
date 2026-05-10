// api/rapid-api-requests.js
//
// SIV via apiplaqueimmatriculation.com
//
// Token de démo : TokenDemo2026B (limité — crée un compte sur
// apiplaqueimmatriculation.com pour obtenir ton token perso)
//
// Ajoute la variable d'env PLAQUE_API_TOKEN dans Vercel.
// Tant qu'elle n'est pas définie, le token de démo est utilisé.
//
// Reçoit : GET ?plaque=AB123CD
// Renvoie : { data: { AWN_marque, AWN_modele, ... } }

import fetch from 'node-fetch';

const API_URL   = 'https://api.apiplaqueimmatriculation.com/plaque';
const DEMO_TOKEN = 'TokenDemo2026B';

export default async function handler(req, res) {
  const plaque = (req.query.plaque || '').replace(/[-\s]/g, '').toUpperCase();

  if (!plaque || plaque.length < 5) {
    return res.status(400).json({ error: 'Plaque invalide.' });
  }

  const token = process.env.PLAQUE_API_TOKEN || DEMO_TOKEN;

  const url = `${API_URL}?immatriculation=${encodeURIComponent(plaque)}&token=${token}&pays=FR`;
  console.log(`[SIV] Appel pour ${plaque} (token: ${token === DEMO_TOKEN ? 'DEMO' : 'perso'})`);

  let json;
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Accept': 'application/json' },
    });

    const text = await response.text();
    console.log(`[SIV] HTTP ${response.status} | Réponse : ${text.slice(0, 500)}`);

    if (!response.ok) {
      return res.status(200).json({ error: `API erreur ${response.status}` });
    }

    json = JSON.parse(text);
  } catch (e) {
    console.error('[SIV] Erreur fetch :', e.message);
    return res.status(200).json({ error: 'API injoignable : ' + e.message });
  }

  // Vérification erreur dans la réponse
  const d = json.data || json;
  if (d.erreur && d.erreur !== '') {
    console.warn('[SIV] Erreur API :', d.erreur);
    return res.status(200).json({ error: d.erreur });
  }

  if (!d.marque) {
    console.warn('[SIV] Véhicule non trouvé — JSON :', JSON.stringify(json).slice(0, 300));
    return res.status(200).json({ error: 'Véhicule non trouvé.' });
  }

  // ── Extraction des champs ────────────────────────────────────────
  // Motorisation : sra_commercial contient "1.9 DCI 130 XV DE FRANCE"
  const libelle = (d.sra_commercial || d.variante || '').trim();

  // Puissance : puisFiscReel = "130 KW" → on convertit en CH
  const puissKW  = parseFloat((d.puisFiscReel || '').replace(/[^\d.]/g, '')) || null;
  const puissCH  = puissKW ? Math.round(puissKW * 1.36) : null;

  // Energie : energieNGC = "DIESEL" / "ESSENCE" / "ELECTRIQUE" / ...
  const energieRaw = (d.energieNGC || d.energie || '').toUpperCase();
  const energie    = energieRaw.includes('DIESEL') ? 'GAZOLE'
    : energieRaw.includes('ELECT')  ? 'ELECTRIQUE'
    : energieRaw.includes('HYBRID') ? 'HYBRIDE'
    : energieRaw.includes('GPL')    ? 'GPL'
    : 'ESSENCE';

  // Date de mise en circulation : date1erCir_fr = "18-04-2009"
  const dateMEC = (d.date1erCir_fr || '').replace(/-/g, '/') || '';
  const annee   = dateMEC.slice(-4) || '';

  const marque = (d.marque || '').toUpperCase().trim();
  const modele = (d.modele || '').trim();

  const result = {
    // Structure simple
    marque, modele,
    motorisation: libelle,
    puissance:    puissCH ? `${puissCH}ch` : '',
    annee,

    // Structure AWN_ compatible frontend
    AWN_marque:                   marque,
    AWN_modele:                   modele,
    AWN_date_mise_en_circulation: dateMEC,
    AWN_energie:                  energie,
    AWN_puissance_CH:             puissCH,
    AWN_puissance_KW:             puissKW,
    AWN_version:                  libelle,
    AWN_label:                    `${marque} ${modele}`.trim(),
    AWN_boite:                    d.boite_vitesse === 'A' ? 'Automatique' : d.boite_vitesse === 'M' ? 'Manuelle' : '',
    AWN_nb_portes:                parseInt(d.nb_portes) || null,
    AWN_passagers:                parseInt(d.nr_passagers) || null,
    AWN_cylindres:                parseInt(d.cylindres) || null,
    AWN_puissance_SUSPECT:        puissCH ? puissCH > 500 : false,
  };

  console.log(`[SIV] ✓ ${marque} ${modele} — ${puissCH}ch — ${energie}`);
  return res.status(200).json({ data: result });
}