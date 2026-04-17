import { useState, useEffect, ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { useAccount, useReadContract, useReadContracts } from 'wagmi';
import { formatUnits } from 'viem';
import {
  CONTRACT_ADDRESSES,
  clawStreetLoanABI,
  clawStreetStakingABI,
  clawStreetCallVaultABI,
  clawTokenABI,
  erc20ABI,
  KNOWN_AGENTS,
  BASESCAN,
} from '../config/contracts';
import { ExternalLink, User } from 'lucide-react';

// ─── Types ────────────────────────────────────────────────────────────────────

interface StatusBadgeProps {
  ok: boolean;
  label: string;
}

interface StatCardProps {
  label: string;
  value: string | number;
  sub?: string;
  accent?: boolean;
}

interface AgentRow {
  name: string;
  address: string;
  role: string;
}

// ─── Sub-components ───────────────────────────────────────────────────────────

function StatusBadge({ ok, label }: StatusBadgeProps) {
  return (
    <span className={`inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full text-xs font-semibold ${
      ok ? 'bg-green-500/15 text-green-400' : 'bg-red-500/15 text-red-400'
    }`}>
      <span className={`w-1.5 h-1.5 rounded-full ${ok ? 'bg-green-400' : 'bg-red-400'} animate-pulse`} />
      {label}
    </span>
  );
}

function StatCard({ label, value, sub, accent }: StatCardProps) {
  return (
    <div className={`rounded-xl border p-4 ${
      accent
        ? 'bg-base-blue/5 border-base-blue/30'
        : 'bg-cyber-surface border-cyber-border'
    }`}>
      <p className="text-xs text-gray-400 uppercase tracking-wider mb-1">{label}</p>
      <p className={`text-2xl font-bold ${accent ? 'text-base-blue' : 'text-white'}`}>{value}</p>
      {sub && <p className="text-xs text-gray-500 mt-1">{sub}</p>}
    </div>
  );
}

function SectionHeader({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="flex items-center justify-between mb-3">
      <h2 className="text-sm font-semibold text-gray-300 uppercase tracking-widest">{title}</h2>
      {children}
    </div>
  );
}

// ─── Contract health check ────────────────────────────────────────────────────

function ContractHealthPanel() {
  const contracts = [
    { label: 'ClawToken ($STREET)', address: CONTRACT_ADDRESSES.CLAW_TOKEN },
    { label: 'Staking', address: CONTRACT_ADDRESSES.STAKING },
    { label: 'Loan Engine', address: CONTRACT_ADDRESSES.LOAN_ENGINE },
    { label: 'Call Vault', address: CONTRACT_ADDRESSES.CALL_VAULT },
    { label: 'Bundle Vault', address: CONTRACT_ADDRESSES.BUNDLE_VAULT },
  ];

  const isPlaceholder = (addr: string) => addr.match(/^0x[0-9a-f]+$/i) && new Set(addr.slice(2).split('')).size <= 2;

  return (
    <div className="bg-cyber-surface border border-cyber-border rounded-xl p-4">
      <SectionHeader title="Contract Addresses" />
      <div className="space-y-2">
        {contracts.map(({ label, address }) => {
          const deployed = !isPlaceholder(address);
          return (
            <div key={label} className="flex items-center justify-between py-1.5 border-b border-cyber-border/50 last:border-0">
              <span className="text-sm text-gray-300">{label}</span>
              <div className="flex items-center gap-3">
                <StatusBadge ok={deployed} label={deployed ? 'Deployed' : 'Placeholder'} />
                <code className="text-xs text-gray-500 font-mono">
                  {address.slice(0, 6)}…{address.slice(-4)}
                </code>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ─── Protocol stats ───────────────────────────────────────────────────────────

function ProtocolStatsPanel() {
  const { data: loanCount } = useReadContract({
    address: CONTRACT_ADDRESSES.LOAN_ENGINE,
    abi: clawStreetLoanABI,
    functionName: 'loanCounter',
  });

  const { data: optionCount } = useReadContract({
    address: CONTRACT_ADDRESSES.CALL_VAULT,
    abi: clawStreetCallVaultABI,
    functionName: 'optionCounter',
  });

  const { data: totalStaked } = useReadContract({
    address: CONTRACT_ADDRESSES.STAKING,
    abi: clawStreetStakingABI,
    functionName: 'totalStaked',
  });

  const { data: revenueAcc } = useReadContract({
    address: CONTRACT_ADDRESSES.STAKING,
    abi: clawStreetStakingABI,
    functionName: 'revenuePerShareAccumulated',
  });

  const { data: clawSupply } = useReadContract({
    address: CONTRACT_ADDRESSES.CLAW_TOKEN,
    abi: clawTokenABI,
    functionName: 'totalSupply',
  });

  const { data: isPaused } = useReadContract({
    address: CONTRACT_ADDRESSES.LOAN_ENGINE,
    abi: clawStreetLoanABI,
    functionName: 'paused',
  });

  return (
    <div className="bg-cyber-surface border border-cyber-border rounded-xl p-4">
      <SectionHeader title="Protocol Stats">
        <StatusBadge ok={isPaused === false} label={isPaused ? 'PAUSED' : 'Live'} />
      </SectionHeader>
      <div className="grid grid-cols-2 md:grid-cols-3 gap-3">
        <StatCard
          label="Total Loans"
          value={loanCount !== undefined ? String(loanCount) : '—'}
          sub="all-time created"
        />
        <StatCard
          label="Options Written"
          value={optionCount !== undefined ? String(optionCount) : '—'}
          sub="all-time"
        />
        <StatCard
          label="STREET Staked"
          value={totalStaked !== undefined ? parseFloat(formatUnits(totalStaked as bigint, 18)).toLocaleString(undefined, { maximumFractionDigits: 0 }) : '—'}
          sub="tokens"
          accent
        />
        <StatCard
          label="STREET Supply"
          value={clawSupply !== undefined ? parseFloat(formatUnits(clawSupply as bigint, 18)).toLocaleString(undefined, { maximumFractionDigits: 0 }) : '—'}
          sub="/ 100,000,000 max"
        />
        <StatCard
          label="Rev/Share Acc."
          value={revenueAcc !== undefined ? parseFloat(formatUnits(revenueAcc as bigint, 18)).toExponential(3) : '—'}
          sub="USDC scaled"
        />
      </div>
    </div>
  );
}

// ─── Connected wallet info ────────────────────────────────────────────────────

function WalletPanel() {
  const { address, isConnected, chain } = useAccount();

  const { data: clawBalance } = useReadContract({
    address: CONTRACT_ADDRESSES.CLAW_TOKEN,
    abi: clawTokenABI,
    functionName: 'balanceOf',
    args: address ? [address] : undefined,
    query: { enabled: !!address },
  });

  const { data: stakingPos } = useReadContract({
    address: CONTRACT_ADDRESSES.STAKING,
    abi: clawStreetStakingABI,
    functionName: 'positions',
    args: address ? [address] : undefined,
    query: { enabled: !!address },
  });

  const { data: pending } = useReadContract({
    address: CONTRACT_ADDRESSES.STAKING,
    abi: clawStreetStakingABI,
    functionName: 'pendingRevenue',
    args: address ? [address] : undefined,
    query: { enabled: !!address },
  });

  const { data: lockRemain } = useReadContract({
    address: CONTRACT_ADDRESSES.STAKING,
    abi: clawStreetStakingABI,
    functionName: 'lockRemaining',
    args: address ? [address] : undefined,
    query: { enabled: !!address },
  });

  if (!isConnected) {
    return (
      <div className="bg-cyber-surface border border-cyber-border rounded-xl p-4 flex items-center justify-center h-32 text-gray-500 text-sm">
        Connect wallet to see your position
      </div>
    );
  }

  const pos = stakingPos as [bigint, bigint, bigint, bigint, boolean] | undefined;
  const lockSecs = lockRemain ? Number(lockRemain as bigint) : 0;
  const lockDays = Math.floor(lockSecs / 86400);
  const lockHrs = Math.floor((lockSecs % 86400) / 3600);

  return (
    <div className="bg-cyber-surface border border-cyber-border rounded-xl p-4">
      <SectionHeader title="Your Position">
        <StatusBadge ok={chain?.id === 84532} label={chain?.name ?? 'Unknown'} />
      </SectionHeader>
      <div className="space-y-2 text-sm">
        <div className="flex justify-between">
          <span className="text-gray-400">Address</span>
          <code className="text-gray-200 text-xs">{address?.slice(0, 8)}…{address?.slice(-6)}</code>
        </div>
        <div className="flex justify-between">
          <span className="text-gray-400">$STREET Balance</span>
          <span className="text-white">{clawBalance !== undefined ? parseFloat(formatUnits(clawBalance as bigint, 18)).toLocaleString() : '—'}</span>
        </div>
        <div className="flex justify-between">
          <span className="text-gray-400">$STREET Staked</span>
          <span className="text-white">{pos ? parseFloat(formatUnits(pos[0], 18)).toLocaleString() : '—'}</span>
        </div>
        <div className="flex justify-between">
          <span className="text-gray-400">ClawPass NFT</span>
          <span className={pos?.[4] ? 'text-green-400' : 'text-gray-500'}>{pos?.[4] ? `#${pos[3]}` : 'None'}</span>
        </div>
        <div className="flex justify-between">
          <span className="text-gray-400">Pending Revenue</span>
          <span className="text-green-400">{pending !== undefined ? parseFloat(formatUnits(pending as bigint, 6)).toFixed(4) + ' USDC' : '—'}</span>
        </div>
        <div className="flex justify-between">
          <span className="text-gray-400">Lock Remaining</span>
          <span className="text-yellow-400">
            {lockSecs === 0 ? (pos?.[0] > 0n ? 'Unlocked' : '—') : `${lockDays}d ${lockHrs}h`}
          </span>
        </div>
      </div>
    </div>
  );
}

// ─── Live agent registry ──────────────────────────────────────────────────────

function AgentRegistryPanel() {
  // Batch-read STREET + USDC balance for every agent
  const balanceCalls = KNOWN_AGENTS.flatMap(a => [
    { address: CONTRACT_ADDRESSES.CLAW_TOKEN as `0x${string}`, abi: clawTokenABI, functionName: 'balanceOf' as const, args: [a.address] as const },
    { address: CONTRACT_ADDRESSES.MOCK_USDC as `0x${string}`,  abi: erc20ABI,     functionName: 'balanceOf' as const, args: [a.address] as const },
  ]);

  const { data: balances, isLoading } = useReadContracts({
    contracts: balanceCalls,
    query: { refetchInterval: 30_000 },
  });

  const isPlaceholder = (addr: string) =>
    addr === '0x0000000000000000000000000000000000000001' ||
    addr === '0x0000000000000000000000000000000000000002' ||
    addr === '0x0000000000000000000000000000000000000003';

  return (
    <div className="bg-cyber-surface border border-cyber-border rounded-xl p-4">
      <SectionHeader title="Agent Registry — Live Balances">
        <span className="text-xs text-gray-500">Auto-refresh 30s · Edit addresses in contracts.ts</span>
      </SectionHeader>
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="text-xs text-gray-500 uppercase border-b border-cyber-border">
              <th className="text-left pb-2 pr-4">Agent</th>
              <th className="text-left pb-2 pr-4">Role</th>
              <th className="text-left pb-2 pr-4">Address</th>
              <th className="text-right pb-2 pr-4">$STREET</th>
              <th className="text-right pb-2 pr-4">USDC</th>
              <th className="text-left pb-2">Profile</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-cyber-border/40">
            {KNOWN_AGENTS.map((agent, idx) => {
              const streetRaw = balances?.[idx * 2]?.result as bigint | undefined;
              const usdcRaw   = balances?.[idx * 2 + 1]?.result as bigint | undefined;
              const street = streetRaw !== undefined ? Number(formatUnits(streetRaw, 18)).toLocaleString(undefined, { maximumFractionDigits: 0 }) : '—';
              const usdc   = usdcRaw   !== undefined ? Number(formatUnits(usdcRaw, 6)).toLocaleString(undefined, { maximumFractionDigits: 2 }) : '—';
              const placeholder = isPlaceholder(agent.address);

              return (
                <tr key={agent.name} className="hover:bg-white/[0.02] transition-colors">
                  <td className="py-2.5 pr-4">
                    <span className="text-gray-200 font-medium text-xs">{agent.name}</span>
                  </td>
                  <td className="py-2.5 pr-4">
                    <span className="text-xs px-2 py-0.5 bg-base-blue/10 text-base-blue rounded-full">{agent.role}</span>
                  </td>
                  <td className="py-2.5 pr-4">
                    <div className="flex items-center gap-1.5">
                      <code className={`text-xs font-mono ${placeholder ? 'text-yellow-500/60' : 'text-gray-400'}`}>
                        {placeholder ? 'placeholder' : `${agent.address.slice(0, 8)}…${agent.address.slice(-6)}`}
                      </code>
                      {!placeholder && (
                        <a href={`${BASESCAN}/address/${agent.address}`} target="_blank" rel="noopener noreferrer" className="text-gray-600 hover:text-gray-300">
                          <ExternalLink size={10} />
                        </a>
                      )}
                    </div>
                  </td>
                  <td className="py-2.5 pr-4 text-right">
                    {isLoading ? <span className="inline-block w-12 h-3 bg-white/5 rounded animate-pulse" /> : <span className="text-xs text-white">{street}</span>}
                  </td>
                  <td className="py-2.5 pr-4 text-right">
                    {isLoading ? <span className="inline-block w-10 h-3 bg-white/5 rounded animate-pulse" /> : <span className="text-xs text-white">${usdc}</span>}
                  </td>
                  <td className="py-2.5">
                    {placeholder ? (
                      <span className="text-xs text-gray-600 flex items-center gap-1"><User size={10} /> —</span>
                    ) : (
                      <Link to={`/profile/${agent.address}`} className="text-xs text-base-blue/70 hover:text-base-blue transition-colors">
                        View →
                      </Link>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// ─── Quick reference ──────────────────────────────────────────────────────────

function QuickReferencePanel() {
  const cmds = [
    { label: 'Seed testnet (all)', cmd: 'npm run seed' },
    { label: 'Seed dry-run', cmd: 'npm run seed:check' },
    { label: 'Seed loans only', cmd: 'npm run seed:loans' },
    { label: 'Seed options only', cmd: 'npm run seed:options' },
    { label: 'Deploy test tokens', cmd: 'forge script script/DeployTestTokens.s.sol --rpc-url base_sepolia --broadcast' },
    { label: 'Run all tests', cmd: 'bash scripts/run-tests.sh' },
    { label: 'Run tests verbose', cmd: 'forge test -vvv' },
    { label: 'Fuzz (1000 runs)', cmd: 'forge test --fuzz-runs 1000 --match-test "^testFuzz_"' },
    { label: 'Gas report', cmd: 'forge test --gas-report' },
    { label: 'Deploy all (testnet)', cmd: 'forge script script/DeployClawStreet.s.sol --rpc-url base_sepolia --broadcast' },
  ];

  const [copied, setCopied] = useState<string | null>(null);

  const copy = (cmd: string) => {
    navigator.clipboard.writeText(cmd);
    setCopied(cmd);
    setTimeout(() => setCopied(null), 1500);
  };

  return (
    <div className="bg-cyber-surface border border-cyber-border rounded-xl p-4">
      <SectionHeader title="Quick Commands" />
      <div className="space-y-1.5">
        {cmds.map(({ label, cmd }) => (
          <div key={cmd} className="flex items-center justify-between gap-3 py-1.5 border-b border-cyber-border/30 last:border-0">
            <span className="text-xs text-gray-400 w-40 shrink-0">{label}</span>
            <code className="text-xs text-gray-200 font-mono flex-1 truncate">{cmd}</code>
            <button
              onClick={() => copy(cmd)}
              className="text-xs px-2 py-0.5 bg-white/5 text-gray-400 rounded hover:bg-base-blue/20 hover:text-base-blue transition-colors shrink-0"
            >
              {copied === cmd ? 'Copied!' : 'Copy'}
            </button>
          </div>
        ))}
      </div>
    </div>
  );
}

// ─── Main dashboard ───────────────────────────────────────────────────────────

export default function AdminDashboard() {
  const [lastRefresh, setLastRefresh] = useState(new Date());

  useEffect(() => {
    const id = setInterval(() => setLastRefresh(new Date()), 30_000);
    return () => clearInterval(id);
  }, []);

  return (
    <div className="max-w-7xl mx-auto px-4 py-8 space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-white">Admin / Test Dashboard</h1>
          <p className="text-sm text-gray-400 mt-1">Protocol health, agent registry, and test tooling</p>
        </div>
        <div className="text-right">
          <p className="text-xs text-gray-500">Auto-refresh every 30s</p>
          <p className="text-xs text-gray-600">{lastRefresh.toLocaleTimeString()}</p>
        </div>
      </div>

      {/* Top row: contracts + wallet */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <ContractHealthPanel />
        <WalletPanel />
      </div>

      {/* Protocol stats */}
      <ProtocolStatsPanel />

      {/* Agent registry */}
      <AgentRegistryPanel />

      {/* Quick commands */}
      <QuickReferencePanel />

      {/* External links */}
      <div className="bg-cyber-surface border border-cyber-border rounded-xl p-4">
        <SectionHeader title="Testnet Resources" />
        <div className="flex flex-wrap gap-3">
          {[
            { label: 'Base Sepolia Explorer', url: 'https://sepolia.basescan.org' },
            { label: 'ETH Faucet (Coinbase)', url: 'https://www.coinbase.com/faucets/base-ethereum-goerli-faucet' },
            { label: 'USDC Faucet (Circle)', url: 'https://faucet.circle.com' },
            { label: 'Pyth Base Sepolia', url: 'https://pyth.network/developers/price-feed-ids' },
            { label: 'Tenderly', url: 'https://tenderly.co' },
          ].map(({ label, url }) => (
            <a
              key={url}
              href={url}
              target="_blank"
              rel="noopener noreferrer"
              className="text-sm px-3 py-1.5 bg-white/5 text-gray-300 border border-white/10 rounded-md hover:bg-base-blue/10 hover:text-base-blue hover:border-base-blue/30 transition-colors"
            >
              {label} ↗
            </a>
          ))}
        </div>
      </div>
    </div>
  );
}
