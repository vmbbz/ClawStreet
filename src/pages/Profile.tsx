import { useState, useEffect, useMemo } from 'react';
import { useParams, Link } from 'react-router-dom';
import { usePublicClient, useReadContracts, useAccount, useSignMessage } from 'wagmi';
import { formatUnits, parseAbiItem, type Address } from 'viem';
import { motion } from 'motion/react';
import {
  ArrowLeft, Copy, ExternalLink, Bot, User,
  Wallet, TrendingUp, Activity, Clock, CheckCircle2, AlertCircle,
  UserPlus, UserMinus, RefreshCw,
} from 'lucide-react';
import { toast } from '../components/Toast';
import {
  CONTRACT_ADDRESSES, clawStreetLoanABI, clawStreetCallVaultABI,
  clawTokenABI, clawStreetStakingABI, erc20ABI,
  getAgentInfo, BASESCAN, type AgentInfo,
} from '../config/contracts';

// ─── Address helpers ──────────────────────────────────────────────────────────

function truncate(addr: string) {
  return `${addr.slice(0, 6)}...${addr.slice(-4)}`;
}

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      onClick={() => { navigator.clipboard.writeText(text); setCopied(true); setTimeout(() => setCopied(false), 1500); }}
      className="p-1 text-gray-500 hover:text-white transition-colors"
      title="Copy address"
    >
      {copied ? <CheckCircle2 size={14} className="text-green-400" /> : <Copy size={14} />}
    </button>
  );
}

// ─── On-chain event fetching ─────────────────────────────────────────────────

interface DealEvent {
  type: 'LoanCreated' | 'LoanAccepted' | 'LoanRepaid' | 'LoanDefaulted' | 'OptionWritten' | 'OptionBought' | 'OptionExercised' | 'Staked';
  id: string;
  txHash: string;
  blockNumber: bigint;
  timestamp: number;
  detail: string;
}

async function fetchAddressEvents(
  publicClient: ReturnType<typeof usePublicClient>,
  address: Address
): Promise<DealEvent[]> {
  if (!publicClient) return [];

  const seen   = new Set<string>();
  const events: DealEvent[] = [];

  try {
    const currentBlock = await publicClient.getBlockNumber();

    // 3 sequential windows covering ~8h of recent history (timeline only — counts come from readContract).
    // Sequential to avoid rate-limiting the public RPC.
    const WINDOW = 9_500n;
    const windows: { fromBlock: bigint; toBlock: bigint }[] = [];
    for (let i = 0; i < 3; i++) {
      const toBlock   = currentBlock - BigInt(i) * WINDOW;
      const fromBlock = toBlock > WINDOW ? toBlock - WINDOW : 0n;
      if (toBlock >= fromBlock) windows.push({ fromBlock, toBlock });
      if (fromBlock === 0n) break;
    }

    for (const { fromBlock, toBlock } of windows) {
      try {
      const [loanCreated, loanAccepted, optionWritten, optionBought, staked] = await Promise.allSettled([
        publicClient.getLogs({
          address: CONTRACT_ADDRESSES.LOAN_ENGINE,
          event: parseAbiItem('event LoanCreated(uint256 indexed loanId, address indexed borrower, uint256 principal, uint256 health)'),
          args: { borrower: address },
          fromBlock, toBlock,
        }),
        publicClient.getLogs({
          address: CONTRACT_ADDRESSES.LOAN_ENGINE,
          event: parseAbiItem('event LoanAccepted(uint256 indexed loanId, address indexed lender)'),
          args: { lender: address },
          fromBlock, toBlock,
        }),
        publicClient.getLogs({
          address: CONTRACT_ADDRESSES.CALL_VAULT,
          event: parseAbiItem('event OptionWritten(uint256 indexed optionId, address indexed writer, uint256 amount, uint256 strike, uint256 premium)'),
          args: { writer: address },
          fromBlock, toBlock,
        }),
        publicClient.getLogs({
          address: CONTRACT_ADDRESSES.CALL_VAULT,
          event: parseAbiItem('event OptionBought(uint256 indexed optionId, address indexed buyer)'),
          args: { buyer: address },
          fromBlock, toBlock,
        }),
        publicClient.getLogs({
          address: CONTRACT_ADDRESSES.STAKING,
          event: parseAbiItem('event Staked(address indexed staker, uint256 amount, uint256 totalStaked)'),
          args: { staker: address },
          fromBlock, toBlock,
        }),
      ]);

      // Collect block hashes we need to resolve (deduplicated)
      const blockHashMap = new Map<string, bigint>(); // blockHash → timestamp (filled below)

      const allLogs: { result: any[] } = { result: [] };
      for (const r of [loanCreated, loanAccepted, optionWritten, optionBought, staked]) {
        if (r.status === 'fulfilled') for (const log of r.value) allLogs.result.push(log);
      }

      // Fetch block timestamps in parallel for all unique blocks in this window
      const uniqueHashes = [...new Set(allLogs.result.map(l => l.blockHash).filter(Boolean))];
      await Promise.allSettled(uniqueHashes.map(async (hash) => {
        try {
          const blk = await publicClient.getBlock({ blockHash: hash as `0x${string}` });
          blockHashMap.set(hash, blk.timestamp);
        } catch { /* skip */ }
      }));

      // Process loanCreated
      if (loanCreated.status === 'fulfilled') {
        for (const log of loanCreated.value) {
          const key = log.transactionHash ?? `${log.blockNumber}-lc-${log.args.loanId}`;
          if (seen.has(key)) continue; seen.add(key);
          const ts = blockHashMap.get(log.blockHash ?? '') ?? 0n;
          events.push({
            type: 'LoanCreated',
            id: log.args.loanId?.toString() ?? '?',
            txHash: log.transactionHash ?? '',
            blockNumber: log.blockNumber ?? 0n,
            timestamp: Number(ts) * 1000,
            detail: `Created loan #${log.args.loanId} — ${formatUnits(log.args.principal ?? 0n, 6)} USDC`,
          });
        }
      }
      // Process loanAccepted
      if (loanAccepted.status === 'fulfilled') {
        for (const log of loanAccepted.value) {
          const key = log.transactionHash ?? `${log.blockNumber}-la-${log.args.loanId}`;
          if (seen.has(key)) continue; seen.add(key);
          const ts = blockHashMap.get(log.blockHash ?? '') ?? 0n;
          events.push({
            type: 'LoanAccepted',
            id: log.args.loanId?.toString() ?? '?',
            txHash: log.transactionHash ?? '',
            blockNumber: log.blockNumber ?? 0n,
            timestamp: Number(ts) * 1000,
            detail: `Funded loan #${log.args.loanId}`,
          });
        }
      }
      // Process optionWritten
      if (optionWritten.status === 'fulfilled') {
        for (const log of optionWritten.value) {
          const key = log.transactionHash ?? `${log.blockNumber}-ow-${log.args.optionId}`;
          if (seen.has(key)) continue; seen.add(key);
          const ts = blockHashMap.get(log.blockHash ?? '') ?? 0n;
          events.push({
            type: 'OptionWritten',
            id: log.args.optionId?.toString() ?? '?',
            txHash: log.transactionHash ?? '',
            blockNumber: log.blockNumber ?? 0n,
            timestamp: Number(ts) * 1000,
            detail: `Wrote call option #${log.args.optionId} — strike ${formatUnits(log.args.strike ?? 0n, 6)} USDC`,
          });
        }
      }
      // Process optionBought
      if (optionBought.status === 'fulfilled') {
        for (const log of optionBought.value) {
          const key = log.transactionHash ?? `${log.blockNumber}-ob-${log.args.optionId}`;
          if (seen.has(key)) continue; seen.add(key);
          const ts = blockHashMap.get(log.blockHash ?? '') ?? 0n;
          events.push({
            type: 'OptionBought',
            id: log.args.optionId?.toString() ?? '?',
            txHash: log.transactionHash ?? '',
            blockNumber: log.blockNumber ?? 0n,
            timestamp: Number(ts) * 1000,
            detail: `Bought option #${log.args.optionId}`,
          });
        }
      }
      // Process staked
      if (staked.status === 'fulfilled') {
        for (const log of staked.value) {
          const key = log.transactionHash ?? `${log.blockNumber}-st`;
          if (seen.has(key)) continue; seen.add(key);
          const ts = blockHashMap.get(log.blockHash ?? '') ?? 0n;
          events.push({
            type: 'Staked',
            id: '—',
            txHash: log.transactionHash ?? '',
            blockNumber: log.blockNumber ?? 0n,
            timestamp: Number(ts) * 1000,
            detail: `Staked ${formatUnits(log.args.amount ?? 0n, 18)} STREET`,
          });
        }
      }
      } catch { /* skip failed window */ }
    }

    events.sort((a, b) => {
      const diff = b.blockNumber - a.blockNumber;
      return diff > 0n ? 1 : diff < 0n ? -1 : 0;
    });
  } catch (e) {
    console.error('Profile event fetch error:', e);
  }

  return events;
}

// ─── Event type styling ───────────────────────────────────────────────────────

const EVENT_COLORS: Record<string, string> = {
  LoanCreated:   'text-yellow-400 bg-yellow-500/10 border-yellow-500/20',
  LoanAccepted:  'text-blue-400 bg-blue-500/10 border-blue-500/20',
  LoanRepaid:    'text-green-400 bg-green-500/10 border-green-500/20',
  LoanDefaulted: 'text-red-400 bg-red-500/10 border-red-500/20',
  OptionWritten: 'text-base-blue bg-base-blue/10 border-base-blue/20',
  OptionBought:  'text-cyan-400 bg-cyan-500/10 border-cyan-500/20',
  OptionExercised: 'text-green-400 bg-green-500/10 border-green-500/20',
  Staked:        'text-orange-400 bg-orange-500/10 border-orange-500/20',
};

const EVENT_LABELS: Record<string, string> = {
  LoanCreated:   'Loan Created',
  LoanAccepted:  'Loan Funded',
  LoanRepaid:    'Loan Repaid',
  LoanDefaulted: 'Defaulted',
  OptionWritten: 'Call Written',
  OptionBought:  'Call Bought',
  OptionExercised: 'Exercised',
  Staked:        'Staked',
};

// ─── Stat Card ────────────────────────────────────────────────────────────────

function StatCard({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="bg-cyber-bg border border-cyber-border rounded-xl p-4">
      <p className="text-[11px] text-gray-500 uppercase tracking-wider mb-1">{label}</p>
      <p className="text-xl font-bold text-white">{value}</p>
      {sub && <p className="text-xs text-gray-500 mt-0.5">{sub}</p>}
    </div>
  );
}

// ─── Announce Panel (own profile only) ────────────────────────────────────────

const VALID_ANNOUNCE_ROLES = ['Market Maker', 'Lender', 'Borrower', 'Options Writer', 'Arbitrageur'] as const;

function AnnouncePanel({ address }: { address: string }) {
  const { signMessageAsync } = useSignMessage();
  const [open, setOpen]     = useState(false);
  const [registered, setRegistered] = useState<{ name: string } | null>(null);
  const [form, setForm]     = useState({
    name: '', role: 'Lender', contact: '',
    participantType: 'human' as 'agent' | 'human',
  });
  const [busy, setBusy] = useState(false);

  // Check if already registered
  useEffect(() => {
    fetch(`/api/agents/${address}`)
      .then(r => r.ok ? r.json() : null)
      .then(entry => {
        if (entry && !entry.isInternal) setRegistered({ name: entry.name });
      })
      .catch(() => {});
  }, [address]);

  async function handleAnnounce() {
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
        body: JSON.stringify({ address, name: form.name, contact: form.contact, role: form.role, participantType: form.participantType, timestamp, signature }),
      });
      const data = await res.json();
      if (data.success) {
        setRegistered({ name: form.name });
        setOpen(false);
        toast.success('You\'re now announced in the agent registry!');
      } else {
        toast.error(data.error ?? 'Announcement failed');
      }
    } catch (e: any) {
      if (e?.code !== 4001) toast.error(e?.message ?? 'Sign failed');
    } finally {
      setBusy(false);
    }
  }

  async function handleSignOut() {
    setBusy(true);
    try {
      const timestamp = Math.floor(Date.now() / 1000);
      const message = `ClawStreet Sign-Out\nAddress: ${address.toLowerCase()}\nTimestamp: ${timestamp}`;
      const signature = await signMessageAsync({ account: address as `0x${string}`, message });
      const res = await fetch('/api/agents/announce', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ address, timestamp, signature }),
      });
      const data = await res.json();
      if (data.success) {
        setRegistered(null);
        toast.success('Removed from agent registry.');
      } else {
        toast.error(data.error ?? 'Sign-out failed');
      }
    } catch (e: any) {
      if (e?.code !== 4001) toast.error(e?.message ?? 'Sign failed');
    } finally {
      setBusy(false);
    }
  }

  if (registered) {
    return (
      <div className="mb-6 flex items-center justify-between p-4 bg-teal-500/8 border border-teal-500/25 rounded-xl">
        <div className="flex items-center gap-3">
          <span className="text-teal-400 text-lg">🤖</span>
          <div>
            <p className="text-sm font-medium text-teal-400">Announced as <strong>{registered.name}</strong></p>
            <p className="text-xs text-gray-500">Visible in the Agent Observatory. Re-announce within 24h to stay active.</p>
          </div>
        </div>
        <button
          onClick={handleSignOut}
          disabled={busy}
          className="flex items-center gap-1.5 px-3 py-1.5 text-xs text-gray-500 hover:text-red-400 border border-gray-700 hover:border-red-500/40 rounded-lg transition-colors"
        >
          {busy ? <RefreshCw size={12} className="animate-spin" /> : <UserMinus size={12} />}
          Sign Out
        </button>
      </div>
    );
  }

  return (
    <div className="mb-6">
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
                placeholder="MyBot-1 or YourName"
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
                {VALID_ANNOUNCE_ROLES.map(r => <option key={r}>{r}</option>)}
              </select>
            </div>
            <div>
              <label className="text-[10px] text-gray-500 uppercase tracking-wider block mb-1">Type *</label>
              <select
                value={form.participantType}
                onChange={e => setForm(f => ({ ...f, participantType: e.target.value as 'agent' | 'human' }))}
                className="w-full bg-cyber-bg border border-cyber-border rounded-md px-3 py-2 text-sm text-white focus:outline-none focus:border-teal-500/50"
              >
                <option value="human">Human Participant</option>
                <option value="agent">Autonomous Agent</option>
              </select>
            </div>
            <div>
              <label className="text-[10px] text-gray-500 uppercase tracking-wider block mb-1">
                Contact URL <span className="text-gray-600 normal-case">(optional)</span>
              </label>
              <input
                value={form.contact}
                onChange={e => setForm(f => ({ ...f, contact: e.target.value }))}
                placeholder="https://your-bot.example.com/bargain"
                className="w-full bg-cyber-bg border border-cyber-border rounded-md px-3 py-2 text-sm text-white placeholder-gray-600 focus:outline-none focus:border-teal-500/50"
              />
            </div>
          </div>
          <div className="flex items-center gap-3">
            <button
              onClick={handleAnnounce}
              disabled={busy || !form.name.trim()}
              className="flex items-center gap-2 px-4 py-2 bg-teal-500 text-white rounded-lg text-sm font-medium hover:bg-teal-400 disabled:opacity-40 transition-colors"
            >
              {busy ? <RefreshCw size={13} className="animate-spin" /> : <UserPlus size={13} />}
              Sign & Announce
            </button>
            <p className="text-[10px] text-gray-600">Expires 24h after your last sign-in.</p>
          </div>
        </div>
      )}
    </div>
  );
}

// ─── Main Component ───────────────────────────────────────────────────────────

export default function Profile() {
  const { address: paramAddress } = useParams<{ address: string }>();
  const { address: connectedAddress } = useAccount();
  const publicClient = usePublicClient();
  const [events, setEvents] = useState<DealEvent[]>([]);
  const [loadingEvents, setLoadingEvents] = useState(true);
  const [ethBalance, setEthBalance] = useState<string | null>(null);

  const address = (paramAddress ?? '') as Address;
  const agentInfo: AgentInfo | null = getAgentInfo(address);
  const isAgent = !!agentInfo;

  // Batch read token balances + staking position
  const { data: reads } = useReadContracts({
    contracts: [
      { address: CONTRACT_ADDRESSES.CLAW_TOKEN, abi: clawTokenABI, functionName: 'balanceOf', args: [address] },
      { address: CONTRACT_ADDRESSES.MOCK_USDC, abi: erc20ABI, functionName: 'balanceOf', args: [address] },
      { address: CONTRACT_ADDRESSES.STAKING, abi: clawStreetStakingABI, functionName: 'positions', args: [address] },
      { address: CONTRACT_ADDRESSES.LOAN_ENGINE, abi: clawStreetLoanABI, functionName: 'loanCounter' },
      { address: CONTRACT_ADDRESSES.CALL_VAULT, abi: clawStreetCallVaultABI, functionName: 'optionCounter' },
    ],
    query: { enabled: !!address },
  });

  const streetBalance = reads?.[0]?.result as bigint | undefined;
  const usdcBalance   = reads?.[1]?.result as bigint | undefined;
  const stakingPos    = reads?.[2]?.result as readonly [bigint, bigint, bigint, bigint, boolean] | undefined;
  const loanCount     = reads?.[3]?.result as bigint | undefined;
  const optionCount   = reads?.[4]?.result as bigint | undefined;

  // ── Contract reads for deal structs (counts from loans(i) / options(j)) ──────
  // Memoized so wagmi sees a stable reference and doesn't re-issue on every render
  const dealCalls = useMemo(() => [
    ...Array.from({ length: Number(loanCount ?? 0) }, (_, i) => ({
      address: CONTRACT_ADDRESSES.LOAN_ENGINE as `0x${string}`,
      abi: clawStreetLoanABI,
      functionName: 'loans' as const,
      args: [BigInt(i)] as [bigint],
    })),
    ...Array.from({ length: Number(optionCount ?? 0) }, (_, i) => ({
      address: CONTRACT_ADDRESSES.CALL_VAULT as `0x${string}`,
      abi: clawStreetCallVaultABI,
      functionName: 'options' as const,
      args: [BigInt(i)] as [bigint],
    })),
  // eslint-disable-next-line react-hooks/exhaustive-deps
  ], [Number(loanCount ?? 0), Number(optionCount ?? 0)]);

  const { data: dealReads } = useReadContracts({
    contracts: dealCalls,
    query: { enabled: loanCount !== undefined && optionCount !== undefined, refetchInterval: 30_000 },
  });

  // Derive counts from contract reads — wagmi returns tuple results as plain arrays
  // loan: [0]=borrower, [1]=lender, [10]=repaid
  // option: [0]=writer, [1]=buyer, [7]=exercised
  const nLoan      = Number(loanCount ?? 0);
  const loanData   = dealReads?.slice(0, nLoan).map(r => r.result as any[] | undefined) ?? [];
  const optionData = dealReads?.slice(nLoan).map(r => r.result as any[] | undefined) ?? [];
  const addr       = address.toLowerCase();
  const ZERO       = '0x0000000000000000000000000000000000000000';

  const loansCreated   = loanData.filter(l => l && (l[0] as string)?.toLowerCase() === addr).length;
  const loansFunded    = loanData.filter(l => l && (l[1] as string)?.toLowerCase() === addr && l[1] !== ZERO).length;
  const optionsWritten = optionData.filter(o => o && (o[0] as string)?.toLowerCase() === addr).length;
  const optionsBought  = optionData.filter(o => o && (o[1] as string)?.toLowerCase() === addr && o[1] !== ZERO).length;
  const totalDeals     = loansCreated + loansFunded + optionsWritten + optionsBought;
  const statsLoading   = loanCount === undefined || optionCount === undefined ||
    (dealCalls.length > 0 && dealReads === undefined);

  // ── Build timeline events from contract reads (no getLogs needed) ─────────────
  // loan: [0]=borrower, [1]=lender, [3]=nftId, [4]=principal, [5]=interest, [7]=startTime, [9]=active, [10]=repaid
  // option: [0]=writer, [1]=buyer, [3]=amount, [4]=strike, [5]=expiry, [6]=premium, [7]=exercised
  const contractEvents: DealEvent[] = useMemo(() => {
    const evts: DealEvent[] = [];
    loanData.forEach((l, i) => {
      if (!l) return;
      const startTime = Number(l[7] as bigint) * 1000;
      if ((l[0] as string)?.toLowerCase() === addr) {
        evts.push({
          type: 'LoanCreated', id: String(i), txHash: '',
          blockNumber: l[7] as bigint,
          timestamp: startTime,
          detail: `Created loan #${i} — ${formatUnits(l[4] as bigint, 6)} USDC${l[10] ? ' · Repaid' : l[9] ? ' · Active' : ''}`,
        });
      }
      if ((l[1] as string)?.toLowerCase() === addr && l[1] !== ZERO) {
        evts.push({
          type: 'LoanAccepted', id: String(i), txHash: '',
          blockNumber: l[7] as bigint,
          timestamp: startTime,
          detail: `Funded loan #${i} — ${formatUnits(l[4] as bigint, 6)} USDC principal`,
        });
      }
    });
    optionData.forEach((o, i) => {
      if (!o) return;
      const expiry = Number(o[5] as bigint) * 1000;
      if ((o[0] as string)?.toLowerCase() === addr) {
        evts.push({
          type: 'OptionWritten', id: String(i), txHash: '',
          blockNumber: o[5] as bigint,
          timestamp: expiry,
          detail: `Wrote call option #${i} — strike ${formatUnits(o[4] as bigint, 6)} USDC, premium ${formatUnits(o[6] as bigint, 6)} USDC${o[7] ? ' · Exercised' : ''}`,
        });
      }
      if ((o[1] as string)?.toLowerCase() === addr && o[1] !== ZERO) {
        evts.push({
          type: 'OptionBought', id: String(i), txHash: '',
          blockNumber: o[5] as bigint,
          timestamp: expiry,
          detail: `Bought option #${i} — strike ${formatUnits(o[4] as bigint, 6)} USDC${o[7] ? ' · Exercised ✓' : ''}`,
        });
      }
    });
    evts.sort((a, b) => {
      const diff = b.blockNumber - a.blockNumber;
      return diff > 0n ? 1 : diff < 0n ? -1 : 0;
    });
    return evts;
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dealReads, addr]);

  // ETH balance
  useEffect(() => {
    if (!publicClient || !address) return;
    publicClient.getBalance({ address }).then(bal => {
      setEthBalance(parseFloat(formatUnits(bal, 18)).toFixed(4));
    }).catch(() => {});
  }, [publicClient, address]);

  // Chain events — stale flag prevents a second effect run from overwriting the first result
  useEffect(() => {
    if (!publicClient || !address) return;
    let stale = false;
    setLoadingEvents(true);
    fetchAddressEvents(publicClient, address).then(evts => {
      if (!stale) {
        setEvents(evts);
        setLoadingEvents(false);
      }
    });
    return () => { stale = true; };
  }, [address, publicClient]); // publicClient can be undefined on first render — must re-run when it resolves

  if (!address || address.length < 10) {
    return (
      <div className="max-w-3xl mx-auto px-4 py-20 text-center text-gray-400">
        <AlertCircle className="mx-auto mb-4" size={40} />
        <p>Invalid address.</p>
        <Link to="/" className="text-base-blue hover:underline mt-4 block">Go home</Link>
      </div>
    );
  }

  return (
    <div className="max-w-5xl mx-auto px-4 sm:px-6 lg:px-8 py-12">
      <Link to={-1 as any} className="inline-flex items-center text-sm text-gray-400 hover:text-white mb-8 transition-colors">
        <ArrowLeft size={16} className="mr-2" />
        Back
      </Link>

      {/* Announce panel — only on own profile, non-agent addresses */}
      {connectedAddress?.toLowerCase() === address.toLowerCase() && !isAgent && (
        <AnnouncePanel address={address} />
      )}

      {/* Identity Card */}
      <motion.div
        initial={{ opacity: 0, y: 10 }}
        animate={{ opacity: 1, y: 0 }}
        className="bg-cyber-surface border border-cyber-border rounded-2xl p-6 mb-6"
      >
        <div className="flex flex-col sm:flex-row sm:items-start gap-4">
          {/* Avatar */}
          <div className={`w-16 h-16 rounded-2xl flex items-center justify-center flex-shrink-0 ${isAgent ? 'bg-orange-500/20 border border-orange-500/30' : 'bg-base-blue/10 border border-base-blue/20'}`}>
            {isAgent ? <Bot size={32} className="text-orange-400" /> : <User size={32} className="text-base-blue" />}
          </div>

          {/* Info */}
          <div className="flex-grow">
            <div className="flex flex-wrap items-center gap-2 mb-1">
              <h1 className="text-xl font-bold text-white">
                {isAgent ? agentInfo.name : truncate(address)}
              </h1>
              <span className={`text-[10px] font-bold px-2 py-0.5 rounded uppercase tracking-wider ${isAgent ? 'bg-orange-500/20 text-orange-400 border border-orange-500/30' : 'bg-base-blue/10 text-base-blue border border-base-blue/20'}`}>
                {isAgent ? 'AI AGENT' : 'USER'}
              </span>
              {isAgent && (
                <span className="text-[10px] px-2 py-0.5 rounded bg-green-500/10 text-green-400 border border-green-500/20 uppercase tracking-wider">
                  {agentInfo.role}
                </span>
              )}
            </div>
            <div className="flex items-center gap-2 text-sm text-gray-400 font-mono">
              <span>{address}</span>
              <CopyButton text={address} />
              <a href={`${BASESCAN}/address/${address}`} target="_blank" rel="noopener noreferrer" className="text-gray-500 hover:text-white transition-colors">
                <ExternalLink size={14} />
              </a>
            </div>
            {isAgent && (
              <p className="text-xs text-gray-500 mt-1">Deployed {agentInfo.createdAt} · Autonomous AI market participant</p>
            )}
          </div>

          {/* Reputation badge */}
          <div className="bg-green-500/10 border border-green-500/20 rounded-xl px-4 py-3 text-center flex-shrink-0">
            <p className="text-[10px] text-gray-500 uppercase tracking-wider mb-1">x402 Score</p>
            <p className="text-2xl font-bold text-green-400">850</p>
            <p className="text-[10px] text-green-500">Tier 1</p>
          </div>
        </div>
      </motion.div>

      {/* Balances — agents only show full detail, users show nothing sensitive */}
      {isAgent && (
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-4 mb-6">
          <StatCard label="STREET" value={streetBalance !== undefined ? parseFloat(formatUnits(streetBalance, 18)).toLocaleString() : '—'} sub="$STREET token" />
          <StatCard label="USDC" value={usdcBalance !== undefined ? parseFloat(formatUnits(usdcBalance, 6)).toLocaleString() : '—'} sub="Mock USDC" />
          <StatCard label="ETH" value={ethBalance ?? '—'} sub="Base Sepolia" />
          <StatCard label="Staked" value={stakingPos ? parseFloat(formatUnits(stakingPos[0], 18)).toLocaleString() : '—'} sub={stakingPos?.[4] ? 'ClawPass ✓' : 'No ClawPass'} />
        </div>
      )}

{/* Activity Stats */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-4 mb-6">
        <StatCard label="Total Deals" value={statsLoading ? '…' : totalDeals.toString()} />
        <StatCard label="Loans Created" value={statsLoading ? '…' : loansCreated.toString()} />
        <StatCard label="Loans Funded" value={statsLoading ? '…' : loansFunded.toString()} />
        <StatCard label="Options" value={statsLoading ? '…' : (optionsWritten + optionsBought).toString()} sub={statsLoading ? undefined : `${optionsWritten} written, ${optionsBought} bought`} />
      </div>

      {/* Activity Timeline */}
      <div className="bg-cyber-surface border border-cyber-border rounded-2xl p-6">
        <div className="flex items-center justify-between mb-6">
          <h2 className="text-lg font-semibold text-white flex items-center gap-2">
            <Activity size={18} className="text-base-blue" />
            On-Chain Activity
          </h2>
          {statsLoading && <span className="text-xs text-gray-500 animate-pulse">Loading from chain...</span>}
        </div>

        {!statsLoading && contractEvents.length === 0 && (
          <div className="text-center py-12 text-gray-500">
            <Clock className="mx-auto mb-3" size={32} />
            <p className="text-sm">No on-chain activity found for this address.</p>
          </div>
        )}

        <div className="space-y-3">
          {contractEvents.map((event, i) => (
            <motion.div
              key={i}
              initial={{ opacity: 0, x: -10 }}
              animate={{ opacity: 1, x: 0 }}
              transition={{ delay: i * 0.03 }}
              className="flex items-start gap-3 p-3 bg-cyber-bg rounded-xl border border-cyber-border"
            >
              <span className={`text-[10px] font-bold px-2 py-0.5 rounded border whitespace-nowrap mt-0.5 ${EVENT_COLORS[event.type] ?? 'text-gray-400 bg-gray-500/10 border-gray-500/20'}`}>
                {EVENT_LABELS[event.type] ?? event.type}
              </span>
              <div className="flex-grow min-w-0">
                <p className="text-sm text-white">{event.detail}</p>
                <p className="text-[11px] text-gray-500 font-mono mt-0.5">
                  {new Date(event.timestamp).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', hour: '2-digit', minute: '2-digit' })}
                </p>
              </div>
              {event.txHash && (
                <a
                  href={`${BASESCAN}/tx/${event.txHash}`}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-gray-500 hover:text-white transition-colors flex-shrink-0"
                  title="View on Basescan"
                >
                  <ExternalLink size={14} />
                </a>
              )}
            </motion.div>
          ))}
        </div>

        {/* Active Deals links */}
        {!statsLoading && contractEvents.length > 0 && (
          <div className="mt-6 pt-4 border-t border-cyber-border">
            <p className="text-xs text-gray-500 mb-3">Quick links to active deals:</p>
            <div className="flex flex-wrap gap-2">
              {contractEvents.filter(e => e.type === 'LoanCreated').map(e => (
                <Link key={e.id} to={`/loan/${e.id}`} className="text-xs px-3 py-1.5 bg-cyber-bg border border-cyber-border rounded-lg text-gray-300 hover:text-white hover:border-base-blue/50 transition-colors">
                  Loan #{e.id}
                </Link>
              ))}
              {contractEvents.filter(e => e.type === 'OptionWritten').map(e => (
                <Link key={e.id} to={`/option/${e.id}`} className="text-xs px-3 py-1.5 bg-cyber-bg border border-cyber-border rounded-lg text-gray-300 hover:text-white hover:border-base-blue/50 transition-colors">
                  Option #{e.id}
                </Link>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
