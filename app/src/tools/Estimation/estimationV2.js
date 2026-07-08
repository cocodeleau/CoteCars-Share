import FINITION_ALIASES from '../../data/finition-aliases.json';
import { matchesVehicle, BAD_WORDS } from './estimation';

// ── Calculateur v2 (expérimental) ──
// Corrige 3 faiblesses identifiées dans le modèle v1 :
//  1. Bornes de km/année/puissance manquantes ou disproportionnées
//  2. Retrait d'outliers arbitraire (seuils ad hoc) → méthode IQR standard
//  3. Prix "demandé" affiché tel quel → correction vers un prix de vente probable
//  4. Aucun garde-fou sur la taille de l'échantillon

const MIN_SAMPLE = 5;
const ASKING_TO_SOLD_FACTOR = 0.92; // écart moyen observé entre prix affiché et prix de vente négocié

export function filterAdsV2(ads, kmUser, anneeUser, chUser, marque, modele, finition) {
  const kmTolerance = kmUser ? Math.min(40000, Math.max(15000, Math.round(kmUser * 0.2))) : 30000;
  const anneeMax = anneeUser ? anneeUser + 1 : null;
  const chMin = chUser ? Math.round(chUser * 0.85) : null;
  const chMax = chUser ? Math.round(chUser * 1.15) : null;

  return ads.filter(ad => {
    if (ad.owner?.type !== 'pro') return false;
    const subject = (ad.subject || '').toLowerCase();
    if (BAD_WORDS.some(w => subject.includes(w))) return false;
    const attrs = ad.attributes || [];
    const damage = attrs.find(x => x.key === 'vehicle_damage')?.value || '';
    if (['damaged', 'accident', 'breakdown'].some(d => damage.includes(d))) return false;
    if ((attrs.find(x => x.key === 'vehicle_specifications')?.values || []).includes('rental_vehicle')) return false;

    const kmAttr = attrs.find(x => x.key === 'mileage')?.value;
    if (kmAttr && kmUser && parseInt(kmAttr) > kmUser + kmTolerance) return false;

    const regAttr = attrs.find(x => x.key === 'regdate')?.value;
    if (regAttr && anneeUser) {
      const regYear = parseInt(regAttr);
      if (regYear < anneeUser - 1 || regYear > anneeMax) return false;
    }

    const chAttr = attrs.find(x => x.key === 'horse_power_din')?.value;
    if (chAttr && chMin && chMax) {
      const ch = parseInt(chAttr);
      if (ch < chMin || ch > chMax) return false;
    }

    if (marque && modele && !matchesVehicle(ad.subject, marque, modele)) return false;
    if (finition) {
      const aliases = FINITION_ALIASES[finition] || [finition.toLowerCase()];
      if (!aliases.some(a => subject.includes(a))) return false;
    }
    return true;
  });
}

function percentile(sortedArr, p) {
  const idx = Math.min(sortedArr.length - 1, Math.floor(sortedArr.length * p));
  return sortedArr[idx];
}

export function computeStatsV2(ads) {
  const prices = ads.map(a => a.price?.[0]).filter(p => p && p > 500 && p < 100000).sort((a, b) => a - b);
  if (!prices.length) return null;

  const q1 = percentile(prices, 0.25);
  const q3 = percentile(prices, 0.75);
  const iqr = q3 - q1;
  const lower = q1 - 1.5 * iqr;
  const upper = q3 + 1.5 * iqr;
  const filtered = prices.filter(p => p >= lower && p <= upper);
  if (!filtered.length) return null;

  const correct = v => Math.round(v * ASKING_TO_SOLD_FACTOR);

  return {
    pMin: correct(filtered[0]),
    p25: correct(percentile(filtered, 0.25)),
    p50: correct(percentile(filtered, 0.5)),
    count: filtered.length,
    lowSample: filtered.length < MIN_SAMPLE,
  };
}
