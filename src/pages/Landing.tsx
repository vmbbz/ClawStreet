import React from 'react';
import { motion } from 'motion/react';
import { Link } from 'react-router-dom';
import { TrendingUp, Shield, Zap, ArrowRight, Code, ShieldCheck } from 'lucide-react';
import { useReadContract } from 'wagmi';
import { CONTRACT_ADDRESSES, clawStreetLoanABI, clawStreetCallVaultABI, KNOWN_AGENTS, PYTH_FEEDS } from '../config/contracts';
import { usePythPrice, formatPriceUSD } from '../lib/pyth';

export default function Landing() {
  const { data: loanCounter } = useReadContract({
    address: CONTRACT_ADDRESSES.LOAN_ENGINE,
    abi: clawStreetLoanABI,
    functionName: 'loanCounter',
  });
  const { data: optionCounter } = useReadContract({
    address: CONTRACT_ADDRESSES.CALL_VAULT,
    abi: clawStreetCallVaultABI,
    functionName: 'optionCounter',
  });
  const { price: ethPrice } = usePythPrice(PYTH_FEEDS.ETH_USD);

  const stats = [
    { label: 'Loans Created',    value: loanCounter   !== undefined ? String(loanCounter)   : '—' },
    { label: 'Options Written',  value: optionCounter  !== undefined ? String(optionCounter)  : '—' },
    { label: 'Agents Active',    value: String(KNOWN_AGENTS.length) },
    { label: 'ETH/USD',          value: ethPrice ? formatPriceUSD(ethPrice) : '—' },
  ];

  return (
    <div className="relative overflow-hidden min-h-[90vh] flex flex-col justify-center">
      {/* Background effects */}
      <div className="absolute top-[-20%] left-[-10%] w-[50%] h-[50%] bg-base-blue/20 blur-[120px] rounded-full pointer-events-none" />
      <div className="absolute bottom-[-20%] right-[-10%] w-[50%] h-[50%] bg-lobster-orange/10 blur-[120px] rounded-full pointer-events-none" />
      
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-20 relative z-10 w-full">
        <div className="text-center max-w-3xl mx-auto">
          <motion.div
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.5 }}
          >
            <div className="inline-flex items-center space-x-2 mb-8 px-3 py-1 rounded-full border border-base-blue/30 bg-base-blue/10 text-base-blue text-xs font-semibold tracking-wide uppercase">
              <span className="w-2 h-2 rounded-full bg-base-blue animate-pulse"></span>
              <span>Live on Base Mainnet</span>
            </div>
            
            <h1 className="text-5xl md:text-7xl font-extrabold tracking-tight mb-6 text-white leading-tight">
              AUTONOMOUS MONEY <br/>
              <span className="text-transparent bg-clip-text bg-gradient-to-r from-base-blue to-lobster-orange">NEVER SLEEPS</span>
            </h1>
            
            <p className="text-lg text-gray-400 mb-10 leading-relaxed max-w-2xl mx-auto">
              Unlock liquidity from NFTs, hedge portfolios with on-chain options, and earn yield. Built natively for the OpenClaw AI agent economy.
            </p>
            
            <div className="flex flex-col sm:flex-row justify-center gap-4">
              <Link to="/market" className="px-6 py-3 bg-base-blue text-white rounded-lg font-semibold text-sm hover:bg-base-dark transition-all shadow-[0_0_20px_rgba(0,82,255,0.3)] flex items-center justify-center space-x-2">
                <span>Enter Market</span>
                <ArrowRight size={16} />
              </Link>
              <Link to="/api-docs" className="px-6 py-3 bg-cyber-surface text-white rounded-lg font-semibold text-sm hover:bg-cyber-border transition-all border border-cyber-border flex items-center justify-center space-x-2">
                <Code size={16} />
                <span>Agent API</span>
              </Link>
            </div>
          </motion.div>
        </div>

        {/* Live protocol stats bar */}
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.5, delay: 0.15 }}
          className="mt-12 grid grid-cols-2 md:grid-cols-4 gap-3 max-w-2xl mx-auto"
        >
          {stats.map(({ label, value }) => (
            <div key={label} className="bg-cyber-surface/60 border border-cyber-border rounded-xl px-4 py-3 text-center backdrop-blur-sm">
              <div className="text-[10px] text-gray-500 uppercase tracking-wider mb-1">{label}</div>
              <div className="text-lg font-bold text-white font-mono">{value}</div>
            </div>
          ))}
        </motion.div>

        <motion.div
          initial={{ opacity: 0, y: 40 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.7, delay: 0.2 }}
          className="mt-16 grid md:grid-cols-3 gap-6"
        >
          <FeatureCard 
            icon={<Zap className="w-6 h-6 text-base-blue" />}
            title="OTC NFT Liquidity"
            description="Instant capital against agent profiles, skill bundles, or Uniswap V3 LP positions without market impact."
          />
          <FeatureCard 
            icon={<Shield className="w-6 h-6 text-base-blue" />}
            title="Autonomous Hedge Fund"
            description="Write covered calls during sideways markets to earn premium, or buy calls for upside protection."
          />
          <FeatureCard 
            icon={<TrendingUp className="w-6 h-6 text-base-blue" />}
            title="Mathematical Valuation"
            description="Deterministic health scoring using Pyth oracles, on-chain activity, and verifiable revenue streams."
          />
        </motion.div>
        
        <motion.div 
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          transition={{ duration: 1, delay: 0.5 }}
          className="mt-20 text-center"
        >
          <p className="text-xs font-bold text-gray-500 uppercase tracking-widest mb-6">Agent Reputation Secured By</p>
          <div className="flex justify-center items-center space-x-8 opacity-60 hover:opacity-100 transition-opacity duration-500">
            <div className="flex items-center space-x-2">
              <div className="w-8 h-8 rounded bg-blue-500/20 flex items-center justify-center border border-blue-500/30">
                <span className="text-blue-400 font-bold text-xs">CP</span>
              </div>
              <span className="text-gray-300 font-semibold">Cred Protocol</span>
            </div>
            <div className="flex items-center space-x-2">
              <div className="w-8 h-8 rounded bg-neon-blue/10 flex items-center justify-center border border-neon-blue/20">
                <span className="text-neon-blue font-bold text-xs">SS</span>
              </div>
              <span className="text-gray-300 font-semibold">ScoutScore.ai</span>
            </div>
          </div>
        </motion.div>

        <motion.div 
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          transition={{ duration: 1, delay: 0.7 }}
          className="mt-24 text-center"
        >
          <div className="p-8 rounded-2xl bg-gradient-to-b from-cyber-surface to-cyber-bg border border-cyber-border relative overflow-hidden max-w-2xl mx-auto">
            <div className="absolute top-0 left-0 w-full h-1 bg-gradient-to-r from-transparent via-lobster-orange to-transparent opacity-50"></div>
            <h2 className="text-2xl font-bold mb-3 text-white">"$PUNCH just nuked - sell everything!"</h2>
            <p className="text-sm text-gray-400 mb-6">Join the lobster Wall Street. Stake $STREET, govern the protocol, and earn revenue share.</p>
            <Link to="/stake" className="inline-flex items-center space-x-2 text-base-blue font-medium hover:underline text-sm">
              <span>Stake $STREET Now</span>
              <ArrowRight size={14} />
            </Link>
          </div>
        </motion.div>
      </div>
    </div>
  );
}

function FeatureCard({ icon, title, description }: { icon: React.ReactNode, title: string, description: string }) {
  return (
    <div className="p-6 rounded-xl bg-cyber-surface/50 backdrop-blur-sm border border-cyber-border hover:border-base-blue/30 transition-colors group">
      <div className="mb-4 p-3 bg-base-blue/10 rounded-lg inline-block group-hover:scale-110 transition-transform">{icon}</div>
      <h3 className="text-lg font-bold mb-2 text-white">{title}</h3>
      <p className="text-sm text-gray-400 leading-relaxed">{description}</p>
    </div>
  );
}
