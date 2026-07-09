import { useState } from 'react';
import { fetchVehicleByPlate, fetchLbcListings } from '../../services/api';
import { getFinitions, fuelCodeFromEnergie } from './estimation';
import { filterAdsV2WithFallback, computeStatsV2 } from './estimationV2';

// ── Calculateur v2 (expérimental) — méthodologie améliorée, en comparaison directe ──
const TEST_PREFILL = { plate: 'DP-607-LQ', km: '200000', gearbox: '1' };

function formatPlate(value) {
  const raw = value.replace(/[^a-zA-Z0-9]/g, '').toUpperCase().slice(0, 7);
  const parts = [raw.slice(0, 2), raw.slice(2, 5), raw.slice(5, 7)].filter(Boolean);
  return parts.join('-');
}

export default function EstimationToolV2() {
  const [plate, setPlate] = useState(TEST_PREFILL.plate);
  const [km, setKm] = useState(TEST_PREFILL.km);
  const [gearbox, setGearbox] = useState(TEST_PREFILL.gearbox);
  const [finition, setFinition] = useState('');
  const [finitionsList, setFinitionsList] = useState([]);
  const [state, setState] = useState('idle');
  const [err, setErr] = useState('');
  const [result, setResult] = useState(null);

  const canSubmit = plate.replace(/-/g, '').length === 7 && !!gearbox;

  async function handlePlateChange(val) {
    const formatted = formatPlate(val);
    setPlate(formatted);
    setFinition('');
    setFinitionsList([]);
    const clean = formatted.replace(/-/g, '');
    if (clean.length === 7) {
      try {
        const json = await fetchVehicleByPlate(formatted);
        const veh = json.data;
        if (!json.error && veh?.AWN_marque) {
          setFinitionsList(getFinitions(veh.marque, veh.modele));
        }
      } catch { /* aperçu optionnel */ }
    }
  }

  async function handleSubmit(e) {
    e.preventDefault();
    if (!canSubmit || state === 'loading') return;
    setErr('');
    setState('loading');
    setResult(null);
    try {
      const sivJson = await fetchVehicleByPlate(plate);
      const veh = sivJson.data;
      if (sivJson.error || !veh?.AWN_marque) {
        throw new Error(sivJson.error || 'Véhicule non identifié');
      }
      const kmUser = km ? parseInt(km) : null;
      const anneeUser = veh.annee ? parseInt(veh.annee) : null;
      const chUser = veh.AWN_puissance_CH || null;
      const fuelCode = fuelCodeFromEnergie(veh.AWN_energie);

      const lbcJson = await fetchLbcListings({
        marque: veh.marque,
        modele: veh.modele,
        km: kmUser || undefined,
        annee: anneeUser || undefined,
        ch: chUser || undefined,
        fuel: fuelCode || undefined,
        gearbox,
        finition: finition || undefined,
      });
      if (lbcJson.error) throw new Error(lbcJson.error);

      const { ads, tier } = filterAdsV2WithFallback(lbcJson.ads || [], kmUser, anneeUser, chUser, veh.marque, veh.modele, finition);
      const stats = computeStatsV2(ads);
      setResult({ veh, stats, tier });
      setState('results');
    } catch (e) {
      setErr(e.message || 'Erreur inattendue');
      setState('idle');
    }
  }

  return (
    <div className="hero-estimator tool-theme-red">
      <div className="tool-v2-badge">🧪 Calculateur v2 — méthodologie améliorée (test)</div>

      <form className="hero-plate-form-v2" onSubmit={handleSubmit}>
        <div className="plate-field">
          <div className="plate-eu">
            <span className="plate-stars">★</span>
            <span className="plate-country">F</span>
          </div>
          <input
            className="plate-field-input"
            placeholder="AA-123-AA"
            value={plate}
            onChange={e => handlePlateChange(e.target.value)}
            maxLength={9}
            autoComplete="off"
            aria-label="Plaque d'immatriculation"
          />
        </div>

        {finitionsList.length > 0 && (
          <div className="tool-field-group">
            <label className="tool-field-label">Finition</label>
            <select className="tool-input" value={finition} onChange={e => setFinition(e.target.value)} aria-label="Finition">
              <option value="">Toutes finitions</option>
              {finitionsList.map(f => <option key={f} value={f}>{f}</option>)}
            </select>
          </div>
        )}

        <div className="tool-row">
          <div className="tool-field-group">
            <label className="tool-field-label">Kilométrage actuel</label>
            <div className="km-field">
              <input
                className="tool-input"
                placeholder="Kilométrage"
                inputMode="numeric"
                value={km}
                onChange={e => setKm(e.target.value.replace(/\D/g, '').slice(0, 7))}
                autoComplete="off"
                aria-label="Kilométrage"
              />
              <span className="km-suffix">km</span>
            </div>
          </div>
          <div className="tool-field-group">
            <label className="tool-field-label">Type de boîte</label>
            <div className="tool-mode-toggle">
              <button type="button" className={gearbox === '2' ? 'active' : ''} onClick={() => setGearbox('2')}>Automatique</button>
              <button type="button" className={gearbox === '1' ? 'active' : ''} onClick={() => setGearbox('1')}>Manuelle</button>
            </div>
          </div>
        </div>

        {err && <div style={{ color: 'var(--fuchsia)', fontSize: '0.85rem' }}>{err}</div>}

        <button className="btn btn-primary" type="submit" style={{ width: '100%', justifyContent: 'center' }} disabled={!canSubmit || state === 'loading'}>
          {state === 'loading' ? (<><span className="spinner-sm" /> Analyse…</>) : 'Estimer (v2) →'}
        </button>
      </form>

      {state === 'loading' && (
        <div className="hero-estimator-loading">
          <div className="spinner" />
          <span>Analyse avec la méthodologie v2 en cours…</span>
        </div>
      )}

      {state === 'results' && result && (
        <div className="hero-estimator-results">
          <div className="hero-vehicle-badge">
            <div className="hero-vehicle-info">
              <div className="hero-vehicle-name">{result.veh.marque} {result.veh.modele} — {result.veh.annee}</div>
              <div className="hero-vehicle-specs">
                {result.veh.motorisation && <span><strong>Motorisation :</strong> {result.veh.motorisation}</span>}
                {result.veh.puissance && <span><strong>Puissance :</strong> {result.veh.puissance}</span>}
              </div>
            </div>
          </div>

          {result.tier === 1 && (
            <div className="tool-v2-warning">
              🔍 Critères stricts insuffisants — recherche élargie (année ±2, puissance ±25%, finition ignorée)
            </div>
          )}
          {result.tier === 2 && (
            <div className="tool-v2-warning">
              🔍 Encore insuffisant — palier de secours activé (pas de plafond d'année, comme le calculateur bleu). Résultat à interpréter avec prudence.
            </div>
          )}

          {result.stats ? (
            <>
              {result.stats.lowSample && (
                <div className="tool-v2-warning">
                  ⚠️ Échantillon faible ({result.stats.count} annonce{result.stats.count > 1 ? 's' : ''}) — précision limitée
                </div>
              )}
              <div className="hero-price-row">
                {[
                  { key: 'pMin', label: 'Agressif' },
                  { key: 'p25', label: 'Prix marché' },
                  { key: 'p50', label: 'Haut' },
                ].map(({ key, label }) => (
                  <div key={key} className={`hero-price-card ${key === 'p25' ? 'hero-price-market' : ''}`}>
                    <div className="hero-price-label">{label}</div>
                    <div className="hero-price-val">{result.stats[key].toLocaleString('fr-FR')} €</div>
                  </div>
                ))}
              </div>
              <div className="tool-v2-note">
                {result.stats.count} annonce{result.stats.count > 1 ? 's' : ''} analysée{result.stats.count > 1 ? 's' : ''} ·
                outliers retirés (méthode IQR) · prix ajusté -8% (écart annonce → vente probable)
              </div>
            </>
          ) : (
            <div style={{ fontSize: '0.85rem', color: 'var(--text-muted)' }}>
              Vraiment aucune annonce comparable trouvée, même après élargissement des critères.
            </div>
          )}
        </div>
      )}
    </div>
  );
}
