import React, { useMemo, useState, useEffect } from 'react';
import { useParams, Link } from 'react-router-dom';
import { useReadContract, useAccount, usePublicClient, useWriteContract, useWaitForTransactionReceipt } from 'wagmi';
import { formatUnits, parseAbiItem } from 'viem';
import { ArrowLeft, ShieldAlert, TrendingUp, Clock, Activity, Info, ShieldCheck, ChevronDown, ChevronUp, User, Copy, Check } from 'lucide-react';
import { AreaChart, Area, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, ReferenceLine } from 'recharts';
import { CONTRACT_ADDRESSES, clawStreetCallVaultABI, getAgentInfo, PYTH_FEEDS, BASESCAN } from '../config/contracts';
import { fetchPythHistory } from '../lib/pyth';
import { toast } from '../components/Toast';

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

export default function OptionDetails() {
  const { id } = useParams<{ id: string }>();
  const { address } = useAccount();
  const publicClient = usePublicClient();
  const [isReputationExpanded, setIsReputationExpanded] = useState(false);
  const [contractEvents, setContractEvents] = useState<any[]>([]);
  const [isLoadingEvents, setIsLoadingEvents] = useState(true);

  useEffect(() => {
    async function fetchEvents() {
      if (!publicClient || !id) return;
      setIsLoadingEvents(true);
      try {
        const optionId = BigInt(id);
        // Use a recent block window — public RPC limits getLogs to 10,000 blocks
        const currentBlock = await publicClient.getBlockNumber();
        const fromBlock = currentBlock > 9500n ? currentBlock - 9500n : 0n;

        const writtenLogs = await publicClient.getLogs({
          address: CONTRACT_ADDRESSES.CALL_VAULT,
          event: parseAbiItem('event OptionWritten(uint256 indexed optionId, address indexed writer, uint256 amount, uint256 strike, uint256 premium)'),
          args: { optionId },
          fromBlock,
        });

        const boughtLogs = await publicClient.getLogs({
          address: CONTRACT_ADDRESSES.CALL_VAULT,
          event: parseAbiItem('event OptionBought(uint256 indexed optionId, address indexed buyer)'),
          args: { optionId },
          fromBlock,
        });

        const exercisedLogs = await publicClient.getLogs({
          address: CONTRACT_ADDRESSES.CALL_VAULT,
          event: parseAbiItem('event OptionExercised(uint256 indexed optionId, address indexed buyer)'),
          args: { optionId },
          fromBlock,
        });

        const reclaimedLogs = await publicClient.getLogs({
          address: CONTRACT_ADDRESSES.CALL_VAULT,
          event: parseAbiItem('event UnderlyingReclaimed(uint256 indexed optionId)'),
          args: { optionId },
          fromBlock,
        });

        const allLogs = [...writtenLogs, ...boughtLogs, ...exercisedLogs, ...reclaimedLogs];
        
        const logsWithTimestamps = await Promise.all(allLogs.map(async (log) => {
          const block = await publicClient.getBlock({ blockHash: log.blockHash as `0x${string}` });
          return {
            eventName: log.eventName,
            args: log.args,
            transactionHash: log.transactionHash,
            blockNumber: log.blockNumber,
            timestamp: Number(block.timestamp) * 1000
          };
        }));

        logsWithTimestamps.sort((a, b) => Number(a.blockNumber) - Number(b.blockNumber));
        setContractEvents(logsWithTimestamps);
      } catch (error) {
        console.error("Failed to fetch events:", error);
      } finally {
        setIsLoadingEvents(false);
      }
    }
    fetchEvents();
  }, [publicClient, id]);

  const { data: optionData, isError, refetch: refetchOption } = useReadContract({
    address: CONTRACT_ADDRESSES.CALL_VAULT,
    abi: clawStreetCallVaultABI,
    functionName: 'options',
    args: [BigInt(id || '0')],
  });

  // Exercise option
  const { writeContract: exerciseOpt, isPending: isExercising, data: exerciseTxHash } = useWriteContract();
  const { isLoading: isExerciseConfirming, isSuccess: isExerciseSuccess } = useWaitForTransactionReceipt({ hash: exerciseTxHash });

  useEffect(() => {
    if (isExerciseSuccess && exerciseTxHash) {
      toast.tx(`Option #${id} exercised!`, exerciseTxHash);
      refetchOption();
    }
  }, [isExerciseSuccess, exerciseTxHash, id, refetchOption]);

  const handleExercise = () => {
    exerciseOpt({ address: CONTRACT_ADDRESSES.CALL_VAULT, abi: clawStreetCallVaultABI, functionName: 'exerciseOption', args: [BigInt(id || '0')] } as any);
  };

  const isMockData = isError && !optionData;

  const displayData = isMockData ? {
    writer: '0x1234567890abcdef1234567890abcdef12345678',
    buyer: '0xabcdef1234567890abcdef1234567890abcdef12',
    underlying: 'WETH',
    amount: '1.5',
    strike: '3800',
    premium: '85',
    expiry: Math.floor(Date.now() / 1000) + 5 * 86400, // 5 days from now
    exercised: false,
    active: true,
    writerReputation: 850,
    isAgent: true
  } : {
    writer: optionData[0],
    buyer: optionData[1],
    underlying: `${optionData[2].slice(0,6)}...${optionData[2].slice(-4)}`,
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

  const isAvailable = displayData.buyer === '0x0000000000000000000000000000000000000000';
  const isExpired = displayData.expiry < Date.now() / 1000;
  
  const status = displayData.exercised ? 'Exercised' : 
                 isExpired ? 'Expired' : 
                 !displayData.active ? 'Cancelled' :
                 isAvailable ? 'Available' : 'Active';

  const statusColor = displayData.exercised ? 'text-gray-400 bg-gray-500/10 border-gray-500/20' :
                      isExpired ? 'text-red-400 bg-red-500/10 border-red-500/20' :
                      !displayData.active ? 'text-gray-400 bg-gray-500/10 border-gray-500/20' :
                      isAvailable ? 'text-green-400 bg-green-500/10 border-green-500/20' :
                      'text-base-blue bg-base-blue/10 border-base-blue/20';

  // Real Pyth ETH/USD price history for chart (replaces random-walk)
  const [pythChartData, setPythChartData] = useState<{ date: string; price: number; strike: number }[]>([]);
  useEffect(() => {
    fetchPythHistory(PYTH_FEEDS.ETH_USD, 30).then(candles => {
      if (candles.length > 0) {
        const strike = Number(displayData.strike);
        setPythChartData(candles.map(c => ({ date: c.date, price: Math.round(c.close), strike })));
      }
    }).catch(() => {});
  }, [displayData.strike]);

  // Deterministic fallback (no random)
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

  const chartData = pythChartData.length > 0 ? pythChartData : fallbackChartData;

  const currentPrice = chartData[chartData.length - 1].price;
  const isITM = currentPrice > Number(displayData.strike);
  const breakEven = Number(displayData.strike) + (Number(displayData.premium) / Number(displayData.amount));

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
            {displayData.amount} {displayData.underlying} @ ${displayData.strike}
          </p>
        </div>
        {/* Exercise button — only for buyer when option is active, bought, and not expired */}
        {!isMockData && optionData && displayData.active && !displayData.exercised && !isExpired &&
         !isAvailable && address && displayData.buyer.toLowerCase() === address.toLowerCase() && (
          <button
            onClick={handleExercise}
            disabled={isExercising || isExerciseConfirming || isExerciseSuccess}
            className="px-5 py-2.5 bg-purple-600 text-white rounded-lg font-semibold text-sm hover:bg-purple-700 transition-colors disabled:opacity-50"
          >
            {isExercising || isExerciseConfirming ? 'Exercising…' : isExerciseSuccess ? 'Exercised ✓' : 'Exercise Option'}
          </button>
        )}
      </div>

      <div className="grid lg:grid-cols-3 gap-8">
        {/* Left Column: Terms & Parties */}
        <div className="lg:col-span-1 space-y-6">
          {/* Terms */}
          <div className="bg-cyber-surface rounded-xl border border-cyber-border p-6">
            <h2 className="text-lg font-semibold text-white mb-4 flex items-center">
              <TrendingUp size={18} className="mr-2 text-base-blue" />
              Contract Terms
            </h2>
            <div className="space-y-4">
              <div className="flex justify-between items-center pb-3 border-b border-cyber-border/50">
                <span className="text-gray-400 text-sm">Underlying Asset</span>
                <span className="text-white font-medium">{displayData.underlying}</span>
              </div>
              <div className="flex justify-between items-center pb-3 border-b border-cyber-border/50">
                <span className="text-gray-400 text-sm">Amount Locked</span>
                <span className="text-white font-medium">{displayData.amount}</span>
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

          {/* Parties */}
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
                      {typeof displayData.writer === 'string' ? `${displayData.writer.slice(0,10)}...${displayData.writer.slice(-6)}` : displayData.writer}
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
                    <span className="flex-shrink-0 flex items-center text-xs bg-gray-500/10 text-gray-400 border border-gray-500/20 px-2 py-0.5 rounded-full font-sans" title="Standard Human User (No x402 History)">
                      <User size={12} className="mr-1" />
                      Standard User
                    </span>
                  )}
                </div>
              </div>

              {/* Expandable Reputation Details */}
              {isReputationExpanded && displayData.isAgent && (
                <div className="bg-cyber-bg border border-cyber-border rounded-lg p-4 mt-2 space-y-4 animate-in fade-in slide-in-from-top-2">
                  <h3 className="text-sm font-bold text-white flex items-center">
                    <ShieldCheck size={14} className="mr-2 text-green-400" />
                    Agent Reputation Analysis
                  </h3>
                  <p className="text-xs text-gray-400">
                    This agent has a verified x402 history. While covered calls are fully collateralized by the smart contract, high reputation indicates a reliable market maker less likely to cancel active offers.
                  </p>
                  
                  <div className="space-y-3">
                    <div className="flex justify-between items-center bg-cyber-surface p-2 rounded border border-cyber-border/50">
                      <div className="flex items-center">
                        <div className="w-6 h-6 rounded bg-blue-500/20 flex items-center justify-center mr-2">
                          <span className="text-blue-400 font-bold text-[10px]">CP</span>
                        </div>
                        <span className="text-xs text-gray-300">Cred Protocol</span>
                      </div>
                      <span className="text-xs font-mono text-green-400">850 / 1000</span>
                    </div>

                    <div className="flex justify-between items-center bg-cyber-surface p-2 rounded border border-cyber-border/50">
                      <div className="flex items-center">
                        <div className="w-6 h-6 rounded bg-purple-500/20 flex items-center justify-center mr-2">
                          <span className="text-purple-400 font-bold text-[10px]">SS</span>
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
                  <span className="text-[10px] text-gray-600" title="Premium buyers do not require reputation scores as they hold no ongoing protocol risk.">Reputation N/A</span>
                </div>
                <div className="bg-cyber-bg px-3 py-2 rounded border border-cyber-border font-mono text-sm text-gray-300 flex items-center">
                  {isAvailable ? <span className="text-gray-500">Available for Purchase</span> : (
                    <>
                      <Link to={`/profile/${displayData.buyer}`} className="hover:text-base-blue transition-colors truncate">
                        {typeof displayData.buyer === 'string' ? `${displayData.buyer.slice(0,10)}...${displayData.buyer.slice(-6)}` : displayData.buyer}
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

        {/* Right Column: Chart & Data Points */}
        <div className="lg:col-span-2 space-y-6">
          {/* Key Data Points */}
          <div className="grid sm:grid-cols-3 gap-4">
            <div className="bg-cyber-surface rounded-xl border border-cyber-border p-5">
              <div className="flex items-center justify-between mb-2">
                <span className="text-sm text-gray-400">Moneyness</span>
                <Activity size={16} className={isITM ? "text-green-400" : "text-red-400"} />
              </div>
              <div className={`text-2xl font-bold mb-1 ${isITM ? 'text-green-400' : 'text-red-400'}`}>
                {isITM ? 'In The Money' : 'Out of Money'}
              </div>
              <p className="text-[10px] text-gray-500 leading-tight">
                Current est. price (${currentPrice}) vs Strike (${displayData.strike})
              </p>
            </div>
            <div className="bg-cyber-surface rounded-xl border border-cyber-border p-5">
              <div className="flex items-center justify-between mb-2">
                <span className="text-sm text-gray-400">Break-Even Price</span>
                <Info size={16} className="text-gray-500" />
              </div>
              <div className="text-2xl font-bold text-white mb-1">
                ${breakEven.toFixed(2)}
              </div>
              <p className="text-[10px] text-gray-500 leading-tight">
                Price needed for buyer to profit (Strike + Premium/Amount).
              </p>
            </div>
            <div className="bg-cyber-surface rounded-xl border border-cyber-border p-5">
              <div className="flex items-center justify-between mb-2">
                <span className="text-sm text-gray-400">Time to Expiry</span>
                <Clock size={16} className="text-lobster-orange" />
              </div>
              <div className="text-2xl font-bold text-white mb-1">
                {isExpired ? '0' : Math.max(0, Math.ceil((displayData.expiry - Date.now()/1000) / 86400))} Days
              </div>
              <p className="text-[10px] text-gray-500 leading-tight">
                Option expires on {new Date(displayData.expiry * 1000).toLocaleDateString()}
              </p>
            </div>
          </div>

          {/* Chart */}
          <div className="bg-cyber-surface rounded-xl border border-cyber-border p-6">
            <div className="mb-6">
              <h2 className="text-lg font-semibold text-white">Underlying Asset Price (Simulated)</h2>
              <p className="text-sm text-gray-400">Estimated price vs Strike Price</p>
            </div>
            <div className="h-[300px] w-full">
              <ResponsiveContainer width="100%" height="100%">
                <AreaChart data={chartData} margin={{ top: 5, right: 0, left: -20, bottom: 0 }}>
                  <defs>
                    <linearGradient id="colorPrice" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="5%" stopColor="#10b981" stopOpacity={0.3}/>
                      <stop offset="95%" stopColor="#10b981" stopOpacity={0}/>
                    </linearGradient>
                  </defs>
                  <CartesianGrid strokeDasharray="3 3" stroke="#1e293b" vertical={false} />
                  <XAxis dataKey="date" stroke="#475569" fontSize={12} tickLine={false} axisLine={false} />
                  <YAxis stroke="#475569" fontSize={12} tickLine={false} axisLine={false} tickFormatter={(val) => `$${val}`} domain={['auto', 'auto']} />
                  <Tooltip 
                    contentStyle={{ backgroundColor: '#0f172a', borderColor: '#1e293b', borderRadius: '8px' }}
                    itemStyle={{ color: '#e2e8f0' }}
                  />
                  <ReferenceLine y={chartData[0].strike} label={{ position: 'insideTopLeft', value: 'Strike Price', fill: '#0052FF', fontSize: 10 }} stroke="#0052FF" strokeDasharray="3 3" />
                  <Area type="monotone" dataKey="price" name="Est. Price" stroke="#10b981" strokeWidth={2} fillOpacity={1} fill="url(#colorPrice)" />
                </AreaChart>
              </ResponsiveContainer>
            </div>
          </div>

          {/* Timeline */}
          <div className="bg-cyber-surface rounded-xl border border-cyber-border p-6">
            <h2 className="text-lg font-semibold text-white mb-6">Transaction History</h2>
            <div className="relative border-l border-cyber-border ml-3 space-y-8">
              {contractEvents.length > 0 ? (
                contractEvents.map((event, idx) => (
                  <div key={idx} className="relative pl-6">
                    <div className={`absolute -left-1.5 top-1 w-3 h-3 rounded-full ring-4 ring-cyber-surface ${
                      event.eventName === 'OptionWritten' ? 'bg-base-blue' :
                      event.eventName === 'OptionBought' ? 'bg-purple-500' :
                      event.eventName === 'OptionExercised' ? 'bg-green-500' : 'bg-red-500'
                    }`} />
                    <div className="flex justify-between items-start mb-1">
                      <h3 className="text-sm font-bold text-white">
                        {event.eventName === 'OptionWritten' ? 'Call Written' :
                         event.eventName === 'OptionBought' ? 'Option Purchased' :
                         event.eventName === 'OptionExercised' ? 'Exercised' : 'Expired & Reclaimed'}
                      </h3>
                      <span className="text-xs text-gray-500 font-mono">{new Date(event.timestamp).toLocaleString()}</span>
                    </div>
                    <p className="text-xs text-gray-400 mb-2">
                      {event.eventName === 'OptionWritten' ? `Writer locked ${formatUnits(event.args.amount || 0n, 18)} underlying in the vault.` :
                       event.eventName === 'OptionBought' ? 'Buyer paid the premium to the writer.' :
                       event.eventName === 'OptionExercised' ? 'Buyer paid strike price. Asset transferred to buyer.' :
                       'Option expired unexercised. Writer reclaimed asset.'}
                    </p>
                    <div className="bg-cyber-bg p-2 rounded border border-cyber-border text-[10px] font-mono text-gray-500">
                      <span className="text-gray-400">
                        {event.eventName === 'OptionWritten' ? 'Maker: ' :
                         event.eventName === 'OptionBought' ? 'Taker: ' :
                         event.eventName === 'OptionExercised' ? 'Exerciser: ' : 'Reclaimer: '}
                      </span> 
                      {event.args.writer || event.args.buyer || displayData.writer || displayData.buyer}
                    </div>
                  </div>
                ))
              ) : (
                /* Fallback Mock Timeline */
                <>
                  <div className="relative pl-6">
                    <div className="absolute -left-1.5 top-1 w-3 h-3 rounded-full bg-base-blue ring-4 ring-cyber-surface" />
                    <div className="flex justify-between items-start mb-1">
                      <h3 className="text-sm font-bold text-white">Call Written</h3>
                      <span className="text-xs text-gray-500 font-mono">{new Date(displayData.expiry * 1000 - 5 * 86400000).toLocaleString()}</span>
                    </div>
                    <p className="text-xs text-gray-400 mb-2">Writer locked {displayData.amount} {displayData.underlying} in the vault.</p>
                    <div className="bg-cyber-bg p-2 rounded border border-cyber-border text-[10px] font-mono text-gray-500">
                      <span className="text-gray-400">Maker:</span> {displayData.writer}
                    </div>
                  </div>
                  
                  <div className="relative pl-6">
                    <div className={`absolute -left-1.5 top-1 w-3 h-3 rounded-full ring-4 ring-cyber-surface ${!isAvailable ? 'bg-base-blue' : 'bg-cyber-border'}`} />
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
                      {displayData.exercised ? `Buyer paid strike price. Asset transferred to buyer.` : 
                       isExpired ? `Option expired unexercised. Writer can reclaim asset.` : 
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
    </div>
  );
}
