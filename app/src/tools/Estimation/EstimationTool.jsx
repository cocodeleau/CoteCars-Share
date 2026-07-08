import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { fetchVehicleByPlate, fetchLbcListings } from '../../services/api';
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

export default function EstimationTool({ dashboardPath = '/dashboard' }) {
  const [plate, setPlate] = useState('');
  const [km, setKm] = useState('');
  const [gearbox, setGearbox] = useState('2');
  const [finition, setFinition] = useState('');
  const [finitionsList, setFinitionsList] = useState([]);
  const [state, setState] = useState('idle');
  const [err, setErr] = useState('');
  const [vehicle, setVehicle] = useState(null);
  const [result, setResult] = useState(null);
  const [chosenPrice, setChosenPrice] = useState(null);
  const [showCount, setShowCount] = useState(4);
  const navigate = useNavigate();

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

      {state === 'loading' && (
        <div className="hero-estimator-loading">
          <div className="spinner" />
          <span>Analyse des annonces LeBonCoin en cours…</span>
        </div>
      )}

      {state === 'results' && result && (
        <div className="hero-estimator-results">
          <div className="hero-vehicle-badge">
            <span className="hero-vehicle-icon">🚗</span>
            <div>
              <div className="hero-vehicle-name">{result.veh.marque} {result.veh.modele} — {result.veh.annee}</div>
              <div className="hero-vehicle-sub">{result.veh.AWN_energie} · {result.veh.puissance}{result.veh.AWN_boite ? ` · ${result.veh.AWN_boite}` : ''}</div>
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
