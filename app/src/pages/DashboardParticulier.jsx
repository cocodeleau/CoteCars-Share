import { useNavigate } from 'react-router-dom';

export default function DashboardParticulier() {
  const navigate = useNavigate();

  return (
    <div className="dashboard">
      <aside className="sidebar">
        <div className="sidebar-logo">
          <span>Cote<em>Cars</em></span>
        </div>
        <nav className="sidebar-nav">
          <button className="nav-item active">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" /></svg>
            Estimation
          </button>
          <button className="nav-item">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M12 8v4l3 3m6-3a9 9 0 1 1-18 0 9 9 0 0 1 18 0z" /></svg>
            Historique
          </button>
        </nav>
        <div className="sidebar-footer">
          <button className="btn btn-ghost btn-sm" style={{ width: '100%' }} onClick={() => navigate('/')}>
            ← Retour au site
          </button>
        </div>
      </aside>
      <main className="dashboard-main">
        <div className="tool-pane">
          <div className="tool-header">
            <h2>Estimation véhicule</h2>
            <p>Entrez une plaque pour estimer le prix marché de votre véhicule.</p>
          </div>
          <div className="history-empty">
            <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5"><path d="M12 8v4l3 3m6-3a9 9 0 1 1-18 0 9 9 0 0 1 18 0z" /></svg>
            <h3>Aucune estimation</h3>
            <p>Lancez votre première estimation pour la retrouver ici.</p>
          </div>
        </div>
      </main>
    </div>
  );
}
