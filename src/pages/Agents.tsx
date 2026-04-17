/**
 * Agents.tsx — Agent Observatory
 * Displays live on-chain state for all 5 autonomous agents.
 */
import React from 'react';
import { Link } from 'react-router-dom';
import { useReadContracts } from 'wagmi';
import { formatUnits } from 'viem';
import {
  KNOWN_AGENTS, CONTRACT_ADDRESSES,
  clawTokenABI, erc20ABI, clawStreetLoanABI, clawStreetCallVaultABI,
  BASESCAN,
} from '../config/contracts';
import { Activity, ExternalLink, TrendingUp, Zap, Shield, Target, BarChart2 } from 'lucide-react';

// ─── Role → icon + color ──────────────────────────────────────────────────────

const ROLE_STYLE: Record<string, { icon: React.ReactNode; color: string; bg: string }> = {
  'Market Maker':    { icon: <BarChart2 size={14} />, color: 'text-base-blue',      bg: 'bg-base-blue/10 border-base-blue/20' },
  'Arbitrageur':     { icon: <Zap size={14} />,       color: 'text-yellow-400',     bg: 'bg-yellow-400/10 border-yellow-400/20' },
  'Lender':          { icon: <TrendingUp size={14} />, color: 'text-emerald-400',   bg: 'bg-emerald-400/10 border-emerald-400/20' },
  'Borrower':        { icon: <Shield size={14} />,     color: 'text-lobster-orange', bg: 'bg-lobster-orange/10 border-lobster-orange/20' },
  'Options Writer':  { icon: <Target size={14} />,     color: 'text-purple-400',    bg: 'bg-purple-400/10 border-purple-400/20' },
};

// ─── Agent Card ───────────────────────────────────────────────────────────────

function AgentCard({
  agent,
  streetBalance,
  usdcBalance,
  loanCount,
  optionCount,
  loading,
}: {
  agent: typeof KNOWN_AGENTS[0];
  streetBalance: bigint | undefined;
  usdcBalance: bigint | undefined;
  loanCount: bigint | undefined;
  optionCount: bigint | undefined;
  loading: boolean;
}) {
  const style = ROLE_STYLE[agent.role] ?? ROLE_STYLE['Market Maker'];
  const street = streetBalance ? Number(formatUnits(streetBalance, 18)).toLocaleString(undefined, { maximumFractionDigits: 0 }) : '—';
  const usdc = usdcBalance ? Number(formatUnits(usdcBalance, 6)).toLocaleString(undefined, { maximumFractionDigits: 2 }) : '—';
  const isPlaceholder = agent.address === '0x0000000000000000000000000000000000000001' ||
    agent.address === '0x0000000000000000000000000000000000000002' ||
    agent.address === '0x0000000000000000000000000000000000000003';

  return (
    <div className="relative bg-cyber-surface border border-cyber-border rounded-xl p-6 flex flex-col gap-4 hover:border-base-blue/30 transition-all group">
      {/* Header */}
      <div className="flex items-start justify-between gap-3">
        <div className="flex items-start gap-3">
          <div className="w-10 h-10 rounded-lg bg-base-blue/10 border border-base-blue/20 flex items-center justify-center text-xl flex-shrink-0">
            🤖
          </div>
          <div>
            <div className="font-semibold text-white leading-tight">{agent.name}</div>
            <div className={`mt-1 inline-flex items-center gap-1 text-xs px-2 py-0.5 rounded-full border ${style.bg} ${style.color}`}>
              {style.icon}
              {agent.role}
            </div>
          </div>
        </div>
        <div className="flex items-center gap-2 opacity-0 group-hover:opacity-100 transition-opacity">
          <a
            href={`${BASESCAN}/address/${agent.address}`}
            target="_blank"
            rel="noopener noreferrer"
            className="p-1.5 rounded-md hover:bg-white/5 text-gray-500 hover:text-gray-300 transition-colors"
            title="View on Basescan"
          >
            <ExternalLink size={14} />
          </a>
        </div>
      </div>

      {/* Address */}
      <div className="font-mono text-xs text-gray-500 bg-cyber-bg/50 rounded-md px-3 py-2 flex items-center justify-between">
        <span>{agent.address.slice(0, 10)}...{agent.address.slice(-8)}</span>
        {isPlaceholder && (
          <span className="text-yellow-500/70 text-[10px]">placeholder addr</span>
        )}
      </div>

      {/* Balances */}
      <div className="grid grid-cols-2 gap-3">
        <div className="bg-cyber-bg/50 rounded-lg px-3 py-2.5">
          <div className="text-[10px] text-gray-500 uppercase tracking-wider mb-1">$STREET</div>
          {loading ? (
            <div className="h-4 w-16 bg-white/5 rounded animate-pulse" />
          ) : (
            <div className="text-sm font-semibold text-white">{street}</div>
          )}
        </div>
        <div className="bg-cyber-bg/50 rounded-lg px-3 py-2.5">
          <div className="text-[10px] text-gray-500 uppercase tracking-wider mb-1">USDC</div>
          {loading ? (
            <div className="h-4 w-12 bg-white/5 rounded animate-pulse" />
          ) : (
            <div className="text-sm font-semibold text-white">${usdc}</div>
          )}
        </div>
      </div>

      {/* Deal counts */}
      <div className="flex items-center gap-4 text-xs text-gray-500">
        <span>
          <span className="text-white font-medium">{loanCount !== undefined ? Number(loanCount) : '—'}</span> loans participated
        </span>
        <span>
          <span className="text-white font-medium">{optionCount !== undefined ? Number(optionCount) : '—'}</span> options written
        </span>
      </div>

      {/* Footer link */}
      <Link
        to={`/profile/${agent.address}`}
        className="mt-auto pt-3 border-t border-cyber-border flex items-center justify-between text-xs text-gray-500 hover:text-base-blue transition-colors"
      >
        <span>View Full Profile</span>
        <span>→</span>
      </Link>
    </div>
  );
}

// ─── Main Page ────────────────────────────────────────────────────────────────

export default function Agents() {
  // Batch-read STREET + USDC balances for all agents
  const balanceCalls = KNOWN_AGENTS.flatMap(agent => [
    {
      address: CONTRACT_ADDRESSES.CLAW_TOKEN as `0x${string}`,
      abi: clawTokenABI,
      functionName: 'balanceOf' as const,
      args: [agent.address] as const,
    },
    {
      address: CONTRACT_ADDRESSES.MOCK_USDC as `0x${string}`,
      abi: erc20ABI,
      functionName: 'balanceOf' as const,
      args: [agent.address] as const,
    },
  ]);

  const { data: balances, isLoading } = useReadContracts({
    contracts: balanceCalls,
    query: { refetchInterval: 30_000 },
  });

  // Read loan + option counters once (used as rough deal count proxy)
  const { data: loanCounter } = useReadContracts({
    contracts: [{
      address: CONTRACT_ADDRESSES.LOAN_ENGINE as `0x${string}`,
      abi: clawStreetLoanABI,
      functionName: 'loanCounter' as const,
    }, {
      address: CONTRACT_ADDRESSES.CALL_VAULT as `0x${string}`,
      abi: clawStreetCallVaultABI,
      functionName: 'optionCounter' as const,
    }],
  });

  const totalLoans = loanCounter?.[0]?.result as bigint | undefined;
  const totalOptions = loanCounter?.[1]?.result as bigint | undefined;

  return (
    <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-10">
      {/* Header */}
      <div className="mb-6">
        <div className="flex items-center gap-3 mb-2">
          <div className="p-2 rounded-lg bg-base-blue/10 border border-base-blue/20 text-base-blue">
            <Activity size={20} />
          </div>
          <h1 className="text-2xl font-bold text-white tracking-tight">Agent Observatory</h1>
        </div>
        <p className="text-gray-400 text-sm">
          Autonomous capital operating on ClawStreet — live on-chain balances, refreshed every 30s.
        </p>
      </div>

      {/* Testnet context banner */}
      <div className="mb-8 p-4 bg-amber-500/8 border border-amber-500/25 rounded-xl flex gap-3 items-start">
        <span className="text-amber-400 text-base mt-0.5 shrink-0">⚗️</span>
        <div className="text-sm">
          <p className="font-semibold text-amber-400 mb-0.5">These are autonomous test agents running on the developer's machine</p>
          <p className="text-gray-400 leading-relaxed">
            They cycle through loan and option deals on Base Sepolia to keep the protocol active and demonstrable.
            You can <a href="/market" className="text-base-blue hover:underline">participate manually via the Market</a>,
            or point your own agent at the protocol contracts to trade alongside them.
            Agent addresses and ABIs are in <code className="bg-black/20 px-1 rounded text-xs">config/base-sepolia.json</code>.
          </p>
        </div>
      </div>

      {/* Protocol summary */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-4 mb-10">
        {[
          { label: 'Active Agents', value: KNOWN_AGENTS.length.toString() },
          { label: 'Total Loans Created', value: totalLoans !== undefined ? Number(totalLoans).toString() : '—' },
          { label: 'Total Options Written', value: totalOptions !== undefined ? Number(totalOptions).toString() : '—' },
          { label: 'Network', value: 'Base Sepolia' },
        ].map(({ label, value }) => (
          <div key={label} className="bg-cyber-surface border border-cyber-border rounded-lg px-4 py-3">
            <div className="text-[10px] text-gray-500 uppercase tracking-wider mb-1">{label}</div>
            <div className="text-lg font-bold text-white">{value}</div>
          </div>
        ))}
      </div>

      {/* Agent grid */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-5">
        {KNOWN_AGENTS.map((agent, i) => {
          const streetResult = balances?.[i * 2];
          const usdcResult = balances?.[i * 2 + 1];
          return (
            <AgentCard
              key={agent.address}
              agent={agent}
              streetBalance={streetResult?.result as bigint | undefined}
              usdcBalance={usdcResult?.result as bigint | undefined}
              loanCount={totalLoans}
              optionCount={totalOptions}
              loading={isLoading}
            />
          );
        })}
      </div>

      {/* Placeholder notice */}
      <div className="mt-8 bg-yellow-500/5 border border-yellow-500/20 rounded-lg px-4 py-3 text-sm text-yellow-400/80">
        <strong>Note:</strong> Three agent addresses are placeholders (0x000...001/002/003). Update{' '}
        <code className="font-mono text-xs bg-black/30 px-1 py-0.5 rounded">KNOWN_AGENTS</code>{' '}
        in <code className="font-mono text-xs bg-black/30 px-1 py-0.5 rounded">src/config/contracts.ts</code>{' '}
        with real agent wallet addresses from your <code className="font-mono text-xs bg-black/30 px-1 py-0.5 rounded">.env.agents</code> file.
      </div>
    </div>
  );
}
