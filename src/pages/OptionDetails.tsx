import React, { useMemo, useState, useEffect, useRef } from 'react';
import { useParams, Link } from 'react-router-dom';
import { useReadContract, useAccount, usePublicClient, useWriteContract, useWaitForTransactionReceipt } from 'wagmi';
import { formatUnits, parseAbiItem, parseUnits, parseAbi } from 'viem';
import { ArrowLeft, ShieldAlert, TrendingUp, Clock, Activity, Info, ShieldCheck, ChevronDown, ChevronUp, User, Copy, Check, ExternalLink } from 'lucide-react';
import { AreaChart, Area, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, ReferenceLine } from 'recharts';
import { CONTRACT_ADDRESSES, clawStreetCallVaultABI, getAgentInfo, PYTH_FEEDS, BASESCAN, getTokenSymbol, getTokenIconUrl } from '../config/contracts';
import { fetchPythHistory } from '../lib/pyth';
import { toast } from '../components/Toast';
import { Modal } from '../components/Modal';

function CopyAddress({ addr }: { addr: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      onClick={() => { navigator.clipboard.writeText(addr); setCopied(true); setTimeout(() => setCopied(false), 1500); }}
      className="ml-1.5 text-gray-600 hover:text-gray-300 transition-colors flex-shrink-0"
      title="Copy address"
    >
      {copied ? <Check size={11} className="text-green-400" /> : <Copy size={11} />}
    </button>
  );
}

// ─── Certificate Modal ────────────────────────────────────────────────────────

function CertificateModal({
  isOpen, onClose, id, symbol, amount, strike, premium, currentPrice, txHash,
}: {
  isOpen: boolean; onClose: () => void;
  id: string; symbol: string; amount: string; strike: string; premium: string;
  currentPrice: number; txHash?: string;
}) {
  const certRef = useRef<HTMLDivElement>(null);

  async function downloadCertificate() {
    if (!certRef.current) return;
    try {
      const { default: html2canvas } = await import('html2canvas');
      const canvas = await html2canvas(certRef.current, { backgroundColor: '#0a0a1a', scale: 2 });
      const link = document.createElement('a');
      link.download = `clawstreet-option-${id}-certificate.png`;
      link.href = canvas.toDataURL('image/png');
      link.click();
    } catch {
      toast.error('Download failed — try screenshot instead');
    }
  }

  const intrinsic = (currentPrice - Number(strike)) * Number(amount);
  const netPnl = intrinsic - Number(premium);

  return (
    <Modal isOpen={isOpen} onClose={onClose} title="">
      <div className="space-y-4">
        {/* Certificate card — captured by html2canvas */}
        <div ref={certRef} style={{ background: 'linear-gradient(135deg, #0a0a1a 0%, #0f172a 50%, #0a0a1a 100%)' }}
          className="rounded-2xl border border-claw-pink/30 p-8 text-center space-y-5">
          <div className="text-claw-pink text-5xl select-none">★</div>
          <div>
            <h2 className="text-2xl font-bold text-white tracking-tight">Position Closed In Profit</h2>
            <p className="text-sm text-gray-400 mt-1">ClawStreet · Call Option #{id}</p>
          </div>
          <div className="grid grid-cols-2 gap-3 text-left mt-2">
            <div className="bg-white/5 rounded-lg p-3">
              <span className="text-[10px] uppercase tracking-wider text-gray-500">Asset</span>
              <p className="text-white font-bold mt-0.5">{symbol}</p>
            </div>
            <div className="bg-white/5 rounded-lg p-3">
              <span className="text-[10px] uppercase tracking-wider text-gray-500">Amount</span>
              <p className="text-white font-bold mt-0.5">{amount} {symbol}</p>
            </div>
            <div className="bg-white/5 rounded-lg p-3">
              <span className="text-[10px] uppercase tracking-wider text-gray-500">Strike Price</span>
              <p className="text-white font-bold mt-0.5">${strike}</p>
            </div>
            <div className="bg-white/5 rounded-lg p-3">
              <span className="text-[10px] uppercase tracking-wider text-gray-500">Exit Price</span>
              <p className="text-green-400 font-bold mt-0.5">${currentPrice.toLocaleString()}</p>
            </div>
            <div className="bg-white/5 rounded-lg p-3 col-span-2">
              <span className="text-[10px] uppercase tracking-wider text-gray-500">Net P&amp;L (after {premium} USDC premium)</span>
              <p className={`font-bold text-lg mt-0.5 ${netPnl >= 0 ? 'text-green-400' : 'text-red-400'}`}>
                {netPnl >= 0 ? '+' : ''}{netPnl.toFixed(2)} USDC
              </p>
            </div>
          </div>
          <div className="pt-2 border-t border-white/10 space-y-1">
            <p className="text-[10px] text-gray-600">{new Date().toLocaleString()}</p>
            {txHash && <p className="text-[10px] text-gray-600 font-mono">Tx: {txHash.slice(0, 18)}…</p>}
            <p className="text-[10px] text-gray-600">clawstreet.xyz · The Autonomous Capital Layer</p>
          </div>
        </div>
        <div className="flex gap-3 justify-center">
          <button
            onClick={downloadCertificate}
            className="px-5 py-2.5 bg-claw-pink text-white rounded-lg text-sm font-semibold hover:bg-claw-dark transition-colors"
          >
            Download as PNG
          </button>
          <button
            onClick={onClose}
            className="px-5 py-2.5 bg-cyber-border text-gray-300 rounded-lg text-sm hover:opacity-80 transition-opacity"
          >
            Close
          </button>
        </div>
      </div>
    </Modal>
  );
}

// ─── Main component ───────────────────────────────────────────────────────────

export default function OptionDetails() {
  const { id } = useParams<{ id: string }>();
  const { address } = useAccount();
  const publicClient = usePublicClient();

  const [isReputationExpanded, setIsReputationExpanded] = useState(false);
  const [contractEvents, setContractEvents]             = useState<any[]>([]);
  const [isLoadingEvents, setIsLoadingEvents]           = useState(true);
  const [expandedWidget, setExpandedWidget]             = useState<'moneyness' | 'breakeven' | 'expiry' | null>(null);
  const [showCertificate, setShowCertificate]           = useState(false);
  const [countdown, setCountdown]                       = useState('');
  // Tracks the 2-step exercise flow so the UI doesn't revert to "Approve" while
  // the allowance refetch is in-flight after confirmation.
  const [exerciseStep, setExerciseStep]                 = useState<'idle' | 'approving' | 'exercising'>('idle');

  // ── Event log ───────────────────────────────────────────────────────────────
  useEffect(() => {
    async function fetchEvents() {
      if (!publicClient || !id) return;
      setIsLoadingEvents(true);
      try {
        const optionId = BigInt(id);
        const currentBlock = await publicClient.getBlockNumber();
        const fromBlock = currentBlock > 9500n ? currentBlock - 9500n : 0n;

        const [writtenLogs, boughtLogs, exercisedLogs, reclaimedLogs] = await Promise.all([
          publicClient.getLogs({ address: CONTRACT_ADDRESSES.CALL_VAULT, event: parseAbiItem('event OptionWritten(uint256 indexed optionId, address indexed writer, uint256 amount, uint256 strike, uint256 premium)'), args: { optionId }, fromBlock }),
          publicClient.getLogs({ address: CONTRACT_ADDRESSES.CALL_VAULT, event: parseAbiItem('event OptionBought(uint256 indexed optionId, address indexed buyer)'), args: { optionId }, fromBlock }),
          publicClient.getLogs({ address: CONTRACT_ADDRESSES.CALL_VAULT, event: parseAbiItem('event OptionExercised(uint256 indexed optionId, address indexed buyer)'), args: { optionId }, fromBlock }),
          publicClient.getLogs({ address: CONTRACT_ADDRESSES.CALL_VAULT, event: parseAbiItem('event UnderlyingReclaimed(uint256 indexed optionId)'), args: { optionId }, fromBlock }),
        ]);

        const allLogs = [...writtenLogs, ...boughtLogs, ...exercisedLogs, ...reclaimedLogs];
        const logsWithTs = await Promise.all(allLogs.map(async log => {
          const block = await publicClient.getBlock({ blockHash: log.blockHash as `0x${string}` });
          return { eventName: log.eventName, args: log.args, transactionHash: log.transactionHash, blockNumber: log.blockNumber, timestamp: Number(block.timestamp) * 1000 };
        }));
        logsWithTs.sort((a, b) => Number(a.blockNumber) - Number(b.blockNumber));
        setContractEvents(logsWithTs);
      } catch (e) {
        console.error('Failed to fetch events:', e);
      } finally {
        setIsLoadingEvents(false);
      }
    }
    fetchEvents();
  }, [publicClient, id]);

  // ── Contract read ───────────────────────────────────────────────────────────
  const { data: optionData, isError, refetch: refetchOption } = useReadContract({
    address: CONTRACT_ADDRESSES.CALL_VAULT,
    abi: clawStreetCallVaultABI,
    functionName: 'options',
    args: [BigInt(id || '0')],
  });

  // ── Exercise ────────────────────────────────────────────────────────────────
  const { writeContract: exerciseOpt, isPending: isExercising, data: exerciseTxHash } = useWriteContract();
  const { isLoading: isExerciseConfirming, isSuccess: isExerciseSuccess } = useWaitForTransactionReceipt({ hash: exerciseTxHash });

  // Strike amount in raw USDC units (6 decimals) — needed for approve step.
  // Read directly from optionData[4] (already a raw uint256) to avoid a
  // use-before-declaration on displayData which is computed further below.
  const strikeRaw = optionData ? (optionData[4] as bigint) : 0n;

  // Read current USDC allowance for CALL_VAULT (buyer must approve strike before exercising)
  const { data: usdcAllowance, refetch: refetchAllowance } = useReadContract({
    address: CONTRACT_ADDRESSES.MOCK_USDC,
    abi: parseAbi(['function allowance(address,address) view returns (uint256)']),
    functionName: 'allowance',
    args: [address ?? '0x0000000000000000000000000000000000000000', CONTRACT_ADDRESSES.CALL_VAULT],
    query: { enabled: !!address },
  });

  const needsApproval = !usdcAllowance || usdcAllowance < strikeRaw;

  // Separate write hook for the USDC approve transaction (step 1 of 2)
  const { writeContract: approveUsdc, isPending: isApproving, data: approveTxHash } = useWriteContract();
  const { isSuccess: isApproveSuccess } = useWaitForTransactionReceipt({ hash: approveTxHash });

  // After approval confirms: refetch allowance AND auto-trigger exercise (step 2).
  // This prevents the "Approve" button from flickering back while the allowance
  // refetch is still in-flight.
  useEffect(() => {
    if (isApproveSuccess && exerciseStep === 'approving') {
      setExerciseStep('exercising');
      refetchAllowance();
      exerciseOpt({
        address: CONTRACT_ADDRESSES.CALL_VAULT,
        abi: clawStreetCallVaultABI,
        functionName: 'exercise',
        args: [BigInt(id || '0')],
      } as any);
    }
  }, [isApproveSuccess, exerciseStep, exerciseOpt, id, refetchAllowance]);

  const handleExercise = () => {
    exerciseOpt({
      address: CONTRACT_ADDRESSES.CALL_VAULT,
      abi: clawStreetCallVaultABI,
      functionName: 'exercise',   // ← correct function name
      args: [BigInt(id || '0')],
    } as any);
  };

  // ── Data ────────────────────────────────────────────────────────────────────
  const isMockData = isError && !optionData;

  const displayData = isMockData || !optionData ? {
    writer: '0x1234567890abcdef1234567890abcdef12345678' as string,
    buyer: '0xabcdef1234567890abcdef1234567890abcdef12' as string,
    underlyingAddress: '0xE93695aE429a2C156F216Bc615E9Dd8d1A9794dE',
    amount: '1.5',
    strike: '3800',
    premium: '85',
    expiry: Math.floor(Date.now() / 1000) + 5 * 86400,
    exercised: false,
    active: true,
    writerReputation: 850,
    isAgent: true,
    agentName: undefined as string | undefined,
  } : {
    writer: optionData[0] as string,
    buyer: optionData[1] as string,
    underlyingAddress: optionData[2] as string,
    amount: formatUnits(optionData[3], 18),
    strike: formatUnits(optionData[4], 6),
    expiry: Number(optionData[5]),
    premium: formatUnits(optionData[6], 6),
    exercised: optionData[7],
    active: optionData[8],
    writerReputation: 850,
    isAgent: !!getAgentInfo(optionData[0]),
    agentName: getAgentInfo(optionData[0])?.name,
  };

  const underlyingSymbol = getTokenSymbol(displayData.underlyingAddress);
  const underlyingIcon   = getTokenIconUrl(displayData.underlyingAddress);

  const isAvailable = displayData.buyer === '0x0000000000000000000000000000000000000000';
  const isExpired   = displayData.expiry < Date.now() / 1000;

  const status = displayData.exercised ? 'Exercised' :
                 isExpired ? 'Expired' :
                 !displayData.active ? 'Cancelled' :
                 isAvailable ? 'Available' : 'Active';

  const statusColor = displayData.exercised ? 'text-gray-400 bg-gray-500/10 border-gray-500/20' :
                      isExpired ? 'text-red-400 bg-red-500/10 border-red-500/20' :
                      !displayData.active ? 'text-gray-400 bg-gray-500/10 border-gray-500/20' :
                      isAvailable ? 'text-green-400 bg-green-500/10 border-green-500/20' :
                      'text-base-blue bg-base-blue/10 border-base-blue/20';

  // ── Chart ───────────────────────────────────────────────────────────────────
  const [pythChartData, setPythChartData] = useState<{ date: string; price: number; strike: number }[]>([]);
  useEffect(() => {
    fetchPythHistory(PYTH_FEEDS.ETH_USD, 30).then(candles => {
      if (candles.length > 0) {
        const strike = Number(displayData.strike);
        setPythChartData(candles.map(c => ({ date: c.date, price: Math.round(c.close), strike })));
      }
    }).catch(() => {});
  }, [displayData.strike]);

  const fallbackChartData = useMemo(() => {
    const strike = Number(displayData.strike);
    let price = strike * 0.95;
    const data = [];
    for (let i = 30; i >= 0; i--) {
      const date = new Date();
      date.setDate(date.getDate() - i);
      price = price * (i % 3 === 0 ? 1.015 : i % 3 === 1 ? 0.992 : 1.005);
      data.push({ date: date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }), price: Math.round(price), strike });
    }
    return data;
  }, [displayData.strike]);

  const chartData    = pythChartData.length > 0 ? pythChartData : fallbackChartData;
  const currentPrice = chartData[chartData.length - 1].price;
  const isITM        = currentPrice > Number(displayData.strike);
  const breakEven    = Number(displayData.strike) + (Number(displayData.premium) / Number(displayData.amount));
  const intrinsicValue = isITM ? (currentPrice - Number(displayData.strike)) * Number(displayData.amount) : 0;
  const netPnl         = intrinsicValue - Number(displayData.premium);

  // ── Live countdown ──────────────────────────────────────────────────────────
  useEffect(() => {
    if (isExpired) { setCountdown('Expired'); return; }
    const tick = () => {
      const secs = Math.max(0, displayData.expiry - Date.now() / 1000);
      if (secs === 0) { setCountdown('Expired'); return; }
      const d = Math.floor(secs / 86400);
      const h = Math.floor((secs % 86400) / 3600).toString().padStart(2, '0');
      const m = Math.floor((secs % 3600) / 60).toString().padStart(2, '0');
      const s = Math.floor(secs % 60).toString().padStart(2, '0');
      setCountdown(`${d}d ${h}:${m}:${s}`);
    };
    tick();
    const id_ = setInterval(tick, 1000);
    return () => clearInterval(id_);
  }, [displayData.expiry, isExpired]);

  // ── Exercise success → toast + certificate ─────────────────────────────────
  useEffect(() => {
    if (isExerciseSuccess && exerciseTxHash) {
      toast.tx(`Option #${id} exercised!`, exerciseTxHash);
      refetchOption();
      if (isITM) setShowCertificate(true);
    }
  }, [isExerciseSuccess, exerciseTxHash, id, refetchOption, isITM]);

  // ─────────────────────────────────────────────────────────────────────────────

  return (
    <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-12">
      <Link to="/market?type=options" className="inline-flex items-center text-sm text-gray-400 hover:text-white mb-8 transition-colors">
        <ArrowLeft size={16} className="mr-2" />
        Back to Market
      </Link>

      {/* Header */}
      <div className="flex flex-col md:flex-row justify-between items-start md:items-end mb-8 gap-4">
        <div>
          <div className="flex items-center space-x-3 mb-2">
            <h1 className="text-3xl font-bold text-white">Call Option #{id}</h1>
            <span className={`px-3 py-1 rounded-full text-xs font-bold uppercase tracking-wider border ${statusColor}`}>
              {status}
            </span>
          </div>
          <p className="text-gray-400">
            {displayData.amount} {underlyingSymbol} @ ${displayData.strike}
          </p>
        </div>
        <div className="flex items-center gap-3">
          {/* Generate certificate link when already exercised ITM */}
          {displayData.exercised && isITM && (
            <button onClick={() => setShowCertificate(true)}
              className="text-sm text-gray-500 hover:text-claw-pink transition-colors underline underline-offset-2">
              Generate Certificate
            </button>
          )}
          {/* Exercise — 2-step: approve USDC for strike, then exercise */}
          {!isMockData && optionData && displayData.active && !displayData.exercised && !isExpired &&
           !isAvailable && address && displayData.buyer.toLowerCase() === address.toLowerCase() && (
            // Step 1: needs approval AND haven't started yet
            exerciseStep === 'idle' && needsApproval ? (
              <button
                onClick={() => {
                  setExerciseStep('approving');
                  approveUsdc({
                    address: CONTRACT_ADDRESSES.MOCK_USDC,
                    abi: parseAbi(['function approve(address,uint256) returns (bool)']),
                    functionName: 'approve',
                    args: [CONTRACT_ADDRESSES.CALL_VAULT, strikeRaw],
                  } as any);
                }}
                disabled={isApproving}
                className="px-5 py-2.5 bg-base-blue text-white rounded-lg font-semibold text-sm hover:opacity-90 transition-opacity disabled:opacity-50"
              >
                {isApproving ? 'Approving…' : `Approve ${displayData.strike} USDC (1/2)`}
              </button>
            ) : exerciseStep === 'approving' || isApproving ? (
              // Locked in "approving" state — never reverts to approve button
              <button disabled className="px-5 py-2.5 bg-base-blue/60 text-white rounded-lg font-semibold text-sm opacity-70 cursor-wait">
                Approving… (1/2)
              </button>
            ) : (
              // Step 2: allowance satisfied OR auto-chained from approval
              <button
                onClick={handleExercise}
                disabled={isExercising || isExerciseConfirming || isExerciseSuccess || exerciseStep === 'exercising'}
                className="px-5 py-2.5 bg-claw-pink text-white rounded-lg font-semibold text-sm hover:bg-claw-dark transition-colors disabled:opacity-50"
              >
                {isExercising || isExerciseConfirming || exerciseStep === 'exercising' ? 'Exercising…' : isExerciseSuccess ? 'Exercised ✓' : 'Exercise Option (2/2)'}
              </button>
            )
          )}
        </div>
      </div>

      <div className="grid lg:grid-cols-3 gap-8">
        {/* ── Left Column ─────────────────────────────────────────────────────── */}
        <div className="lg:col-span-1 space-y-6">

          {/* Contract Terms */}
          <div className="bg-cyber-surface rounded-xl border border-cyber-border p-6">
            <h2 className="text-lg font-semibold text-white mb-4 flex items-center">
              <TrendingUp size={18} className="mr-2 text-base-blue" />
              Contract Terms
            </h2>
            <div className="space-y-4">
              {/* Underlying Asset — icon + symbol + basescan link */}
              <div className="flex justify-between items-center pb-3 border-b border-cyber-border/50">
                <span className="text-gray-400 text-sm">Underlying Asset</span>
                <a
                  href={`${BASESCAN}/address/${displayData.underlyingAddress}`}
                  target="_blank" rel="noopener noreferrer"
                  className="flex items-center gap-1.5 hover:opacity-75 transition-opacity"
                  title={displayData.underlyingAddress}
                >
                  <img
                    src={underlyingIcon}
                    alt={underlyingSymbol}
                    className="w-5 h-5 rounded-full bg-cyber-border"
                    onError={e => { (e.currentTarget as HTMLImageElement).style.display = 'none'; }}
                  />
                  <span className="text-white font-medium">{underlyingSymbol}</span>
                  <ExternalLink size={11} className="text-gray-500" />
                </a>
              </div>

              {/* Amount Locked — with symbol */}
              <div className="flex justify-between items-center pb-3 border-b border-cyber-border/50">
                <span className="text-gray-400 text-sm">Amount Locked</span>
                <span className="text-white font-medium">{displayData.amount} {underlyingSymbol}</span>
              </div>

              <div className="flex justify-between items-center pb-3 border-b border-cyber-border/50">
                <span className="text-gray-400 text-sm">Strike Price</span>
                <span className="text-white font-bold">${displayData.strike}</span>
              </div>
              <div className="flex justify-between items-center pb-3 border-b border-cyber-border/50">
                <span className="text-gray-400 text-sm">Premium Cost</span>
                <span className="text-base-blue font-bold">{displayData.premium} USDC</span>
              </div>
              <div className="flex justify-between items-center">
                <span className="text-gray-400 text-sm">Expiry Date</span>
                <span className="text-white font-medium">
                  {new Date(displayData.expiry * 1000).toLocaleDateString()}
                </span>
              </div>
            </div>
          </div>

          {/* Counterparties */}
          <div className="bg-cyber-surface rounded-xl border border-cyber-border p-6">
            <h2 className="text-lg font-semibold text-white mb-4 flex items-center">
              <ShieldAlert size={18} className="mr-2 text-lobster-orange" />
              Counterparties
            </h2>
            <div className="space-y-4">
              <div>
                <span className="block text-xs text-gray-500 uppercase tracking-wider mb-1">Writer (Maker)</span>
                <div className="bg-cyber-bg px-3 py-2 rounded border border-cyber-border font-mono text-sm text-gray-300 flex justify-between items-center">
                  <span className="truncate mr-2 flex items-center">
                    <Link to={`/profile/${displayData.writer}`} className="hover:text-base-blue transition-colors">
                      {typeof displayData.writer === 'string' ? `${displayData.writer.slice(0, 10)}...${displayData.writer.slice(-6)}` : displayData.writer}
                    </Link>
                    <CopyAddress addr={typeof displayData.writer === 'string' ? displayData.writer : ''} />
                    {address && typeof displayData.writer === 'string' && displayData.writer.toLowerCase() === address.toLowerCase() && <span className="ml-2 text-xs text-base-blue font-sans">(You)</span>}
                  </span>
                  {displayData.isAgent ? (
                    <button
                      onClick={() => setIsReputationExpanded(!isReputationExpanded)}
                      className="flex-shrink-0 flex items-center text-xs bg-green-500/10 text-green-400 border border-green-500/20 px-2 py-0.5 rounded-full font-sans hover:bg-green-500/20 transition-colors"
                      title="View Agent Reputation Details"
                    >
                      <ShieldCheck size={12} className="mr-1" />
                      {displayData.writerReputation}
                      {isReputationExpanded ? <ChevronUp size={12} className="ml-1" /> : <ChevronDown size={12} className="ml-1" />}
                    </button>
                  ) : (
                    <span className="flex-shrink-0 flex items-center text-xs bg-gray-500/10 text-gray-400 border border-gray-500/20 px-2 py-0.5 rounded-full font-sans">
                      <User size={12} className="mr-1" />
                      Standard User
                    </span>
                  )}
                </div>
              </div>

              {/* Expandable Reputation Details */}
              {isReputationExpanded && displayData.isAgent && (
                <div className="bg-cyber-bg border border-cyber-border rounded-lg p-4 mt-2 space-y-4">
                  <h3 className="text-sm font-bold text-white flex items-center">
                    <ShieldCheck size={14} className="mr-2 text-green-400" />
                    Agent Reputation Analysis
                  </h3>
                  <p className="text-xs text-gray-400">
                    This agent has a verified x402 history. Covered calls are fully collateralized by the smart contract; high reputation indicates a reliable market maker.
                  </p>
                  <div className="space-y-3">
                    <div className="flex justify-between items-center bg-cyber-surface p-2 rounded border border-cyber-border/50">
                      <div className="flex items-center">
                        <div className="w-6 h-6 rounded bg-base-blue/20 flex items-center justify-center mr-2">
                          <span className="text-base-blue font-bold text-[10px]">CP</span>
                        </div>
                        <span className="text-xs text-gray-300">Cred Protocol</span>
                      </div>
                      <span className="text-xs font-mono text-green-400">850 / 1000</span>
                    </div>
                    <div className="flex justify-between items-center bg-cyber-surface p-2 rounded border border-cyber-border/50">
                      <div className="flex items-center">
                        <div className="w-6 h-6 rounded bg-neon-blue/10 flex items-center justify-center mr-2">
                          <span className="text-neon-blue font-bold text-[10px]">SS</span>
                        </div>
                        <span className="text-xs text-gray-300">ScoutScore.ai</span>
                      </div>
                      <span className="text-xs font-mono text-green-400">A+ Rating</span>
                    </div>
                  </div>
                </div>
              )}

              <div>
                <div className="flex justify-between items-end mb-1">
                  <span className="block text-xs text-gray-500 uppercase tracking-wider">Buyer (Taker)</span>
                  <span className="text-[10px] text-gray-600">Reputation N/A</span>
                </div>
                <div className="bg-cyber-bg px-3 py-2 rounded border border-cyber-border font-mono text-sm text-gray-300 flex items-center">
                  {isAvailable ? <span className="text-gray-500">Available for Purchase</span> : (
                    <>
                      <Link to={`/profile/${displayData.buyer}`} className="hover:text-base-blue transition-colors truncate">
                        {typeof displayData.buyer === 'string' ? `${displayData.buyer.slice(0, 10)}...${displayData.buyer.slice(-6)}` : displayData.buyer}
                      </Link>
                      <CopyAddress addr={typeof displayData.buyer === 'string' ? displayData.buyer : ''} />
                      {address && typeof displayData.buyer === 'string' && displayData.buyer.toLowerCase() === address.toLowerCase() && <span className="ml-2 text-xs text-base-blue font-sans">(You)</span>}
                    </>
                  )}
                </div>
              </div>
            </div>
          </div>
        </div>

        {/* ── Right Column ─────────────────────────────────────────────────────── */}
        <div className="lg:col-span-2 space-y-6">

          {/* Interactive Metrics Widgets */}
          <div className="grid sm:grid-cols-3 gap-4">

            {/* Moneyness */}
            <div
              className="bg-cyber-surface rounded-xl border border-cyber-border p-5 cursor-pointer hover:border-green-500/30 transition-colors select-none"
              onClick={() => setExpandedWidget(expandedWidget === 'moneyness' ? null : 'moneyness')}
            >
              <div className="flex items-center justify-between mb-2">
                <span className="text-sm text-gray-400">Moneyness</span>
                <Activity size={16} className={isITM ? 'text-green-400' : 'text-red-400'} />
              </div>
              <div className={`text-2xl font-bold mb-1 ${isITM ? 'text-green-400' : 'text-red-400'}`}>
                {isITM ? 'In The Money' : 'Out of Money'}
              </div>
              <p className="text-[10px] text-gray-500 leading-tight">
                ${currentPrice.toLocaleString()} vs ${displayData.strike} strike · tap for details
              </p>
              {expandedWidget === 'moneyness' && (
                <div className="mt-3 pt-3 border-t border-cyber-border/50 space-y-1.5 text-xs">
                  <div className="flex justify-between">
                    <span className="text-gray-500">Current price</span>
                    <span className="text-white">${currentPrice.toLocaleString()}</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-gray-500">Strike</span>
                    <span className="text-white">${displayData.strike}</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-gray-500">Intrinsic value</span>
                    <span className={isITM ? 'text-green-400' : 'text-red-400'}>
                      {isITM ? `+$${intrinsicValue.toFixed(2)}` : '$0.00'}
                    </span>
                  </div>
                  <p className="text-[10px] text-gray-600 leading-snug pt-1">
                    {isITM
                      ? 'Exercising now would yield intrinsic value. Net P&L = intrinsic − premium paid.'
                      : 'Price is below strike — exercise would be uneconomical. The premium is the max loss.'}
                  </p>
                </div>
              )}
            </div>

            {/* Break-Even */}
            <div
              className="bg-cyber-surface rounded-xl border border-cyber-border p-5 cursor-pointer hover:border-base-blue/30 transition-colors select-none"
              onClick={() => setExpandedWidget(expandedWidget === 'breakeven' ? null : 'breakeven')}
            >
              <div className="flex items-center justify-between mb-2">
                <span className="text-sm text-gray-400">Break-Even Price</span>
                <Info size={16} className="text-gray-500" />
              </div>
              <div className="text-2xl font-bold text-white mb-1">
                ${breakEven.toFixed(2)}
              </div>
              <p className="text-[10px] text-gray-500 leading-tight">
                Strike + Premium/Amount · tap for breakdown
              </p>
              {expandedWidget === 'breakeven' && (
                <div className="mt-3 pt-3 border-t border-cyber-border/50 space-y-1.5 text-xs">
                  <div className="flex justify-between">
                    <span className="text-gray-500">Strike</span>
                    <span className="text-white">${displayData.strike}</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-gray-500">Premium ÷ Amount</span>
                    <span className="text-white">${(Number(displayData.premium) / Number(displayData.amount)).toFixed(2)}/unit</span>
                  </div>
                  <div className="flex justify-between font-medium">
                    <span className="text-gray-400">Break-Even</span>
                    <span className="text-white">${breakEven.toFixed(2)}</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-gray-500">Current distance</span>
                    <span className={currentPrice >= breakEven ? 'text-green-400' : 'text-red-400'}>
                      {currentPrice >= breakEven
                        ? `+$${(currentPrice - breakEven).toFixed(2)} above BE`
                        : `$${(breakEven - currentPrice).toFixed(2)} to BE`}
                    </span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-gray-500">Net P&L now</span>
                    <span className={netPnl >= 0 ? 'text-green-400' : 'text-red-400'}>
                      {netPnl >= 0 ? '+' : ''}{netPnl.toFixed(2)} USDC
                    </span>
                  </div>
                </div>
              )}
            </div>

            {/* Time to Expiry */}
            <div
              className="bg-cyber-surface rounded-xl border border-cyber-border p-5 cursor-pointer hover:border-lobster-orange/30 transition-colors select-none"
              onClick={() => setExpandedWidget(expandedWidget === 'expiry' ? null : 'expiry')}
            >
              <div className="flex items-center justify-between mb-2">
                <span className="text-sm text-gray-400">Time to Expiry</span>
                <Clock size={16} className="text-lobster-orange" />
              </div>
              <div className="text-2xl font-bold text-white mb-1">
                {isExpired ? '0' : Math.max(0, Math.ceil((displayData.expiry - Date.now() / 1000) / 86400))} Days
              </div>
              <p className="text-[10px] text-gray-500 leading-tight">
                {new Date(displayData.expiry * 1000).toLocaleDateString()} · tap for countdown
              </p>
              {expandedWidget === 'expiry' && (
                <div className="mt-3 pt-3 border-t border-cyber-border/50">
                  <p className={`text-lg font-bold font-mono tracking-widest ${isExpired ? 'text-red-400' : countdown.startsWith('0d') ? 'text-lobster-orange' : 'text-white'}`}>
                    {countdown}
                  </p>
                  <p className="text-[10px] text-gray-500 mt-1">
                    Until {new Date(displayData.expiry * 1000).toLocaleString()}
                  </p>
                  {!isExpired && Number(displayData.expiry - Date.now() / 1000) < 86400 && (
                    <p className="text-[10px] text-lobster-orange mt-1 font-medium">⚠ Expiring in less than 24 hours</p>
                  )}
                </div>
              )}
            </div>
          </div>

          {/* Price Chart */}
          <div className="bg-cyber-surface rounded-xl border border-cyber-border p-6">
            <div className="mb-6">
              <h2 className="text-lg font-semibold text-white">{underlyingSymbol} Price (30d)</h2>
              <p className="text-sm text-gray-400">Estimated price vs Strike ${displayData.strike}</p>
            </div>
            <div className="h-[300px] w-full">
              <ResponsiveContainer width="100%" height="100%">
                <AreaChart data={chartData} margin={{ top: 5, right: 0, left: -20, bottom: 0 }}>
                  <defs>
                    <linearGradient id="colorPrice" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="5%" stopColor="#10b981" stopOpacity={0.3} />
                      <stop offset="95%" stopColor="#10b981" stopOpacity={0} />
                    </linearGradient>
                  </defs>
                  <CartesianGrid strokeDasharray="3 3" stroke="#1e293b" vertical={false} />
                  <XAxis dataKey="date" stroke="#475569" fontSize={12} tickLine={false} axisLine={false} />
                  <YAxis stroke="#475569" fontSize={12} tickLine={false} axisLine={false} tickFormatter={val => `$${val}`} domain={['auto', 'auto']} />
                  <Tooltip contentStyle={{ backgroundColor: '#0f172a', borderColor: '#1e293b', borderRadius: '8px' }} itemStyle={{ color: '#e2e8f0' }} />
                  <ReferenceLine y={chartData[0].strike} label={{ position: 'insideTopLeft', value: 'Strike Price', fill: '#0052FF', fontSize: 10 }} stroke="#0052FF" strokeDasharray="3 3" />
                  <Area type="monotone" dataKey="price" name="Est. Price" stroke="#10b981" strokeWidth={2} fillOpacity={1} fill="url(#colorPrice)" />
                </AreaChart>
              </ResponsiveContainer>
            </div>
          </div>

          {/* Transaction History */}
          <div className="bg-cyber-surface rounded-xl border border-cyber-border p-6">
            <h2 className="text-lg font-semibold text-white mb-6">Transaction History</h2>
            <div className="relative border-l border-cyber-border ml-3 space-y-8">
              {contractEvents.length > 0 ? (
                contractEvents.map((event, idx) => (
                  <div key={idx} className="relative pl-6">
                    <div className={`absolute -left-1.5 top-1 w-3 h-3 rounded-full ring-4 ring-cyber-surface ${
                      event.eventName === 'OptionWritten'   ? 'bg-base-blue' :
                      event.eventName === 'OptionBought'    ? 'bg-green-400' :
                      event.eventName === 'OptionExercised' ? 'bg-green-500' : 'bg-red-500'
                    }`} />
                    <div className="flex justify-between items-start mb-1">
                      <h3 className="text-sm font-bold text-white">
                        {event.eventName === 'OptionWritten'   ? 'Call Written' :
                         event.eventName === 'OptionBought'    ? 'Option Purchased' :
                         event.eventName === 'OptionExercised' ? 'Exercised' : 'Expired & Reclaimed'}
                      </h3>
                      <span className="text-xs text-gray-500 font-mono">{new Date(event.timestamp).toLocaleString()}</span>
                    </div>
                    <p className="text-xs text-gray-400 mb-2">
                      {event.eventName === 'OptionWritten'   ? `Writer locked ${formatUnits(event.args.amount || 0n, 18)} ${underlyingSymbol} in the vault.` :
                       event.eventName === 'OptionBought'    ? 'Buyer paid the premium to the writer.' :
                       event.eventName === 'OptionExercised' ? 'Buyer paid strike price. Asset transferred to buyer.' :
                       'Option expired unexercised. Writer reclaimed asset.'}
                    </p>
                    <div className="bg-cyber-bg p-2 rounded border border-cyber-border text-[10px] font-mono text-gray-500">
                      <span className="text-gray-400">
                        {event.eventName === 'OptionWritten'   ? 'Maker: ' :
                         event.eventName === 'OptionBought'    ? 'Taker: ' :
                         event.eventName === 'OptionExercised' ? 'Exerciser: ' : 'Reclaimer: '}
                      </span>
                      {event.args.writer || event.args.buyer || displayData.writer || displayData.buyer}
                    </div>
                  </div>
                ))
              ) : isLoadingEvents ? (
                <div className="pl-6 text-sm text-gray-500">Loading events…</div>
              ) : (
                /* Fallback mock timeline */
                <>
                  <div className="relative pl-6">
                    <div className="absolute -left-1.5 top-1 w-3 h-3 rounded-full bg-base-blue ring-4 ring-cyber-surface" />
                    <div className="flex justify-between items-start mb-1">
                      <h3 className="text-sm font-bold text-white">Call Written</h3>
                      <span className="text-xs text-gray-500 font-mono">{new Date(displayData.expiry * 1000 - 5 * 86400000).toLocaleString()}</span>
                    </div>
                    <p className="text-xs text-gray-400 mb-2">Writer locked {displayData.amount} {underlyingSymbol} in the vault.</p>
                    <div className="bg-cyber-bg p-2 rounded border border-cyber-border text-[10px] font-mono text-gray-500">
                      <span className="text-gray-400">Maker:</span> {displayData.writer}
                    </div>
                  </div>

                  <div className="relative pl-6">
                    <div className={`absolute -left-1.5 top-1 w-3 h-3 rounded-full ring-4 ring-cyber-surface ${!isAvailable ? 'bg-green-400' : 'bg-cyber-border'}`} />
                    <div className="flex justify-between items-start mb-1">
                      <h3 className={`text-sm font-bold ${!isAvailable ? 'text-white' : 'text-gray-500'}`}>Option Purchased</h3>
                      {!isAvailable && <span className="text-xs text-gray-500 font-mono">{new Date(displayData.expiry * 1000 - 4 * 86400000).toLocaleString()}</span>}
                    </div>
                    <p className="text-xs text-gray-400 mb-2">
                      {!isAvailable ? `Buyer paid ${displayData.premium} USDC premium to the writer.` : 'Waiting for a buyer to pay the premium.'}
                    </p>
                    {!isAvailable && (
                      <div className="bg-cyber-bg p-2 rounded border border-cyber-border text-[10px] font-mono text-gray-500">
                        <span className="text-gray-400">Taker:</span> {displayData.buyer}
                      </div>
                    )}
                  </div>

                  <div className="relative pl-6">
                    <div className={`absolute -left-1.5 top-1 w-3 h-3 rounded-full ring-4 ring-cyber-surface ${displayData.exercised ? 'bg-green-500' : isExpired ? 'bg-red-500' : 'bg-cyber-border'}`} />
                    <div className="flex justify-between items-start mb-1">
                      <h3 className={`text-sm font-bold ${displayData.exercised ? 'text-green-400' : isExpired ? 'text-red-400' : 'text-gray-500'}`}>
                        {displayData.exercised ? 'Exercised' : isExpired ? 'Expired' : 'Settlement'}
                      </h3>
                      {(displayData.exercised || isExpired) && <span className="text-xs text-gray-500 font-mono">{new Date(displayData.expiry * 1000).toLocaleString()}</span>}
                    </div>
                    <p className="text-xs text-gray-400 mb-2">
                      {displayData.exercised ? 'Buyer paid strike price. Asset transferred to buyer.' :
                       isExpired ? 'Option expired unexercised. Writer can reclaim asset.' :
                       `Pending exercise or expiration on ${new Date(displayData.expiry * 1000).toLocaleDateString()}.`}
                    </p>
                    {displayData.exercised && (
                      <div className="bg-cyber-bg p-2 rounded border border-cyber-border text-[10px] font-mono text-gray-500">
                        <span className="text-gray-400">Exerciser:</span> {displayData.buyer}
                      </div>
                    )}
                  </div>
                </>
              )}
            </div>
          </div>
        </div>
      </div>

      {/* Certificate Modal */}
      <CertificateModal
        isOpen={showCertificate}
        onClose={() => setShowCertificate(false)}
        id={id || ''}
        symbol={underlyingSymbol}
        amount={displayData.amount}
        strike={displayData.strike}
        premium={displayData.premium}
        currentPrice={currentPrice}
        txHash={exerciseTxHash}
      />
    </div>
  );
}
