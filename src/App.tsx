import { BrowserRouter as Router, Routes, Route, Link, useLocation } from 'react-router-dom';
import { ConnectButton } from '@rainbow-me/rainbowkit';
import { Shield, TrendingUp, Wallet, Activity, Code } from 'lucide-react';

// Pages
import Landing from './pages/Landing';
import Marketplace from './pages/Marketplace';
import Portfolio from './pages/Portfolio';
import HedgeVault from './pages/HedgeVault';
import Staking from './pages/Staking';
import AgentAPI from './pages/AgentAPI';
import LoanDetails from './pages/LoanDetails';
import OptionDetails from './pages/OptionDetails';

function NavLinks() {
  const location = useLocation();
  const isActive = (path: string) => location.pathname === path;

  const links = [
    { path: '/market', label: 'Marketplace' },
    { path: '/portfolio', label: 'My Loans' },
    { path: '/vault', label: 'Hedge Vault' },
    { path: '/stake', label: 'Stake $CLAW' },
    { path: '/api-docs', label: 'Agent API' },
  ];

  return (
    <div className="hidden md:flex space-x-1">
      {links.map((link) => (
        <Link
          key={link.path}
          to={link.path}
          className={`px-3 py-2 rounded-md text-sm font-medium transition-colors ${
            isActive(link.path) 
              ? 'bg-base-blue/10 text-base-blue' 
              : 'text-gray-400 hover:text-white hover:bg-white/5'
          }`}
        >
          {link.label}
        </Link>
      ))}
    </div>
  );
}

export default function App() {
  return (
    <Router>
      <div className="min-h-screen flex flex-col selection:bg-base-blue/30">
        {/* Navbar */}
        <nav className="border-b border-cyber-border bg-cyber-bg/80 backdrop-blur-md sticky top-0 z-40">
          <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
            <div className="flex justify-between h-16 items-center">
              <div className="flex items-center space-x-6">
                <Link to="/" className="flex items-center space-x-2 group">
                  <span className="text-2xl group-hover:scale-110 transition-transform">🦞</span>
                  <span className="text-lg font-bold text-white tracking-tight">ClawStreet</span>
                </Link>
                <NavLinks />
              </div>
              <div className="flex items-center space-x-4">
                <ConnectButton showBalance={false} chainStatus="icon" />
              </div>
            </div>
          </div>
        </nav>

        {/* Main Content */}
        <main className="flex-grow">
          <Routes>
            <Route path="/" element={<Landing />} />
            <Route path="/market" element={<Marketplace />} />
            <Route path="/portfolio" element={<Portfolio />} />
            <Route path="/vault" element={<HedgeVault />} />
            <Route path="/stake" element={<Staking />} />
            <Route path="/api-docs" element={<AgentAPI />} />
            <Route path="/loan/:id" element={<LoanDetails />} />
            <Route path="/option/:id" element={<OptionDetails />} />
          </Routes>
        </main>

        {/* Footer */}
        <footer className="border-t border-cyber-border py-8 mt-12 bg-cyber-surface/30">
          <div className="max-w-7xl mx-auto px-4 flex flex-col md:flex-row items-center justify-between text-sm text-gray-500">
            <p>ClawStreet &copy; 2026. The Autonomous Capital Layer.</p>
            <div className="mt-4 md:mt-0 flex space-x-4">
              <button className="px-3 py-1.5 bg-[#da552f]/10 text-[#da552f] border border-[#da552f]/20 rounded-md font-medium hover:bg-[#da552f]/20 transition-all">
                Product Hunt
              </button>
              <button className="px-3 py-1.5 bg-white/5 text-gray-300 border border-white/10 rounded-md font-medium hover:bg-white/10 transition-all">
                Colosseum
              </button>
            </div>
          </div>
        </footer>
      </div>
    </Router>
  );
}
