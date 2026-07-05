import { useNavigate } from 'react-router-dom';
import { useTheme } from '../hooks/useTheme';
import ThemeToggle from '../components/shared/ThemeToggle';

export default function LandingPro() {
  const { theme, toggle } = useTheme();
  const navigate = useNavigate();

  return (
    <div>
      <nav className="landing-nav">
        <div className="nav-logo">Cote<em>Cars</em> <span style={{ fontSize: '0.7rem', color: 'var(--text-muted)', marginLeft: 4 }}>Pro</span></div>
        <ul className="nav-links">
          <li><a href="#features">Fonctionnalités</a></li>
          <li><a href="#tarifs">Tarifs</a></li>
        </ul>
        <div className="nav-cta">
          <ThemeToggle theme={theme} toggle={toggle} />
          <button className="btn btn-ghost btn-sm" onClick={() => navigate('/')}>Particulier ?</button>
          <button className="btn btn-primary btn-sm" onClick={() => navigate('/pro/dashboard')}>Espace pro →</button>
        </div>
      </nav>

      <section className="hero" style={{ textAlign: 'center', gridTemplateColumns: '1fr' }}>
        <div>
          <h1>L'outil d'estimation <em>pour les pros</em></h1>
          <p>Estimez, photographiez et publiez vos véhicules en quelques clics. Conçu pour les professionnels de l'automobile.</p>
          <div className="hero-cta" style={{ justifyContent: 'center' }}>
            <button className="btn btn-primary btn-lg" onClick={() => navigate('/pro/dashboard')}>Commencer gratuitement →</button>
          </div>
        </div>
      </section>

      <footer className="landing-footer">
        <span>© 2025 CoteCars — Tous droits réservés</span>
        <div style={{ display: 'flex', gap: 24 }}>
          <a href="#">CGV</a>
          <a href="#">CGU</a>
          <a href="#">Mentions légales</a>
          <a href="/">Particuliers</a>
        </div>
      </footer>
    </div>
  );
}
