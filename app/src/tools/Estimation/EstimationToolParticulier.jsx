import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { fetchVehicleByPlate, fetchLbcListings, checkEstimationUsage, consumeEstimationUsage } from '../../services/api';
import { getFinitions, fuelCodeFromEnergie, filterAds, computeStats } from './estimation';

function formatPlate(value) {
  const raw = value.replace(/[^a-zA-Z0-9]/g, '').toUpperCase().slice(0, 7);
  const parts = [raw.slice(0, 2), raw.slice(2, 5), raw.slice(5, 7)].filter(Boolean);
  return parts.join('-');
}

function adKm(ad) {
  const val = (ad.attributes || []).find(a => a.key === 'mileage')?.value;
  return val ? `${parseInt(val).toLocaleString('fr-FR')} km` : null;
}

// ── TEST TEMPORAIRE — à retirer (demander à Corentin quand faire sauter) ──
const TEST_PREFILL = { plate: 'DP-607-LQ', km: '200000', gearbox: '1' };
const TEST_BYPASS_RATE_LIMIT = true;

export default function EstimationToolParticulier({ dashboardPath = '/dashboard' }) {
  const [plate, setPlate] = useState(TEST_PREFILL.plate);
  const [km, setKm] = useState(TEST_PREFILL.km);
  const [gearbox, setGearbox] = useState(TEST_PREFILL.gearbox);
  const [finition, setFinition] = useState('');
  const [finitionsList, setFinitionsList] = useState([]);
  const [state, setState] = useState('idle');
  const [err, setErr] = useState('');
  const [vehicle, setVehicle] = useState(null);
  const [result, setResult] = useState(null);
  const [chosenPrice, setChosenPrice] = useState(null);
  const [showCount, setShowCount] = useState(4);
  const [usage, setUsage] = useState(null);
  const navigate = useNavigate();

  useEffect(() => {
    if (TEST_BYPASS_RATE_LIMIT) return;
    checkEstimationUsage().then(setUsage).catch(() => setUsage({ remaining: 1 }));
  }, []);

  const locked = !TEST_BYPASS_RATE_LIMIT && usage && usage.remaining <= 0 && state !== 'results' && state !== 'loading';
  const canSubmit = plate.replace(/-/g, '').length === 7 && !!gearbox;

  async function handlePlateChange(val) {
    const formatted = formatPlate(val);
    setPlate(formatted);
    setFinition('');
    setFinitionsList([]);
    setVehicle(null);
    const clean = formatted.replace(/-/g, '');
    if (clean.length === 7) {
      try {
        const json = await fetchVehicleByPlate(formatted);
        const veh = json.data;
        if (!json.error && veh?.AWN_marque) {
          setFinitionsList(getFinitions(veh.marque, veh.modele));
          setVehicle({ marque: veh.marque, modele: veh.modele });
        }
      } catch { /* aperçu optionnel, on ignore les erreurs silencieusement */ }
    }
  }

  async function handleSubmit(e) {
    e.preventDefault();
    if (!canSubmit || state === 'loading') return;
    setErr('');
    setState('loading');
    setResult(null);
    try {
      if (!TEST_BYPASS_RATE_LIMIT) {
        const usageResult = await consumeEstimationUsage();
        setUsage({ remaining: usageResult.remaining });
        if (!usageResult.allowed) {
          setState('idle');
          return;
        }
      }

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

      const ads = filterAds(lbcJson.ads || [], kmUser, anneeUser, chUser, veh.marque, veh.modele, finition);
      const stats = computeStats(ads);
      setResult({ veh, ads, stats });
      setChosenPrice(stats?.p25 ?? null);
      setShowCount(4);
      setState('results');
    } catch (e) {
      setErr(e.message || 'Erreur inattendue');
      setState('idle');
    }
  }

  const allAds = result
    ? [...result.ads].filter(a => a.price?.[0] > 500).sort((a, b) => a.price[0] - b.price[0])
    : [];
  const medianAds = allAds.map(a => a.price[0]).sort((a, b) => a - b)[Math.floor(allAds.length * 0.5)] || 0;
  const cleanAds = allAds.filter(a => a.price[0] >= medianAds * 0.6);
  const visibleAds = cleanAds.slice(0, showCount);

  return (
    <div className="hero-estimator">
      {locked ? (
        <div className="hero-estimator-paywall">
          <div className="hero-estimator-paywall-icon">🔒</div>
          <h3>Estimation gratuite du jour utilisée</h3>
          <p>Revenez demain pour un nouvel essai gratuit, ou créez un compte pour des estimations illimitées dès maintenant.</p>
          <button className="btn btn-primary" style={{ width: '100%', justifyContent: 'center' }} onClick={() => navigate(dashboardPath)}>
            Créer un compte gratuit →
          </button>
        </div>
      ) : (
      <form className="hero-plate-form-v2" onSubmit={handleSubmit}>
        {usage && usage.remaining > 0 && (
          <div className="hero-estimator-quota">
            🎁 {usage.remaining} essai{usage.remaining > 1 ? 's' : ''} gratuit{usage.remaining > 1 ? 's' : ''} restant{usage.remaining > 1 ? 's' : ''} aujourd'hui
          </div>
        )}
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
          <select
            className="tool-input"
            value={finition}
            onChange={e => setFinition(e.target.value)}
            aria-label="Finition"
          >
            <option value="">Toutes finitions {vehicle ? `(${vehicle.marque} ${vehicle.modele})` : ''}</option>
            {finitionsList.map(f => (
              <option key={f} value={f}>{f}</option>
            ))}
          </select>
        )}

        <div className="tool-row">
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
          <div className="tool-mode-toggle">
            <button
              type="button"
              className={gearbox === '2' ? 'active' : ''}
              onClick={() => setGearbox('2')}
            >
              Automatique
            </button>
            <button
              type="button"
              className={gearbox === '1' ? 'active' : ''}
              onClick={() => setGearbox('1')}
            >
              Manuelle
            </button>
          </div>
        </div>

        {err && <div style={{ color: 'var(--fuchsia)', fontSize: '0.85rem' }}>{err}</div>}

        <button className="btn btn-primary" type="submit" style={{ width: '100%', justifyContent: 'center' }} disabled={!canSubmit || state === 'loading'}>
          {state === 'loading' ? (
            <><span className="spinner-sm" /> Analyse…</>
          ) : 'Estimer ma voiture →'}
        </button>
      </form>
      )}

      {state === 'loading' && (
        <div className="hero-estimator-loading">
          <div className="spinner" />
          <span>Analyse des annonces LeBonCoin en cours…</span>
        </div>
      )}

      {state === 'results' && result && (
        <div className="hero-estimator-results">
          <div className="hero-vehicle-badge">
            {result.veh.AWN_photo_modele ? (
              <img
                className="hero-vehicle-photo"
                src={result.veh.AWN_photo_modele}
                alt={`${result.veh.marque} ${result.veh.modele}`}
              />
            ) : (
              <span className="hero-vehicle-icon">🚗</span>
            )}
            <div>
              <div className="hero-vehicle-name">{result.veh.marque} {result.veh.modele} — {result.veh.annee}</div>
              <div className="hero-vehicle-sub">{result.veh.AWN_energie} · {result.veh.puissance}{result.veh.AWN_boite ? ` · ${result.veh.AWN_boite}` : ''}{result.veh.AWN_couleur ? ` · ${result.veh.AWN_couleur}` : ''}</div>
            </div>
          </div>

          {result.stats ? (
            <>
              <div className="hero-price-row">
                {[
                  { key: 'pMin', label: 'Agressif' },
                  { key: 'p25', label: 'Prix marché' },
                  { key: 'p50', label: 'Haut' },
                ].map(({ key, label }) => (
                  <button
                    key={key}
                    type="button"
                    className={`hero-price-card ${key === 'p25' ? 'hero-price-market' : ''} ${chosenPrice === result.stats[key] ? 'hero-price-chosen' : ''}`}
                    onClick={() => setChosenPrice(result.stats[key])}
                  >
                    <div className="hero-price-label">{label}</div>
                    <div className="hero-price-val">{result.stats[key].toLocaleString('fr-FR')} €</div>
                  </button>
                ))}
              </div>

              {visibleAds.length > 0 && (
                <div>
                  <div className="listings-header">{cleanAds.length} annonces similaires</div>
                  <div className="listings-grid">
                    {visibleAds.map((ad, i) => (
                      <a className="listing-item" href={ad.url} target="_blank" rel="noopener noreferrer" key={i}>
                        <span className="listing-title">{ad.subject}</span>
                        {adKm(ad) && <span className="listing-meta">{adKm(ad)}</span>}
                        <span className="listing-price">{ad.price[0].toLocaleString('fr-FR')} €</span>
                      </a>
                    ))}
                  </div>
                  {showCount < cleanAds.length && (
                    <button type="button" className="btn btn-ghost btn-sm" style={{ width: '100%', marginTop: 8 }} onClick={() => setShowCount(c => c + 4)}>
                      Voir plus d'annonces
                    </button>
                  )}
                </div>
              )}
            </>
          ) : (
            <div style={{ fontSize: '0.85rem', color: 'var(--text-muted)' }}>
              Pas assez d'annonces comparables trouvées pour ce véhicule.
            </div>
          )}

          <button className="btn btn-ghost btn-sm" style={{ width: '100%', marginTop: 8 }} onClick={() => navigate(dashboardPath)}>
            Voir le détail complet + historique →
          </button>
        </div>
      )}

      <div className="tool-pills">
        <span className="tool-pill">⚡ Instantané</span>
        <span className="tool-pill">🎯 Prix précis</span>
        <span className="tool-pill">🔒 Privé</span>
        <span className="tool-pill">✅ Gratuit</span>
      </div>
    </div>
  );
}
