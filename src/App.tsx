import { useState, useEffect } from 'react';
import { BrowserRouter as Router, Routes, Route, Link, Navigate, useLocation, useNavigate } from 'react-router-dom';
import { ConnectButton } from '@rainbow-me/rainbowkit';
import { Sun, Moon, Menu, X } from 'lucide-react';
import { toggleTheme, getTheme, type Theme } from './lib/theme';
import { ToastContainer } from './components/Toast';
import { Analytics } from '@vercel/analytics/react';

// Pages
import Landing from './pages/Landing';
import Market from './pages/Market';
import Portfolio from './pages/Portfolio';
import Staking from './pages/Staking';
import AgentAPI from './pages/AgentAPI';
import LoanDetails from './pages/LoanDetails';
import OptionDetails from './pages/OptionDetails';
import AdminDashboard from './pages/AdminDashboard';
import TestLab from './pages/TestLab';
import Profile from './pages/Profile';
import Agents from './pages/Agents';

// ─── 404 page ─────────────────────────────────────────────────────────────────

function NotFound() {
  const navigate = useNavigate();
  return (
    <div className="flex flex-col items-center justify-center min-h-[60vh] text-center px-4">
      <span className="text-6xl mb-6">🦞</span>
      <h1 className="text-4xl font-extrabold text-white mb-3">404</h1>
      <p className="text-gray-400 mb-8">This page swam away. The claw couldn't find it.</p>
      <div className="flex gap-3">
        <button
          onClick={() => navigate(-1)}
          className="px-5 py-2.5 bg-cyber-surface border border-cyber-border text-gray-300 rounded-lg font-medium text-sm hover:bg-white/5 transition-colors"
        >
          Go Back
        </button>
        <Link to="/" className="px-5 py-2.5 bg-base-blue text-white rounded-lg font-medium text-sm hover:bg-base-dark transition-colors">
          Home
        </Link>
      </div>
    </div>
  );
}

// ─── Nav config ───────────────────────────────────────────────────────────────

const NAV_LINKS = [
  { path: '/market',    label: 'Market' },
  { path: '/portfolio', label: 'Portfolio' },
  { path: '/agents',   label: 'Agents' },
  { path: '/stake',    label: 'Stake $STREET' },
  { path: '/api-docs', label: 'Agent API' },
  { path: '/test-lab', label: 'Test Lab' },
  { path: '/admin',    label: 'Admin' },
];

// ─── Desktop nav links ────────────────────────────────────────────────────────

function NavLinks({ onNavigate }: { onNavigate?: () => void }) {
  const location = useLocation();
  const isActive = (path: string) =>
    location.pathname === path || (path === '/market' && location.pathname === '/vault');

  return (
    <>
      {NAV_LINKS.map((link) => (
        <Link
          key={link.path}
          to={link.path}
          onClick={onNavigate}
          className={`px-3 py-2 rounded-md text-sm font-medium transition-colors ${
            isActive(link.path)
              ? 'bg-base-blue/10 text-base-blue'
              : 'text-gray-400 hover:text-white hover:bg-white/5'
          }`}
        >
          {link.label}
        </Link>
      ))}
    </>
  );
}

// ─── Mobile drawer ────────────────────────────────────────────────────────────

function MobileDrawer({ open, onClose }: { open: boolean; onClose: () => void }) {
  // Close on Escape
  useEffect(() => {
    const handler = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [onClose]);

  if (!open) return null;

  return (
    <>
      {/* Backdrop */}
      <div
        className="fixed inset-0 bg-black/60 backdrop-blur-sm z-50"
        onClick={onClose}
      />
      {/* Drawer */}
      <div className="fixed top-0 left-0 bottom-0 w-72 bg-cyber-surface border-r border-cyber-border z-50 flex flex-col p-6 gap-1">
        <div className="flex items-center justify-between mb-6">
          <Link to="/" onClick={onClose} className="flex items-center gap-2">
            <span className="text-2xl">🦞</span>
            <span className="text-lg font-bold text-white">ClawStreet</span>
          </Link>
          <button onClick={onClose} className="p-1.5 rounded-md hover:bg-white/5 text-gray-400">
            <X size={18} />
          </button>
        </div>
        <NavLinks onNavigate={onClose} />
      </div>
    </>
  );
}

// ─── Theme toggle button ──────────────────────────────────────────────────────

function ThemeToggle() {
  const [theme, setTheme] = useState<Theme>(getTheme());

  useEffect(() => {
    const handler = (e: Event) => setTheme((e as CustomEvent<Theme>).detail);
    window.addEventListener('cs-theme-change', handler);
    return () => window.removeEventListener('cs-theme-change', handler);
  }, []);

  return (
    <button
      onClick={() => { const next = toggleTheme(); setTheme(next); }}
      className="p-2 rounded-md hover:bg-white/5 text-gray-400 hover:text-white transition-colors"
      title={theme === 'dark' ? 'Switch to light mode' : 'Switch to dark mode'}
    >
      {theme === 'dark' ? <Sun size={16} /> : <Moon size={16} />}
    </button>
  );
}

// ─── Root app ─────────────────────────────────────────────────────────────────

export default function App() {
  const [mobileOpen, setMobileOpen] = useState(false);

  return (
    <Router>
      <div className="min-h-screen flex flex-col selection:bg-base-blue/30">

        {/* Navbar */}
        <nav className="border-b border-cyber-border bg-cyber-bg/80 backdrop-blur-md sticky top-0 z-40">
          <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
            <div className="flex justify-between h-16 items-center gap-4">

              {/* Left: logo + desktop links */}
              <div className="flex items-center gap-6">
                <Link to="/" className="flex items-center gap-2 group flex-shrink-0">
                  <span className="text-2xl group-hover:scale-110 transition-transform">🦞</span>
                  <span className="text-lg font-bold text-white tracking-tight">ClawStreet</span>
                </Link>
                <div className="hidden md:flex items-center gap-1">
                  <NavLinks />
                </div>
              </div>

              {/* Right: theme toggle + connect + hamburger */}
              <div className="flex items-center gap-2">
                <ThemeToggle />
                <ConnectButton showBalance={false} chainStatus="icon" />
                {/* Hamburger — mobile only */}
                <button
                  className="md:hidden p-2 rounded-md hover:bg-white/5 text-gray-400 hover:text-white transition-colors"
                  onClick={() => setMobileOpen(true)}
                >
                  <Menu size={18} />
                </button>
              </div>
            </div>
          </div>
        </nav>

        {/* Mobile drawer */}
        <MobileDrawer open={mobileOpen} onClose={() => setMobileOpen(false)} />

        {/* Global toast notifications */}
        <ToastContainer />

        {/* Main content */}
        <main className="flex-grow">
          <Routes>
            <Route path="/" element={<Landing />} />
            <Route path="/market" element={<Market />} />
            <Route path="/vault" element={<Navigate to="/market?type=options" replace />} />
            <Route path="/marketplace" element={<Navigate to="/market" replace />} />
            <Route path="/portfolio" element={<Portfolio />} />
            <Route path="/agents" element={<Agents />} />
            <Route path="/stake" element={<Staking />} />
            <Route path="/api-docs" element={<AgentAPI />} />
            <Route path="/loan/:id" element={<LoanDetails />} />
            <Route path="/option/:id" element={<OptionDetails />} />
            <Route path="/test-lab" element={<TestLab />} />
            <Route path="/admin" element={<AdminDashboard />} />
            <Route path="/profile/:address" element={<Profile />} />
            <Route path="*" element={<NotFound />} />
          </Routes>
        </main>

        {/* Footer */}
        <footer className="border-t border-cyber-border py-8 mt-12 bg-cyber-surface/30">
          <div className="max-w-7xl mx-auto px-4 flex flex-col md:flex-row items-center justify-between text-sm text-gray-500">
            <p>ClawStreet &copy; 2026. The Autonomous Capital Layer.</p>
            <div className="mt-4 md:mt-0 flex gap-3">
              <button className="px-3 py-1.5 bg-[#da552f]/10 text-[#da552f] border border-[#da552f]/20 rounded-md font-medium hover:bg-[#da552f]/20 transition-all">
                Product Hunt
              </button>
              <button className="px-3 py-1.5 bg-white/5 text-gray-300 border border-white/10 rounded-md font-medium hover:bg-white/10 transition-all">
                Colosseum
              </button>
            </div>
          </div>
        </footer>
        <Analytics />
      </div>
    </Router>
  );
}
