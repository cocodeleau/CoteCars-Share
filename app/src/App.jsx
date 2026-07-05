import { BrowserRouter, Routes, Route } from 'react-router-dom';
import LandingParticulier from './pages/LandingParticulier';
import LandingPro from './pages/LandingPro';
import DashboardParticulier from './pages/DashboardParticulier';
import DashboardPro from './pages/DashboardPro';
import DemoTool from './demo/DemoTool';

export default function App() {
  return (
    <BrowserRouter>
      <Routes>
        <Route path="/" element={<LandingParticulier />} />
        <Route path="/pros" element={<LandingPro />} />
        <Route path="/dashboard" element={<DashboardParticulier />} />
        <Route path="/pro/dashboard" element={<DashboardPro />} />
        <Route path="/demo" element={<DemoTool />} />
      </Routes>
    </BrowserRouter>
  );
}
