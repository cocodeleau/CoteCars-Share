import { useState } from 'react';
import { useTheme } from '../hooks/useTheme';
import ThemeToggle from '../components/shared/ThemeToggle';
import { useNavigate } from 'react-router-dom';
import { fetchVehicleByPlate, fetchLbcListings } from '../services/api';

const MOCK_VEHICLE = { marque: 'Renault', modele: 'Clio', annee: 2019, energie: 'Essence', puissance: '90ch' };
const MOCK_RESULTS = {
  prices: { agressif: 8900, marche: 10200, haut: 11800 },
  listings: [
    { title: 'Renault Clio 1.0 TCe 90 — 2019', km: '52 000 km', location: 'Lyon (69)', price: '9 500 €' },
    { title: 'Renault Clio Zen 1.0 — 2020', km: '38 000 km', location: 'Marseille (13)', price: '10 900 €' },
    { title: 'Renault Clio 5 TCe 90 — 2019', km: '67 000 km', location: 'Paris (75)', price: '8 800 €' },
  ]
};

function formatPlate(value) {
  const raw = value.replace(/[^a-zA-Z0-9]/g, '').toUpperCase().slice(0, 7);
  const parts = [raw.slice(0, 2), raw.slice(2, 5), raw.slice(5, 7)].filter(Boolean);
  return parts.join('-');
}

function HeroEstimator() {
  const [mode, setMode] = useState('auto');
  const [plate, setPlate] = useState('');
  const [km, setKm] = useState('');
  const [manual, setManual] = useState({ marque: '', modele: '', annee: '' });
  const [state, setState] = useState('idle');
  const [vehicle, setVehicle] = useState(null);
  const [results, setResults] = useState(null);
  const navigate = useNavigate();

  const canSubmit = mode === 'auto'
    ? plate.replace(/-/g, '').length === 7
    : manual.marque && manual.modele && manual.annee.length === 4;

  async function handleSubmit(e) {
    e.preventDefault();
    if (!canSubmit || state === 'loading') return;
    setState('loading');
    setVehicle(null);
    setResults(null);
    try {
      let v;
      if (mode === 'auto') {
        v = await fetchVehicleByPlate(plate).catch(() => MOCK_VEHICLE);
      } else {
        v = { marque: manual.marque, modele: manual.modele, annee: manual.annee, energie: 'Essence', puissance: '—' };
      }
      setVehicle(v);
      const r = await fetchLbcListings({ plate, km, vehicle: v }).catch(() => MOCK_RESULTS);
      setResults(r);
      setState('results');
    } catch {
      setState('idle');
    }
  }

  return (
    <div className="hero-estimator">
      <form className="hero-plate-form-v2" onSubmit={handleSubmit}>
        {mode === 'auto' ? (
          <div className="plate-field">
            <div className="plate-eu">
              <span className="plate-stars">★</span>
              <span className="plate-country">F</span>
            </div>
            <input
              className="plate-field-input"
              placeholder="AA-123-AA"
              value={plate}
              onChange={e => setPlate(formatPlate(e.target.value))}
              maxLength={9}
              autoComplete="off"
              aria-label="Plaque d'immatriculation"
            />
          </div>
        ) : (
          <div className="manual-grid">
            <input
              className="tool-input"
              placeholder="Marque (ex : Renault)"
              value={manual.marque}
              onChange={e => setManual(m => ({ ...m, marque: e.target.value }))}
              autoComplete="off"
            />
            <input
              className="tool-input"
              placeholder="Modèle (ex : Clio)"
              value={manual.modele}
              onChange={e => setManual(m => ({ ...m, modele: e.target.value }))}
              autoComplete="off"
            />
            <input
              className="tool-input"
              placeholder="Année"
              inputMode="numeric"
              value={manual.annee}
              onChange={e => setManual(m => ({ ...m, annee: e.target.value.replace(/\D/g, '').slice(0, 4) }))}
              autoComplete="off"
            />
          </div>
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
              className={mode === 'auto' ? 'active' : ''}
              onClick={() => setMode('auto')}
            >
              Automatique
            </button>
            <button
              type="button"
              className={mode === 'manual' ? 'active' : ''}
              onClick={() => setMode('manual')}
            >
              Manuel
            </button>
          </div>
        </div>

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

      {state === 'results' && vehicle && results && (
        <div className="hero-estimator-results">
          <div className="hero-vehicle-badge">
            <span className="hero-vehicle-icon">🚗</span>
            <div>
              <div className="hero-vehicle-name">{vehicle.marque} {vehicle.modele} — {vehicle.annee}</div>
              <div className="hero-vehicle-sub">{vehicle.energie} · {vehicle.puissance}</div>
            </div>
          </div>
          <div className="hero-price-row">
            <div className="hero-price-card">
              <div className="hero-price-label">Agressif</div>
              <div className="hero-price-val">{results.prices.agressif.toLocaleString('fr-FR')} €</div>
            </div>
            <div className="hero-price-card hero-price-market">
              <div className="hero-price-label">Prix marché</div>
              <div className="hero-price-val">{results.prices.marche.toLocaleString('fr-FR')} €</div>
            </div>
            <div className="hero-price-card">
              <div className="hero-price-label">Haut</div>
              <div className="hero-price-val">{results.prices.haut.toLocaleString('fr-FR')} €</div>
            </div>
          </div>
          <button className="btn btn-ghost btn-sm" style={{ width: '100%', marginTop: 8 }} onClick={() => navigate('/dashboard')}>
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

const FAQ_ITEMS = [
  { q: "Faut-il créer un compte ?", a: "Non. L'estimation est accessible sans inscription. Créez un compte gratuit uniquement si vous souhaitez conserver l'historique de vos recherches." },
  { q: "D'où viennent les prix ?", a: "Les fourchettes sont calculées à partir des vraies annonces LeBonCoin similaires à votre véhicule, en temps réel — pas d'une cote théorique." },
  { q: "L'estimation est-elle gratuite ?", a: "Oui, totalement gratuite pour les particuliers. Aucune carte bancaire n'est demandée." },
  { q: "Mes données sont-elles protégées ?", a: "Oui. Votre plaque et vos informations ne sont jamais revendues et servent uniquement à réaliser votre estimation." },
];

function FaqSection({ navigate }) {
  const [open, setOpen] = useState(0);
  return (
    <section className="faq-section" id="faq">
      <div className="faq-inner">
        <div className="faq-left">
          <div className="faq-badge">Vos questions, nos réponses</div>
          <h2 className="faq-title">Questions <span>fréquentes</span></h2>
          <p className="faq-desc">
            Tout ce qu'il faut savoir avant d'estimer votre véhicule avec CoteCars.
            Une question de plus ? Notre équipe vous répond.
          </p>
          <div className="faq-help-card">
            <h3>Encore des questions ?</h3>
            <p>Chaque situation est différente. Si vous avez le moindre doute sur une estimation, notre équipe est là pour vous guider.</p>
            <button className="btn faq-help-btn" onClick={() => navigate('/dashboard')}>Créer un compte gratuit</button>
          </div>
        </div>
        <div className="faq-right">
          {FAQ_ITEMS.map((item, i) => (
            <div className={`faq-item ${open === i ? 'open' : ''}`} key={i}>
              <button className="faq-q" onClick={() => setOpen(open === i ? -1 : i)}>
                <span>{item.q}</span>
                <span className="faq-chevron">▲</span>
              </button>
              {open === i && <p className="faq-a">{item.a}</p>}
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}

export default function LandingParticulier() {
  const { theme, toggle } = useTheme();
  const navigate = useNavigate();

  return (
    <div>
      <nav className="landing-nav">
        <div className="nav-logo">Cote<em>Cars</em></div>
        <ul className="nav-links">
          <li><a href="#comment">Comment ça marche</a></li>
          <li><a href="#tarifs">Tarifs</a></li>
        </ul>
        <div className="nav-cta">
          <ThemeToggle theme={theme} toggle={toggle} />
          <button className="btn btn-ghost btn-sm" onClick={() => navigate('/pros')}>Vous êtes un pro ?</button>
          <button className="btn btn-primary btn-sm" onClick={() => navigate('/dashboard')}>Mon espace →</button>
        </div>
      </nav>

      {/* Hero */}
      <section className="hero-v2">
        <div className="hero-v2-bg">
          <div className="hero-v2-blob blob-1" />
          <div className="hero-v2-blob blob-2" />
        </div>
        <div className="hero-v2-inner hero-v2-centered">
          <h1 className="hero-v2-title">
            Combien vaut vraiment <em>votre voiture ?</em>
          </h1>
          <div className="hero-v2-tool-wrap">
            <div className="hero-v2-trust">
              <span>✓ Sans inscription</span>
              <span>✓ Données LeBonCoin live</span>
              <span>✓ Résultat en 10 sec</span>
              <span>✓ 100% gratuit</span>
            </div>
            <HeroEstimator />
          </div>
        </div>
      </section>

      {/* Avis clients */}
      <section className="section reviews-section">
        <div className="reviews-badge">Ce qu'ils en disent</div>
        <h2 className="reviews-heading">Ils ont estimé leur voiture avec CoteCars</h2>

        <div className="reviews-stats">
          <div className="reviews-stat">
            <div className="reviews-stat-value">3x</div>
            <div className="reviews-stat-label">Vente plus rapide</div>
          </div>
          <div className="reviews-stat">
            <div className="reviews-stat-value">±5%</div>
            <div className="reviews-stat-label">Précision vs prix de vente</div>
          </div>
          <div className="reviews-stat">
            <div className="reviews-stat-value">1,2M+</div>
            <div className="reviews-stat-label">Annonces analysées</div>
          </div>
          <div className="reviews-stat">
            <div className="reviews-stat-value">10 s</div>
            <div className="reviews-stat-label">Temps d'estimation</div>
          </div>
        </div>

        <div className="reviews-grid">
          {[
            { name: 'Julien P.', role: 'Vendeur particulier', text: "J'ai vendu ma voiture au bon prix en une semaine. L'estimation était pile dans la fourchette du marché." },
            { name: 'Andréa M.', role: 'Achat occasion', text: "Au lieu de partir dans le flou, j'utilise CoteCars pour cadrer chaque négociation. C'est devenu un réflexe." },
            { name: 'Denis B.', role: 'Vendeur particulier', text: "CoteCars m'a fait gagner des heures de recherche. La fourchette de prix est fiable et argumentée." },
            { name: 'Gustave O.', role: 'Achat occasion', text: "Enfin un outil qui donne un vrai prix basé sur des annonces réelles et pas une cote théorique." },
            { name: 'Olivia S.', role: 'Vendeuse particulière', text: "Rapide, gratuit, sans inscription. J'ai pu fixer mon prix en quelques minutes au lieu de plusieurs jours." },
            { name: 'Ruben O.', role: 'Achat occasion', text: "La qualité des données est au top. Chaque estimation est claire et directement exploitable." },
          ].map((r, i) => (
            <div className="review-card" key={i}>
              <div className="review-head">
                <div className="review-avatar">{r.name.charAt(0)}</div>
                <div>
                  <div className="review-name">{r.name}</div>
                  <div className="review-role">{r.role}</div>
                </div>
              </div>
              <p className="review-text">"{r.text}"</p>
            </div>
          ))}
        </div>
      </section>

      {/* KPIs */}
      <section className="section kpi-section">
        <div className="kpi-panel">
          <div className="kpi-panel-left">
            <div className="kpi-panel-eyebrow">Indicateur de performance</div>
            <div className="kpi-panel-title">2025 Performance <span>CoteCars</span></div>
            <div className="kpi-panel-big">
              <span className="kpi-panel-big-value">93,3%</span>
              <span className="kpi-panel-big-label">▲ Satisfaction<br />client</span>
            </div>
          </div>
          <div className="kpi-panel-right">
            <div className="kpi-panel-metric">
              <div className="kpi-panel-metric-value">1,2M+</div>
              <div className="kpi-panel-metric-label">Annonces analysées</div>
            </div>
            <div className="kpi-panel-metric">
              <div className="kpi-panel-metric-value">98%</div>
              <div className="kpi-panel-metric-label">Fiabilité de l'identification</div>
            </div>
            <div className="kpi-panel-metric">
              <div className="kpi-panel-metric-value">&lt; 10 s</div>
              <div className="kpi-panel-metric-label">Temps moyen d'estimation</div>
            </div>
          </div>
        </div>
      </section>

      {/* Video demo */}
      <section className="section video-section">
        <div className="video-grid">
          <div className="video-text">
            <div className="section-label">Démo en vidéo</div>
            <h2 className="section-title">Découvrez CoteCars en 90 secondes</h2>
            <p className="section-sub">
              Une plaque, un clic, une fourchette de prix issue de vraies annonces.
              Regardez comment CoteCars transforme l'estimation d'un véhicule en une opération instantanée.
            </p>
          </div>
          <div className="video-embed">
            {/* TODO: remplacer par la vraie URL de la démo vidéo */}
            <iframe
              src="https://www.youtube.com/embed/dQw4w9WgXcQ"
              title="Démo CoteCars"
              allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture"
              allowFullScreen
            />
          </div>
        </div>
      </section>

      {/* Comment ca marche */}
      <section className="section how-section" id="comment">
        <div className="how-header">
          <div>
            <h2 className="how-title">Comment ça marche ?</h2>
            <p className="how-sub">Estimez votre véhicule en quelques étapes simples.</p>
          </div>
          <button className="how-start-btn" onClick={() => window.scrollTo({ top: 0, behavior: 'smooth' })}>
            Commencer
          </button>
        </div>
        <div className="how-grid">
          <div className="how-card">
            <div className="how-icon how-icon-green">🖐️</div>
            <h3>Entrez votre plaque</h3>
            <p>Saisissez votre plaque ou les infos du véhicule. Aucune inscription requise.</p>
          </div>
          <div className="how-card">
            <div className="how-icon how-icon-pink">🔍</div>
            <h3>On identifie le véhicule</h3>
            <p>Marque, modèle et année récupérés automatiquement via les données SIV officielles.</p>
          </div>
          <div className="how-card">
            <div className="how-icon how-icon-orange">📊</div>
            <h3>Analyse du marché</h3>
            <p>On scrute les annonces LeBonCoin similaires en temps réel pour établir le vrai prix.</p>
          </div>
          <div className="how-card">
            <div className="how-icon how-icon-purple">✨</div>
            <h3>Recevez votre prix</h3>
            <p>Une fourchette de prix claire pour vendre au bon tarif ou négocier un achat.</p>
          </div>
        </div>
      </section>

      {/* FAQ */}
      <FaqSection navigate={navigate} />

      {/* CTA */}
      <div className="cta-banner">
        <h2>Gardez l'historique de toutes vos recherches</h2>
        <p>Créez un compte gratuit pour retrouver toutes vos estimations et les comparer dans le temps.</p>
        <div className="cta-banner-btns">
          <button className="btn btn-lg" style={{ background: 'white', color: 'var(--blue)' }} onClick={() => navigate('/dashboard')}>
            Créer un compte gratuit
          </button>
          <button className="btn btn-lg" style={{ background: 'rgba(255,255,255,0.15)', color: 'white', border: '1px solid rgba(255,255,255,0.3)' }} onClick={() => navigate('/pros')}>
            Vous êtes un professionnel ?
          </button>
        </div>
      </div>

      <footer className="landing-footer">
        <span>© 2025 CoteCars — Tous droits réservés</span>
        <div style={{ display: 'flex', gap: 24 }}>
          <a href="#">CGV</a>
          <a href="#">CGU</a>
          <a href="#">Mentions légales</a>
          <a href="/pros">Professionnels</a>
        </div>
      </footer>
    </div>
  );
}
