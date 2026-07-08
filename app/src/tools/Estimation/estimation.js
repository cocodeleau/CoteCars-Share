import FINITIONS from '../../data/finitions.json';
import FINITION_ALIASES from '../../data/finition-aliases.json';

export const FUEL_CODES = {
  ESSENCE: '1',
  GAZOLE: '2',
  GPL: '3',
  ELECTRIQUE: '4',
  HYBRIDE: '6',
  'HYBRIDE ESSENCE ELECTRIQUE': '6',
  'HYBRIDE RECHARGEABLE': '6',
  'HYBRIDE DIESEL ELECTRIQUE': '6',
};

export function fuelCodeFromEnergie(energieRaw) {
  const raw = (energieRaw || '').toUpperCase();
  if (FUEL_CODES[raw]) return FUEL_CODES[raw];
  if (raw.includes('HYBRIDE')) return '6';
  if (raw.includes('ELECTR')) return '4';
  return '';
}

export function getFinitions(marque, modele) {
  if (!marque || !modele) return [];
  const m = (marque || '').replace(/B\.M\.W\./g, 'BMW').replace(/MERCEDES.*/i, 'MERCEDES-BENZ').trim();
  const mod = (modele || '').trim();
  const key = `${m}_${mod}`;
  if (FINITIONS[key]) return FINITIONS[key];
  const keyLower = key.toLowerCase();
  const found = Object.keys(FINITIONS).find(k => k.toLowerCase() === keyLower);
  if (found) return FINITIONS[found];
  return [];
}

export function normalize(str) {
  return (str || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[-_]/g, ' ').trim();
}

const MARQUE_ALIASES = {
  mercedes: ['mercedes', 'mercedes-benz', 'mercedes benz'],
  'mercedes-benz': ['mercedes', 'mercedes-benz', 'mercedes benz'],
  volkswagen: ['volkswagen', 'vw'],
  citroen: ['citroen', 'citroën'],
  'alfa romeo': ['alfa romeo', 'alfa'],
  'b.m.w.': ['bmw', 'b.m.w'],
  bmw: ['bmw', 'b.m.w'],
};

const MODELE_ALIASES = {
  'xcee d': ['xceed', 'xcee-d', 'x ceed'],
  'xcee-d': ['xceed', 'xcee-d', 'x ceed'],
  'l cruiser': ['land cruiser', 'landcruiser'],
  'l.cruiser': ['land cruiser', 'landcruiser'],
  'discov sp': ['discovery sport', 'discovery'],
  'discov.sp': ['discovery sport', 'discovery'],
  'c3 aircr': ['c3 aircross', 'aircross'],
  'c3 aircr.': ['c3 aircross', 'aircross'],
  'subaru xv': ['xv', 'xcross'],
};

export function matchesVehicle(subject, marque, modele) {
  const s = normalize(subject);
  const marqueNorm = normalize(marque);
  const modeleNormForAlias = normalize(modele);
  const modeleSearchTerms = MODELE_ALIASES[modeleNormForAlias] || null;
  const marqueAliases = MARQUE_ALIASES[marqueNorm] || [marqueNorm];
  if (!marqueAliases.some(a => s.includes(a))) return false;
  const modeleNorm = normalize(modele);
  const mercedesMatch = modeleNorm.match(/classe\s+(\w+)/);
  if (mercedesMatch) return s.includes(mercedesMatch[1].toLowerCase());
  const bmwSerieMatch = modeleNorm.match(/serie\s+(\d+)/);
  if (bmwSerieMatch) {
    const num = bmwSerieMatch[1];
    return s.includes(`serie ${num}`) || s.includes(`série ${num}`) || s.includes(`series ${num}`);
  }
  if (modeleSearchTerms) return modeleSearchTerms.some(term => s.includes(term));
  return modeleNorm.split(' ').filter(w => w.length > 1).every(mot => s.includes(mot));
}

export const BAD_WORDS = [
  'accident', 'accidenté', 'accidente', 'export', 'marchand', 'épave', 'epave', 'panne',
  'cassé', 'casse', '2 places', '2places', 'societe', 'société', 'societé', 'sociéte',
  'utilitaire', 'business', ' ste ', 'ste ', 's.t.e', 'retour de vol', 'retour vol',
  'volé', 'vole', 'stolen', 'sinistre',
];

export function filterAds(ads, kmUser, anneeUser, chUser, marque, modele, finition) {
  return ads.filter(ad => {
    if (ad.owner?.type !== 'pro') return false;
    const subject = (ad.subject || '').toLowerCase();
    if (BAD_WORDS.some(w => subject.includes(w))) return false;
    const attrs = ad.attributes || [];
    const damage = attrs.find(x => x.key === 'vehicle_damage')?.value || '';
    if (['damaged', 'accident', 'breakdown'].some(d => damage.includes(d))) return false;
    if ((attrs.find(x => x.key === 'vehicle_specifications')?.values || []).includes('rental_vehicle')) return false;
    const kmAttr = attrs.find(x => x.key === 'mileage')?.value;
    if (kmAttr && kmUser && parseInt(kmAttr) > kmUser + 30000) return false;
    const regAttr = attrs.find(x => x.key === 'regdate')?.value;
    if (regAttr && anneeUser && parseInt(regAttr) < anneeUser - 1) return false;
    if (marque && modele && !matchesVehicle(ad.subject, marque, modele)) return false;
    if (finition) {
      const aliases = FINITION_ALIASES[finition] || [finition.toLowerCase()];
      const subjectLow = (ad.subject || '').toLowerCase();
      if (!aliases.some(a => subjectLow.includes(a))) return false;
    }
    return true;
  });
}

export function computeStats(ads) {
  const prices = ads.map(a => a.price?.[0]).filter(p => p && p > 500 && p < 100000);
  if (!prices.length) return null;
  prices.sort((a, b) => a - b);
  const medianRaw = prices[Math.floor(prices.length * 0.50)];
  const avg = Math.round(prices.reduce((s, p) => s + p, 0) / prices.length);
  const filtered = prices.filter(p => p >= medianRaw * 0.6 && p <= avg * 1.5);
  if (!filtered.length) return null;
  return {
    pMin: filtered[0],
    p25: filtered[Math.floor(filtered.length * 0.25)],
    p50: filtered[Math.floor(filtered.length * 0.50)],
    count: filtered.length,
  };
}
