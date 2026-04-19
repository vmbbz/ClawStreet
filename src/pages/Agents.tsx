/**
 * Agents.tsx — Agent Observatory
 *
 * Two sections:
 *   1. External Agents — anyone who called POST /api/agents/announce
 *   2. Dev Test Agents — the 5 hardcoded internal agents (amber, never expire)
 *
 * External agents (and humans) can announce themselves by signing an EIP-191
 * message with their wallet. See docs/AgentSDK.md for the full protocol.
 */
import React, { useState, useEffect } from 'react';
import { Link } from 'react-router-dom';
import { useReadContracts, useAccount, useSignMessage } from 'wagmi';
import { formatUnits } from 'viem';
import {
  KNOWN_AGENTS, CONTRACT_ADDRESSES,
  clawTokenABI, erc20ABI, clawStreetLoanABI, clawStreetCallVaultABI,
  BASESCAN,
} from '../config/contracts';
import {
  Activity, ExternalLink, TrendingUp, Zap, Shield,
  Target, BarChart2, UserPlus, UserMinus, RefreshCw, Link2,
} from 'lucide-react';
import { toast } from '../components/Toast';

// ─── Types ────────────────────────────────────────────────────────────────────

interface AgentEntry {
  address: string;
  name: string;
  contact: string;
  role: string;
  participantType: 'agent' | 'human';
  isInternal: boolean;
  signedAt: number;
  lastSeen: number;
}

// ─── Role → icon + color ──────────────────────────────────────────────────────

const ROLE_STYLE: Record<string, { icon: React.ReactNode; color: string; bg: string }> = {
  'Market Maker':   { icon: <BarChart2 size={13} />, color: 'text-base-blue',      bg: 'bg-base-blue/10 border-base-blue/20'         },
  'Arbitrageur':    { icon: <Zap size={13} />,       color: 'text-yellow-400',     bg: 'bg-yellow-400/10 border-yellow-400/20'       },
  'Lender':         { icon: <TrendingUp size={13} />, color: 'text-emerald-400',   bg: 'bg-emerald-400/10 border-emerald-400/20'     },
  'Borrower':       { icon: <Shield size={13} />,     color: 'text-lobster-orange',bg: 'bg-lobster-orange/10 border-lobster-orange/20'},
  'Options Writer': { icon: <Target size={13} />,     color: 'text-purple-400',    bg: 'bg-purple-400/10 border-purple-400/20'       },
};

// ─── Agent Card ───────────────────────────────────────────────────────────────

interface AgentStats { loansCreated: number; loansFunded: number; loansRepaid: number; optionsWritten: number; optionsSold: number; optionsBought: number; optionsExercised: number; totalUsdcVolume: string; estimatedPnlUsdc: string; totalDeals: number; dataWindowBlocks: number; }

const AgentCard: React.FC<{
  entry: AgentEntry;
  streetBalance?: bigint;
  usdcBalance?: bigint;
  loading: boolean;
  stats?: AgentStats;
}> = ({ entry, streetBalance, usdcBalance, loading, stats }) => {
  const style = ROLE_STYLE[entry.role] ?? ROLE_STYLE['Market Maker'];
  const street = streetBalance
    ? Number(formatUnits(streetBalance, 18)).toLocaleString(undefined, { maximumFractionDigits: 0 })
    : '—';
  const usdc = usdcBalance
    ? Number(formatUnits(usdcBalance, 6)).toLocaleString(undefined, { maximumFractionDigits: 2 })
    : '—';

  const isInternal = entry.isInternal;
  const isHuman    = entry.participantType === 'human';

  // Badge: dev agents = amber ⚗️, external humans = blue 👤, external agents = teal 🤖
  const badge = isInternal
    ? { label: '⚗️ Dev Agent',   cls: 'bg-amber-500/10 border-amber-500/25 text-amber-400' }
    : isHuman
    ? { label: '👤 Human',       cls: 'bg-base-blue/10 border-base-blue/20 text-base-blue' }
    : { label: '🤖 External',    cls: 'bg-teal-500/10 border-teal-500/25 text-teal-400'    };

  // Card border: internal = amber, external = teal, human = blue
  const borderHover = isInternal
    ? 'hover:border-amber-500/30'
    : isHuman
    ? 'hover:border-base-blue/30'
    : 'hover:border-teal-500/30';

  const displayAddress = `${entry.address.slice(0, 10)}...${entry.address.slice(-8)}`;

  return (
    <div className={`relative bg-cyber-surface border border-cyber-border rounded-xl p-6 flex flex-col gap-4 ${borderHover} transition-all group`}>
      {/* Header */}
      <div className="flex items-start justify-between gap-3">
        <div className="flex items-start gap-3">
          <div className="w-10 h-10 rounded-lg bg-white/5 border border-cyber-border flex items-center justify-center text-xl flex-shrink-0">
            {isHuman ? '👤' : '🤖'}
          </div>
          <div>
            <div className="font-semibold text-white leading-tight">{entry.name}</div>
            <div className="flex items-center gap-1.5 mt-1 flex-wrap">
              <span className={`inline-flex items-center gap-1 text-xs px-2 py-0.5 rounded-full border ${style.bg} ${style.color}`}>
                {style.icon} {entry.role}
              </span>
              <span className={`inline-flex text-[10px] px-1.5 py-0.5 rounded-full border ${badge.cls}`}>
                {badge.label}
              </span>
            </div>
          </div>
        </div>
        <div className="flex items-center gap-1.5 opacity-0 group-hover:opacity-100 transition-opacity">
          {entry.contact && (
            <a
              href={entry.contact}
              target="_blank"
              rel="noopener noreferrer"
              className="p-1.5 rounded-md hover:bg-white/5 text-gray-500 hover:text-teal-400 transition-colors"
              title="Agent contact endpoint"
            >
              <Link2 size={13} />
            </a>
          )}
          <a
            href={`${BASESCAN}/address/${entry.address}`}
            target="_blank"
            rel="noopener noreferrer"
            className="p-1.5 rounded-md hover:bg-white/5 text-gray-500 hover:text-gray-300 transition-colors"
            title="View on Basescan"
          >
            <ExternalLink size={13} />
          </a>
        </div>
      </div>

      {/* Address */}
      <div className="font-mono text-xs text-gray-500 bg-cyber-bg/50 rounded-md px-3 py-2">
        {displayAddress}
      </div>

      {/* Balances */}
      <div className="grid grid-cols-2 gap-3">
        <div className="bg-cyber-bg/50 rounded-lg px-3 py-2.5">
          <div className="text-[10px] text-gray-500 uppercase tracking-wider mb-1">$STREET</div>
          {loading
            ? <div className="h-4 w-16 bg-white/5 rounded animate-pulse" />
            : <div className="text-sm font-semibold text-white">{street}</div>
          }
        </div>
        <div className="bg-cyber-bg/50 rounded-lg px-3 py-2.5">
          <div className="text-[10px] text-gray-500 uppercase tracking-wider mb-1">USDC</div>
          {loading
            ? <div className="h-4 w-12 bg-white/5 rounded animate-pulse" />
            : <div className="text-sm font-semibold text-white">${usdc}</div>
          }
        </div>
      </div>

      {/* Deal counters — always shown */}
      <div className="grid grid-cols-2 gap-2">
        <div className="bg-cyber-bg/50 rounded-md px-2.5 py-1.5 text-center">
          <div className="text-[9px] text-gray-600 uppercase tracking-wider">Loans</div>
          {stats
            ? <div className="text-xs font-semibold text-white">{stats.loansCreated + stats.loansFunded}</div>
            : <div className="h-3 w-6 bg-white/5 rounded animate-pulse mx-auto mt-1" />}
        </div>
        <div className="bg-cyber-bg/50 rounded-md px-2.5 py-1.5 text-center">
          <div className="text-[9px] text-gray-600 uppercase tracking-wider">Options</div>
          {stats
            ? <div className="text-xs font-semibold text-white">{stats.optionsWritten + stats.optionsSold}</div>
            : <div className="h-3 w-6 bg-white/5 rounded animate-pulse mx-auto mt-1" />}
        </div>
      </div>

      {/* Last seen (external only) */}
      {!isInternal && (
        <div className="text-[10px] text-gray-600">
          Last seen {new Date(entry.lastSeen * 1000).toLocaleString()}
        </div>
      )}

      {/* Profile link */}
      <Link
        to={`/profile/${entry.address}`}
        className="mt-auto pt-3 border-t border-cyber-border flex items-center justify-between text-xs text-gray-500 hover:text-base-blue transition-colors"
      >
        <span>View Full Profile</span>
        <span>→</span>
      </Link>
    </div>
  );
};

// ─── Announce Panel ───────────────────────────────────────────────────────────

const VALID_ROLES = ['Market Maker', 'Lender', 'Borrower', 'Options Writer', 'Arbitrageur'] as const;

function AnnouncePanel({ onSuccess }: { onSuccess: () => void }) {
  const { address } = useAccount();
  const { signMessageAsync } = useSignMessage();
  const [open, setOpen]     = useState(false);
  const [form, setForm]     = useState({
    name: '', role: 'Lender', contact: '',
    participantType: 'agent' as 'agent' | 'human',
  });
  const [busy, setBusy]     = useState(false);

  async function handleAnnounce() {
    if (!address) return;
    setBusy(true);
    try {
      const timestamp = Math.floor(Date.now() / 1000);
      const message = [
        'ClawStreet Agent Announcement',
        `Address: ${address.toLowerCase()}`,
        `Name: ${form.name}`,
        `Contact: ${form.contact}`,
        `Role: ${form.role}`,
        `Type: ${form.participantType}`,
        `Timestamp: ${timestamp}`,
      ].join('\n');

      const signature = await signMessageAsync({ account: address as `0x${string}`, message });

      const res = await fetch('/api/agents/announce', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          address,
          name: form.name,
          contact: form.contact,
          role: form.role,
          participantType: form.participantType,
          timestamp,
          signature,
        }),
      });
      const data = await res.json();
      if (data.success) {
        toast.success('Announced! You\'re now visible in the registry.');
        setOpen(false);
        onSuccess();
      } else {
        toast.error(data.error ?? 'Announcement failed');
      }
    } catch (e: any) {
      if (e?.code !== 4001) toast.error('Announcement failed: ' + (e?.message ?? e));
    } finally {
      setBusy(false);
    }
  }

  if (!address) return null;

  return (
    <div className="mb-8">
      {!open ? (
        <button
          onClick={() => setOpen(true)}
          className="flex items-center gap-2 px-4 py-2.5 bg-teal-500/10 border border-teal-500/30 text-teal-400 rounded-lg text-sm hover:bg-teal-500/20 transition-colors"
        >
          <UserPlus size={15} />
          Announce Yourself to the Protocol
        </button>
      ) : (
        <div className="bg-cyber-surface border border-teal-500/25 rounded-xl p-5 flex flex-col gap-4">
          <div className="flex items-center justify-between">
            <h3 className="font-semibold text-white text-sm">Announce as Participant</h3>
            <button onClick={() => setOpen(false)} className="text-gray-500 hover:text-gray-300 text-xs">✕</button>
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div>
              <label className="text-[10px] text-gray-500 uppercase tracking-wider block mb-1">Display Name *</label>
              <input
                value={form.name}
                onChange={e => setForm(f => ({ ...f, name: e.target.value }))}
                maxLength={32}
                placeholder="MyBot-1"
                className="w-full bg-cyber-bg border border-cyber-border rounded-md px-3 py-2 text-sm text-white placeholder-gray-600 focus:outline-none focus:border-teal-500/50"
              />
            </div>
            <div>
              <label className="text-[10px] text-gray-500 uppercase tracking-wider block mb-1">Role *</label>
              <select
                value={form.role}
                onChange={e => setForm(f => ({ ...f, role: e.target.value }))}
                className="w-full bg-cyber-bg border border-cyber-border rounded-md px-3 py-2 text-sm text-white focus:outline-none focus:border-teal-500/50"
              >
                {VALID_ROLES.map(r => <option key={r}>{r}</option>)}
              </select>
            </div>
            <div>
              <label className="text-[10px] text-gray-500 uppercase tracking-wider block mb-1">Type *</label>
              <select
                value={form.participantType}
                onChange={e => setForm(f => ({ ...f, participantType: e.target.value as 'agent' | 'human' }))}
                className="w-full bg-cyber-bg border border-cyber-border rounded-md px-3 py-2 text-sm text-white focus:outline-none focus:border-teal-500/50"
              >
                <option value="agent">Autonomous Agent</option>
                <option value="human">Human Participant</option>
              </select>
            </div>
            <div>
              <label className="text-[10px] text-gray-500 uppercase tracking-wider block mb-1">
                Contact URL <span className="text-gray-600 normal-case">(optional — for bargaining webhooks)</span>
              </label>
              <input
                value={form.contact}
                onChange={e => setForm(f => ({ ...f, contact: e.target.value }))}
                placeholder="https://your-agent.example.com/bargain"
                className="w-full bg-cyber-bg border border-cyber-border rounded-md px-3 py-2 text-sm text-white placeholder-gray-600 focus:outline-none focus:border-teal-500/50"
              />
            </div>
          </div>
          <div className="flex items-center gap-3 pt-1">
            <button
              onClick={handleAnnounce}
              disabled={busy || !form.name.trim()}
              className="flex items-center gap-2 px-4 py-2 bg-teal-500 text-white rounded-lg text-sm font-medium hover:bg-teal-400 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
            >
              {busy ? <RefreshCw size={13} className="animate-spin" /> : <UserPlus size={13} />}
              Sign & Announce
            </button>
            <p className="text-[10px] text-gray-600">
              Requires a MetaMask signature. Entry expires after 24h without a heartbeat.
            </p>
          </div>
        </div>
      )}
    </div>
  );
}

// ─── Main Page ────────────────────────────────────────────────────────────────

export default function Agents() {
  const [registry, setRegistry] = useState<AgentEntry[]>([]);
  const [registryLoading, setRegistryLoading] = useState(true);
  const [statsMap, setStatsMap] = useState<Map<string, AgentStats>>(new Map());

  async function fetchRegistry() {
    try {
      setRegistryLoading(true);
      const res = await fetch('/api/agents');
      if (res.ok) {
        const entries: AgentEntry[] = await res.json();
        setRegistry(entries);
        // Single bulk request — 3 RPC calls total regardless of agent count
        const addresses = entries.map(e => e.address).join(',');
        const bulkRes = await fetch(`/api/agents/stats/bulk?addresses=${addresses}`);
        const bulkData: Record<string, AgentStats> = bulkRes.ok ? await bulkRes.json() : {};
        const map = new Map<string, AgentStats>();
        const zeroStats = (): AgentStats => ({
          loansCreated: 0, loansFunded: 0, loansRepaid: 0,
          optionsWritten: 0, optionsSold: 0, optionsBought: 0, optionsExercised: 0,
          totalUsdcVolume: '0', estimatedPnlUsdc: '0', totalDeals: 0, dataWindowBlocks: -1,
        });
        entries.forEach(e => {
          const addr = e.address.toLowerCase();
          const stats = bulkData[addr];
          if (stats && typeof stats.totalDeals === 'number') {
            map.set(addr, stats);
          } else {
            map.set(addr, zeroStats());
          }
        });
        setStatsMap(map);
      }
    } finally {
      setRegistryLoading(false);
    }
  }

  useEffect(() => {
    fetchRegistry();
    const interval = setInterval(fetchRegistry, 30_000);
    return () => clearInterval(interval);
  }, []);

  // All addresses to fetch balances for
  const allEntries = registry;
  const balanceCalls = allEntries.flatMap(entry => [
    {
      address: CONTRACT_ADDRESSES.CLAW_TOKEN as `0x${string}`,
      abi: clawTokenABI,
      functionName: 'balanceOf' as const,
      args: [entry.address as `0x${string}`] as const,
    },
    {
      address: CONTRACT_ADDRESSES.MOCK_USDC as `0x${string}`,
      abi: erc20ABI,
      functionName: 'balanceOf' as const,
      args: [entry.address as `0x${string}`] as const,
    },
  ]);

  const { data: balances, isLoading: balancesLoading } = useReadContracts({
    contracts: balanceCalls,
    query: { refetchInterval: 30_000 },
  });

  // Protocol counters
  const { data: counters } = useReadContracts({
    contracts: [
      { address: CONTRACT_ADDRESSES.LOAN_ENGINE as `0x${string}`, abi: clawStreetLoanABI, functionName: 'loanCounter' as const },
      { address: CONTRACT_ADDRESSES.CALL_VAULT as `0x${string}`,  abi: clawStreetCallVaultABI, functionName: 'optionCounter' as const },
    ],
  });
  const totalLoans   = counters?.[0]?.result as bigint | undefined;
  const totalOptions = counters?.[1]?.result as bigint | undefined;

  const external = allEntries.filter(e => !e.isInternal);
  const internal = allEntries.filter(e => e.isInternal);

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
          All participants operating on ClawStreet — dev agents, external bots, and human traders.
        </p>
      </div>

      {/* Stats row */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-4 mb-8">
        {[
          { label: 'Total Participants', value: registryLoading ? '—' : allEntries.length.toString() },
          { label: 'External Agents', value: registryLoading ? '—' : external.length.toString() },
          { label: 'Total Loans', value: totalLoans !== undefined ? Number(totalLoans).toString() : '—' },
          { label: 'Total Options', value: totalOptions !== undefined ? Number(totalOptions).toString() : '—' },
        ].map(({ label, value }) => (
          <div key={label} className="bg-cyber-surface border border-cyber-border rounded-lg px-4 py-3">
            <div className="text-[10px] text-gray-500 uppercase tracking-wider mb-1">{label}</div>
            <div className="text-lg font-bold text-white">{value}</div>
          </div>
        ))}
      </div>

      {/* Announce panel */}
      <AnnouncePanel onSuccess={fetchRegistry} />

      {/* External Agents section */}
      <div className="mb-10">
        <div className="flex items-center gap-2 mb-4">
          <span className="text-teal-400 text-base">🤖</span>
          <h2 className="text-sm font-semibold text-white uppercase tracking-wider">External Participants</h2>
          <span className="text-xs text-gray-500">— announced via signed message</span>
        </div>

        {registryLoading ? (
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-5">
            {[...Array(3)].map((_, i) => (
              <div key={i} className="bg-cyber-surface border border-cyber-border rounded-xl p-6 h-56 animate-pulse" />
            ))}
          </div>
        ) : external.length === 0 ? (
          <div className="bg-teal-500/5 border border-teal-500/20 rounded-xl px-6 py-8 text-center">
            <div className="text-3xl mb-3">🤖</div>
            <p className="text-gray-400 text-sm mb-1">No external participants announced yet.</p>
            <p className="text-gray-600 text-xs">
              Build an agent using the{' '}
              <a href="/docs/AgentSDK.md" className="text-teal-400 hover:underline" target="_blank">Agent SDK guide</a>
              {' '}or use the form above to announce yourself.
            </p>
          </div>
        ) : (
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-5">
            {external.map((entry, i) => {
              const idx = allEntries.indexOf(entry);
              return (
                <AgentCard
                  key={entry.address}
                  entry={entry}
                  streetBalance={balances?.[idx * 2]?.result as bigint | undefined}
                  usdcBalance={balances?.[idx * 2 + 1]?.result as bigint | undefined}
                  loading={balancesLoading}
                  stats={statsMap.get(entry.address.toLowerCase())}
                />
              );
            })}
          </div>
        )}
      </div>

      {/* Dev Test Agents section */}
      <div>
        <div className="flex items-center gap-2 mb-4">
          <span className="text-amber-400 text-base">⚗️</span>
          <h2 className="text-sm font-semibold text-white uppercase tracking-wider">Dev Test Agents</h2>
          <span className="text-xs text-gray-500">— running on developer's machine</span>
        </div>

        <div className="mb-5 p-4 bg-amber-500/8 border border-amber-500/25 rounded-xl flex gap-3 items-start">
          <span className="text-amber-400 mt-0.5 shrink-0">ℹ️</span>
          <p className="text-sm text-gray-400 leading-relaxed">
            These 5 agents cycle through loan and option deals on Base Sepolia to keep the protocol active.
            They are <strong className="text-amber-400/80">not a model for production agents</strong> — they
            use privileged keys and simplified logic. See{' '}
            <a href="/market" className="text-base-blue hover:underline">Market</a> to participate alongside them,
            or read <a href="/docs/AgentSDK.md" target="_blank" className="text-base-blue hover:underline">AgentSDK.md</a> to build your own.
          </p>
        </div>

        {internal.length === 0 ? (
          <div className="text-gray-600 text-sm">Loading dev agents…</div>
        ) : (
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-5">
            {internal.map((entry) => {
              const idx = allEntries.indexOf(entry);
              return (
                <AgentCard
                  key={entry.address}
                  entry={entry}
                  streetBalance={balances?.[idx * 2]?.result as bigint | undefined}
                  usdcBalance={balances?.[idx * 2 + 1]?.result as bigint | undefined}
                  loading={balancesLoading}
                  stats={statsMap.get(entry.address.toLowerCase())}
                />
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
