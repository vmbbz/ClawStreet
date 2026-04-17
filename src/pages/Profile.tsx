import { useState, useEffect } from 'react';
import { useParams, Link } from 'react-router-dom';
import { usePublicClient, useReadContracts } from 'wagmi';
import { formatUnits, parseAbiItem, type Address } from 'viem';
import { motion } from 'motion/react';
import {
  ArrowLeft, Copy, ExternalLink, Bot, User,
  Wallet, TrendingUp, Activity, Clock, CheckCircle2, AlertCircle
} from 'lucide-react';
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
  const events: DealEvent[] = [];

  try {
    // Use a recent block window — public RPC limits getLogs to 10,000 blocks
    const currentBlock = await publicClient.getBlockNumber();
    const fromBlock = currentBlock > 9500n ? currentBlock - 9500n : 0n;

    // Loan events (borrower = creator)
    const loanCreated = await publicClient.getLogs({
      address: CONTRACT_ADDRESSES.LOAN_ENGINE,
      event: parseAbiItem('event LoanCreated(uint256 indexed loanId, address indexed borrower, uint256 principal, uint256 health)'),
      args: { borrower: address },
      fromBlock,
    });
    for (const log of loanCreated) {
      const block = await publicClient.getBlock({ blockHash: log.blockHash as `0x${string}` });
      events.push({
        type: 'LoanCreated',
        id: log.args.loanId?.toString() ?? '?',
        txHash: log.transactionHash ?? '',
        blockNumber: log.blockNumber ?? 0n,
        timestamp: Number(block.timestamp) * 1000,
        detail: `Created loan #${log.args.loanId} — ${formatUnits(log.args.principal ?? 0n, 6)} USDC`,
      });
    }

    // Loan accepted (lender)
    const loanAccepted = await publicClient.getLogs({
      address: CONTRACT_ADDRESSES.LOAN_ENGINE,
      event: parseAbiItem('event LoanAccepted(uint256 indexed loanId, address indexed lender)'),
      args: { lender: address },
      fromBlock,
    });
    for (const log of loanAccepted) {
      const block = await publicClient.getBlock({ blockHash: log.blockHash as `0x${string}` });
      events.push({
        type: 'LoanAccepted',
        id: log.args.loanId?.toString() ?? '?',
        txHash: log.transactionHash ?? '',
        blockNumber: log.blockNumber ?? 0n,
        timestamp: Number(block.timestamp) * 1000,
        detail: `Funded loan #${log.args.loanId}`,
      });
    }

    // Options written
    const optionWritten = await publicClient.getLogs({
      address: CONTRACT_ADDRESSES.CALL_VAULT,
      event: parseAbiItem('event OptionWritten(uint256 indexed optionId, address indexed writer, uint256 amount, uint256 strike, uint256 premium)'),
      args: { writer: address },
      fromBlock,
    });
    for (const log of optionWritten) {
      const block = await publicClient.getBlock({ blockHash: log.blockHash as `0x${string}` });
      events.push({
        type: 'OptionWritten',
        id: log.args.optionId?.toString() ?? '?',
        txHash: log.transactionHash ?? '',
        blockNumber: log.blockNumber ?? 0n,
        timestamp: Number(block.timestamp) * 1000,
        detail: `Wrote call option #${log.args.optionId} — strike ${formatUnits(log.args.strike ?? 0n, 6)} USDC`,
      });
    }

    // Options bought
    const optionBought = await publicClient.getLogs({
      address: CONTRACT_ADDRESSES.CALL_VAULT,
      event: parseAbiItem('event OptionBought(uint256 indexed optionId, address indexed buyer)'),
      args: { buyer: address },
      fromBlock,
    });
    for (const log of optionBought) {
      const block = await publicClient.getBlock({ blockHash: log.blockHash as `0x${string}` });
      events.push({
        type: 'OptionBought',
        id: log.args.optionId?.toString() ?? '?',
        txHash: log.transactionHash ?? '',
        blockNumber: log.blockNumber ?? 0n,
        timestamp: Number(block.timestamp) * 1000,
        detail: `Bought option #${log.args.optionId}`,
      });
    }

    // Staking
    const staked = await publicClient.getLogs({
      address: CONTRACT_ADDRESSES.STAKING,
      event: parseAbiItem('event Staked(address indexed staker, uint256 amount, uint256 totalStaked)'),
      args: { staker: address },
      fromBlock,
    });
    for (const log of staked) {
      const block = await publicClient.getBlock({ blockHash: log.blockHash as `0x${string}` });
      events.push({
        type: 'Staked',
        id: '—',
        txHash: log.transactionHash ?? '',
        blockNumber: log.blockNumber ?? 0n,
        timestamp: Number(block.timestamp) * 1000,
        detail: `Staked ${formatUnits(log.args.amount ?? 0n, 18)} STREET`,
      });
    }

    events.sort((a, b) => Number(b.blockNumber) - Number(a.blockNumber));
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
  OptionWritten: 'text-purple-400 bg-purple-500/10 border-purple-500/20',
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

// ─── Main Component ───────────────────────────────────────────────────────────

export default function Profile() {
  const { address: paramAddress } = useParams<{ address: string }>();
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

  // ETH balance
  useEffect(() => {
    if (!publicClient || !address) return;
    publicClient.getBalance({ address }).then(bal => {
      setEthBalance(parseFloat(formatUnits(bal, 18)).toFixed(4));
    }).catch(() => {});
  }, [publicClient, address]);

  // Chain events
  useEffect(() => {
    if (!publicClient || !address) return;
    setLoadingEvents(true);
    fetchAddressEvents(publicClient, address).then(evts => {
      setEvents(evts);
      setLoadingEvents(false);
    });
  }, [publicClient, address]);

  if (!address || address.length < 10) {
    return (
      <div className="max-w-3xl mx-auto px-4 py-20 text-center text-gray-400">
        <AlertCircle className="mx-auto mb-4" size={40} />
        <p>Invalid address.</p>
        <Link to="/" className="text-base-blue hover:underline mt-4 block">Go home</Link>
      </div>
    );
  }

  const totalDeals = events.length;
  const loansCreated = events.filter(e => e.type === 'LoanCreated').length;
  const loansFunded  = events.filter(e => e.type === 'LoanAccepted').length;
  const optionsWritten = events.filter(e => e.type === 'OptionWritten').length;
  const optionsBought  = events.filter(e => e.type === 'OptionBought').length;

  return (
    <div className="max-w-5xl mx-auto px-4 sm:px-6 lg:px-8 py-12">
      <Link to={-1 as any} className="inline-flex items-center text-sm text-gray-400 hover:text-white mb-8 transition-colors">
        <ArrowLeft size={16} className="mr-2" />
        Back
      </Link>

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
        <StatCard label="Total Events" value={totalDeals.toString()} />
        <StatCard label="Loans Created" value={loansCreated.toString()} />
        <StatCard label="Loans Funded" value={loansFunded.toString()} />
        <StatCard label="Options" value={(optionsWritten + optionsBought).toString()} sub={`${optionsWritten} written, ${optionsBought} bought`} />
      </div>

      {/* Activity Timeline */}
      <div className="bg-cyber-surface border border-cyber-border rounded-2xl p-6">
        <div className="flex items-center justify-between mb-6">
          <h2 className="text-lg font-semibold text-white flex items-center gap-2">
            <Activity size={18} className="text-base-blue" />
            On-Chain Activity
          </h2>
          {loadingEvents && <span className="text-xs text-gray-500 animate-pulse">Loading from chain...</span>}
        </div>

        {!loadingEvents && events.length === 0 && (
          <div className="text-center py-12 text-gray-500">
            <Clock className="mx-auto mb-3" size={32} />
            <p className="text-sm">No on-chain activity found for this address.</p>
            {isAgent && (
              <p className="text-xs mt-2">Run <code className="font-mono bg-cyber-bg px-1.5 py-0.5 rounded">npm run seed</code> to generate activity.</p>
            )}
          </div>
        )}

        <div className="space-y-3">
          {events.map((event, i) => (
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
        {!loadingEvents && events.length > 0 && (
          <div className="mt-6 pt-4 border-t border-cyber-border">
            <p className="text-xs text-gray-500 mb-3">Quick links to active deals:</p>
            <div className="flex flex-wrap gap-2">
              {events.filter(e => e.type === 'LoanCreated').map(e => (
                <Link key={e.txHash} to={`/loan/${e.id}`} className="text-xs px-3 py-1.5 bg-cyber-bg border border-cyber-border rounded-lg text-gray-300 hover:text-white hover:border-base-blue/50 transition-colors">
                  Loan #{e.id}
                </Link>
              ))}
              {events.filter(e => e.type === 'OptionWritten').map(e => (
                <Link key={e.txHash} to={`/option/${e.id}`} className="text-xs px-3 py-1.5 bg-cyber-bg border border-cyber-border rounded-lg text-gray-300 hover:text-white hover:border-purple-500/50 transition-colors">
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
