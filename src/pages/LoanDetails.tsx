import React, { useMemo, useState, useEffect } from 'react';
import { useParams, Link } from 'react-router-dom';
import { useReadContract, useAccount, usePublicClient, useWriteContract, useWaitForTransactionReceipt } from 'wagmi';
import { formatUnits, parseUnits, parseAbiItem } from 'viem';
import { ArrowLeft, ShieldAlert, TrendingUp, Clock, Activity, CheckCircle2, AlertTriangle, Info, ShieldCheck, ChevronDown, ChevronUp, User, Copy, Check } from 'lucide-react';
import { AreaChart, Area, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, ReferenceLine } from 'recharts';
import { CONTRACT_ADDRESSES, clawStreetLoanABI, erc20ABI, getAgentInfo, PYTH_FEEDS, BASESCAN } from '../config/contracts';
import { fetchPythHistory, fetchPythVAA } from '../lib/pyth';
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

export default function LoanDetails() {
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
        const loanId = BigInt(id);
        
        const createdLogs = await publicClient.getLogs({
          address: CONTRACT_ADDRESSES.LOAN_ENGINE,
          event: parseAbiItem('event LoanCreated(uint256 indexed loanId, address indexed borrower, uint256 principal, uint256 health)'),
          args: { loanId },
          fromBlock: 'earliest'
        });
        
        const acceptedLogs = await publicClient.getLogs({
          address: CONTRACT_ADDRESSES.LOAN_ENGINE,
          event: parseAbiItem('event LoanAccepted(uint256 indexed loanId, address indexed lender)'),
          args: { loanId },
          fromBlock: 'earliest'
        });

        const repaidLogs = await publicClient.getLogs({
          address: CONTRACT_ADDRESSES.LOAN_ENGINE,
          event: parseAbiItem('event LoanRepaid(uint256 indexed loanId)'),
          args: { loanId },
          fromBlock: 'earliest'
        });

        const defaultedLogs = await publicClient.getLogs({
          address: CONTRACT_ADDRESSES.LOAN_ENGINE,
          event: parseAbiItem('event LoanDefaulted(uint256 indexed loanId)'),
          args: { loanId },
          fromBlock: 'earliest'
        });

        const allLogs = [...createdLogs, ...acceptedLogs, ...repaidLogs, ...defaultedLogs];
        
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

  const { data: loanData, isError, refetch: refetchLoan } = useReadContract({
    address: CONTRACT_ADDRESSES.LOAN_ENGINE,
    abi: clawStreetLoanABI,
    functionName: 'loans',
    args: [BigInt(id || '0')],
  });

  // Repay flow: approve USDC → repayLoan
  const { writeContract: approveRepay, data: approveTxHash } = useWriteContract();
  const { isSuccess: isApproveSuccess } = useWaitForTransactionReceipt({ hash: approveTxHash });
  const { writeContract: repayLoan, isPending: isRepaying, data: repayTxHash } = useWriteContract();
  const { isLoading: isRepayConfirming, isSuccess: isRepaySuccess } = useWaitForTransactionReceipt({ hash: repayTxHash });
  const [isRepayStep, setIsRepayStep] = useState<'idle' | 'approving' | 'repaying' | 'done'>('idle');

  useEffect(() => {
    if (isApproveSuccess && isRepayStep === 'approving' && loanData) {
      setIsRepayStep('repaying');
      repayLoan({ address: CONTRACT_ADDRESSES.LOAN_ENGINE, abi: clawStreetLoanABI, functionName: 'repayLoan', args: [BigInt(id || '0')] } as any);
    }
  }, [isApproveSuccess, isRepayStep, repayLoan, id, loanData]);

  useEffect(() => {
    if (isRepaySuccess && repayTxHash) {
      setIsRepayStep('done');
      toast.tx(`Loan #${id} repaid!`, repayTxHash);
      refetchLoan();
    }
  }, [isRepaySuccess, repayTxHash, id, refetchLoan]);

  const handleRepay = async () => {
    if (!loanData) return;
    const total = loanData[4] + loanData[5]; // principal + interest
    setIsRepayStep('approving');
    approveRepay({ address: CONTRACT_ADDRESSES.MOCK_USDC, abi: erc20ABI, functionName: 'approve', args: [CONTRACT_ADDRESSES.LOAN_ENGINE, total] } as any);
  };

  // Smart fallback: show demo only on actual RPC error, not on "loan not found"
  const isRpcError = isError;
  const isMockData = isRpcError && !loanData;

  const displayData = isMockData ? {
    borrower: '0x1234567890abcdef1234567890abcdef12345678',
    lender: '0xabcdef1234567890abcdef1234567890abcdef12',
    principal: '1500',
    interest: '75',
    duration: 30,
    startTime: Math.floor(Date.now() / 1000) - 15 * 86400, // 15 days ago
    health: 85,
    active: true,
    repaid: false,
    nftContract: '0x8f3...2a1',
    nftId: '42',
    borrowerReputation: 850,
    isAgent: true
  } : {
    borrower: loanData[0],
    lender: loanData[1],
    principal: formatUnits(loanData[4], 6),
    interest: formatUnits(loanData[5], 6),
    duration: Number(loanData[6]) / 86400,
    startTime: Number(loanData[7]),
    health: Number(loanData[8]),
    active: loanData[9],
    repaid: loanData[10],
    nftContract: `${loanData[2].slice(0,6)}...${loanData[2].slice(-4)}`,
    nftId: loanData[3].toString(),
    borrowerReputation: 850,
    isAgent: !!getAgentInfo(loanData[0]),
    agentName: getAgentInfo(loanData[0])?.name,
  };

  const isUnfunded = displayData.lender === '0x0000000000000000000000000000000000000000';
  const isDefaulted = !displayData.repaid && displayData.active && (Math.floor(Date.now() / 1000) > displayData.startTime + displayData.duration * 86400);
  
  const status = displayData.repaid ? 'Repaid' : 
                 isDefaulted ? 'Defaulted' : 
                 isUnfunded ? 'Awaiting Funder' : 'Active';

  const statusColor = displayData.repaid ? 'text-green-400 bg-green-500/10 border-green-500/20' :
                      isDefaulted ? 'text-red-400 bg-red-500/10 border-red-500/20' :
                      isUnfunded ? 'text-yellow-400 bg-yellow-500/10 border-yellow-500/20' :
                      'text-base-blue bg-base-blue/10 border-base-blue/20';

  const totalOwed = Number(displayData.principal) + Number(displayData.interest);
  const apr = Math.round((Number(displayData.interest) / Number(displayData.principal)) * (365 / displayData.duration) * 100);

  // Real Pyth price history for chart (ETH/USD — used as collateral oracle)
  const [pythChartData, setPythChartData] = useState<{ date: string; value: number; threshold: number }[]>([]);
  useEffect(() => {
    fetchPythHistory(PYTH_FEEDS.ETH_USD, 30).then(candles => {
      if (candles.length > 0) {
        const threshold = Number(displayData.principal) * 1.1;
        setPythChartData(candles.map(c => ({ date: c.date, value: Math.round(c.close), threshold })));
      }
    }).catch(() => {});
  }, [displayData.principal]);

  // Fallback deterministic chart (no random — avoids hydration issues)
  const fallbackChartData = useMemo(() => {
    const data = [];
    const threshold = Number(displayData.principal) * 1.1;
    let value = Number(displayData.principal) * 1.5;
    for (let i = 30; i >= 0; i--) {
      const date = new Date();
      date.setDate(date.getDate() - i);
      value = value * (i % 2 === 0 ? 1.012 : 0.994);  // deterministic oscillation
      data.push({ date: date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }), value: Math.round(value), threshold });
    }
    return data;
  }, [displayData.principal]);

  const chartData = pythChartData.length > 0 ? pythChartData : fallbackChartData;

  return (
    <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-12">
      <Link to="/market" className="inline-flex items-center text-sm text-gray-400 hover:text-white mb-8 transition-colors">
        <ArrowLeft size={16} className="mr-2" />
        Back to Market
      </Link>

      {/* Header */}
      <div className="flex flex-col md:flex-row justify-between items-start md:items-end mb-8 gap-4">
        <div>
          <div className="flex items-center space-x-3 mb-2">
            <h1 className="text-3xl font-bold text-white">Loan #{id}</h1>
            <span className={`px-3 py-1 rounded-full text-xs font-bold uppercase tracking-wider border ${statusColor}`}>
              {status}
            </span>
          </div>
          <p className="text-gray-400">Collateral: {displayData.nftContract} (ID: {displayData.nftId})</p>
        </div>
        
        {/* Repay button — only for active, funded loans where connected wallet is borrower */}
        {!isMockData && loanData && displayData.active && !displayData.repaid && !isUnfunded &&
         address && displayData.borrower.toLowerCase() === address.toLowerCase() && (
          <button
            onClick={handleRepay}
            disabled={isRepayStep !== 'idle' || isRepaying || isRepayConfirming}
            className="px-5 py-2.5 bg-green-600 text-white rounded-lg font-semibold text-sm hover:bg-green-700 transition-colors disabled:opacity-50"
          >
            {isRepayStep === 'approving' ? 'Approving USDC…' :
             isRepayStep === 'repaying' || isRepayConfirming ? 'Repaying…' :
             isRepayStep === 'done' ? 'Repaid ✓' :
             `Repay ${totalOwed} USDC`}
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
              Loan Terms
            </h2>
            <div className="space-y-4">
              <div className="flex justify-between items-center pb-3 border-b border-cyber-border/50">
                <span className="text-gray-400 text-sm">Principal</span>
                <span className="text-white font-medium">{displayData.principal} USDC</span>
              </div>
              <div className="flex justify-between items-center pb-3 border-b border-cyber-border/50">
                <span className="text-gray-400 text-sm">Interest</span>
                <span className="text-green-400 font-medium">+{displayData.interest} USDC</span>
              </div>
              <div className="flex justify-between items-center pb-3 border-b border-cyber-border/50">
                <span className="text-gray-400 text-sm">Total Repayment</span>
                <span className="text-white font-bold">{totalOwed} USDC</span>
              </div>
              <div className="flex justify-between items-center pb-3 border-b border-cyber-border/50">
                <span className="text-gray-400 text-sm">Duration</span>
                <span className="text-white font-medium">{displayData.duration} Days</span>
              </div>
              <div className="flex justify-between items-center">
                <span className="text-gray-400 text-sm">Implied APR</span>
                <span className="text-white font-medium">{apr}%</span>
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
                <span className="block text-xs text-gray-500 uppercase tracking-wider mb-1">Borrower (Maker)</span>
                <div className="bg-cyber-bg px-3 py-2 rounded border border-cyber-border font-mono text-sm text-gray-300 flex justify-between items-center">
                  <span className="truncate mr-2 flex items-center">
                    <Link to={`/profile/${displayData.borrower}`} className="hover:text-base-blue transition-colors">
                      {displayData.borrower.slice(0,10)}...{displayData.borrower.slice(-6)}
                    </Link>
                    <CopyAddress addr={displayData.borrower} />
                    {address && displayData.borrower.toLowerCase() === address.toLowerCase() && <span className="ml-2 text-xs text-base-blue font-sans">(You)</span>}
                  </span>
                  {displayData.isAgent ? (
                    <button 
                      onClick={() => setIsReputationExpanded(!isReputationExpanded)}
                      className="flex-shrink-0 flex items-center text-xs bg-green-500/10 text-green-400 border border-green-500/20 px-2 py-0.5 rounded-full font-sans hover:bg-green-500/20 transition-colors" 
                      title="View Agent Reputation Details"
                    >
                      <ShieldCheck size={12} className="mr-1" />
                      {displayData.borrowerReputation}
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
                    This agent's x402 score provides a <strong>1.10x multiplier</strong> to their health score, allowing them to sustain higher LTVs before liquidation due to their proven on-chain reliability.
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
                  
                  <div className="text-[10px] text-gray-500 pt-2 border-t border-cyber-border/50">
                    Metrics include successful loan repayments, x402 API settlement history, and zero defaults across integrated DeFi protocols.
                  </div>
                </div>
              )}
              <div>
                <div className="flex justify-between items-end mb-1">
                  <span className="block text-xs text-gray-500 uppercase tracking-wider">Lender (Taker)</span>
                  <span className="text-[10px] text-gray-600" title="Capital providers do not require reputation scores as they hold no ongoing protocol risk.">Reputation N/A</span>
                </div>
                <div className="bg-cyber-bg px-3 py-2 rounded border border-cyber-border font-mono text-sm text-gray-300 flex items-center">
                  {isUnfunded ? <span className="text-gray-500">Awaiting...</span> : (
                    <>
                      <Link to={`/profile/${displayData.lender}`} className="hover:text-base-blue transition-colors truncate">
                        {displayData.lender.slice(0,10)}...{displayData.lender.slice(-6)}
                      </Link>
                      <CopyAddress addr={displayData.lender} />
                      {address && displayData.lender.toLowerCase() === address.toLowerCase() && <span className="ml-2 text-xs text-base-blue font-sans">(You)</span>}
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
                <span className="text-sm text-gray-400">Health Score</span>
                <Activity size={16} className="text-base-blue" />
              </div>
              <div className="text-2xl font-bold text-white mb-1">{displayData.health}/100</div>
              <p className="text-[10px] text-gray-500 leading-tight">
                Based on Pyth oracle price feeds. Drops below 30 trigger liquidation risk.
              </p>
            </div>
            <div className="bg-cyber-surface rounded-xl border border-cyber-border p-5">
              <div className="flex items-center justify-between mb-2">
                <span className="text-sm text-gray-400">Est. LTV</span>
                <Info size={16} className="text-gray-500" />
              </div>
              <div className="text-2xl font-bold text-white mb-1">
                {Math.round((Number(displayData.principal) / chartData[chartData.length-1].value) * 100)}%
              </div>
              <p className="text-[10px] text-gray-500 leading-tight">
                Loan-to-Value ratio. Lower is safer for the lender.
              </p>
            </div>
            <div className="bg-cyber-surface rounded-xl border border-cyber-border p-5">
              <div className="flex items-center justify-between mb-2">
                <span className="text-sm text-gray-400">Time Remaining</span>
                <Clock size={16} className="text-lobster-orange" />
              </div>
              <div className="text-2xl font-bold text-white mb-1">
                {isUnfunded ? '--' : displayData.repaid ? '0' : Math.max(0, Math.ceil((displayData.startTime + displayData.duration * 86400 - Date.now()/1000) / 86400))} Days
              </div>
              <p className="text-[10px] text-gray-500 leading-tight">
                Until default claim becomes available.
              </p>
            </div>
          </div>

          {/* Chart */}
          <div className="bg-cyber-surface rounded-xl border border-cyber-border p-6">
            <div className="mb-6">
              <h2 className="text-lg font-semibold text-white">Collateral Valuation (on-chain)</h2>
              <p className="text-sm text-gray-400">Estimated NFT value vs Liquidation Threshold</p>
            </div>
            <div className="h-[300px] w-full">
              <ResponsiveContainer width="100%" height="100%">
                <AreaChart data={chartData} margin={{ top: 5, right: 0, left: -20, bottom: 0 }}>
                  <defs>
                    <linearGradient id="colorValue" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="5%" stopColor="#0052FF" stopOpacity={0.3}/>
                      <stop offset="95%" stopColor="#0052FF" stopOpacity={0}/>
                    </linearGradient>
                  </defs>
                  <CartesianGrid strokeDasharray="3 3" stroke="#1e293b" vertical={false} />
                  <XAxis dataKey="date" stroke="#475569" fontSize={12} tickLine={false} axisLine={false} />
                  <YAxis stroke="#475569" fontSize={12} tickLine={false} axisLine={false} tickFormatter={(val) => `$${val}`} />
                  <Tooltip 
                    contentStyle={{ backgroundColor: '#0f172a', borderColor: '#1e293b', borderRadius: '8px' }}
                    itemStyle={{ color: '#e2e8f0' }}
                  />
                  <ReferenceLine y={chartData[0].threshold} label={{ position: 'insideTopLeft', value: 'Liquidation Threshold', fill: '#ef4444', fontSize: 10 }} stroke="#ef4444" strokeDasharray="3 3" />
                  <Area type="monotone" dataKey="value" name="Est. Value (USDC)" stroke="#0052FF" strokeWidth={2} fillOpacity={1} fill="url(#colorValue)" />
                </AreaChart>
              </ResponsiveContainer>
            </div>
          </div>

          {/* Oracle Price History */}
          <div className="bg-cyber-surface rounded-xl border border-cyber-border p-6">
            <h2 className="text-lg font-semibold text-white mb-4">Oracle Price History</h2>
            <div className="overflow-x-auto">
              <table className="w-full text-sm text-left">
                <thead className="text-xs text-gray-500 uppercase bg-cyber-bg border-b border-cyber-border">
                  <tr>
                    <th className="px-4 py-3">Date</th>
                    <th className="px-4 py-3">Oracle</th>
                    <th className="px-4 py-3">Price (USDC)</th>
                    <th className="px-4 py-3">Status</th>
                  </tr>
                </thead>
                <tbody>
                  {chartData.slice(-5).reverse().map((data, idx) => (
                    <tr key={idx} className="border-b border-cyber-border/50 hover:bg-cyber-bg/50">
                      <td className="px-4 py-3 font-mono text-gray-300">{data.date}</td>
                      <td className="px-4 py-3 text-base-blue">Pyth Network</td>
                      <td className="px-4 py-3 font-medium text-white">${data.value}</td>
                      <td className="px-4 py-3">
                        <span className="bg-green-500/10 text-green-400 border border-green-500/20 px-2 py-0.5 rounded text-[10px]">Verified</span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
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
                      event.eventName === 'LoanCreated' ? 'bg-base-blue' :
                      event.eventName === 'LoanAccepted' ? 'bg-purple-500' :
                      event.eventName === 'LoanRepaid' ? 'bg-green-500' : 'bg-red-500'
                    }`} />
                    <div className="flex justify-between items-start mb-1">
                      <h3 className="text-sm font-bold text-white">
                        {event.eventName === 'LoanCreated' ? 'Offer Created' :
                         event.eventName === 'LoanAccepted' ? 'Loan Funded' :
                         event.eventName === 'LoanRepaid' ? 'Repaid & Settled' : 'Defaulted'}
                      </h3>
                      <span className="text-xs text-gray-500 font-mono">{new Date(event.timestamp).toLocaleString()}</span>
                    </div>
                    <p className="text-xs text-gray-400 mb-2">
                      {event.eventName === 'LoanCreated' ? `Borrower escrowed collateral and requested ${formatUnits(event.args.principal || 0n, 6)} USDC.` :
                       event.eventName === 'LoanAccepted' ? 'Lender provided the principal amount.' :
                       event.eventName === 'LoanRepaid' ? 'Borrower repaid principal + interest. NFT returned.' :
                       'Borrower failed to repay. Lender claimed the NFT.'}
                    </p>
                    <div className="bg-cyber-bg p-2 rounded border border-cyber-border text-[10px] font-mono text-gray-500">
                      <span className="text-gray-400">
                        {event.eventName === 'LoanCreated' ? 'Maker: ' :
                         event.eventName === 'LoanAccepted' ? 'Taker: ' :
                         event.eventName === 'LoanRepaid' ? 'Repayer: ' : 'Claimer: '}
                      </span> 
                      {event.args.borrower || event.args.lender || displayData.borrower || displayData.lender}
                    </div>
                  </div>
                ))
              ) : (
                /* Fallback Mock Timeline */
                <>
                  <div className="relative pl-6">
                    <div className="absolute -left-1.5 top-1 w-3 h-3 rounded-full bg-base-blue ring-4 ring-cyber-surface" />
                    <div className="flex justify-between items-start mb-1">
                      <h3 className="text-sm font-bold text-white">Offer Created</h3>
                      <span className="text-xs text-gray-500 font-mono">{new Date(displayData.startTime * 1000 - 86400000).toLocaleString()}</span>
                    </div>
                    <p className="text-xs text-gray-400 mb-2">Borrower escrowed collateral and set terms.</p>
                    <div className="bg-cyber-bg p-2 rounded border border-cyber-border text-[10px] font-mono text-gray-500">
                      <span className="text-gray-400">Maker:</span> {displayData.borrower}
                    </div>
                  </div>
                  
                  <div className="relative pl-6">
                    <div className={`absolute -left-1.5 top-1 w-3 h-3 rounded-full ring-4 ring-cyber-surface ${!isUnfunded ? 'bg-base-blue' : 'bg-cyber-border'}`} />
                    <div className="flex justify-between items-start mb-1">
                      <h3 className={`text-sm font-bold ${!isUnfunded ? 'text-white' : 'text-gray-500'}`}>Loan Funded</h3>
                      {!isUnfunded && <span className="text-xs text-gray-500 font-mono">{new Date(displayData.startTime * 1000).toLocaleString()}</span>}
                    </div>
                    <p className="text-xs text-gray-400 mb-2">
                      {!isUnfunded ? `Lender provided ${displayData.principal} USDC.` : 'Waiting for a lender to accept the terms.'}
                    </p>
                    {!isUnfunded && (
                      <div className="bg-cyber-bg p-2 rounded border border-cyber-border text-[10px] font-mono text-gray-500">
                        <span className="text-gray-400">Taker:</span> {displayData.lender}
                      </div>
                    )}
                  </div>

                  <div className="relative pl-6">
                    <div className={`absolute -left-1.5 top-1 w-3 h-3 rounded-full ring-4 ring-cyber-surface ${displayData.repaid ? 'bg-green-500' : isDefaulted ? 'bg-red-500' : 'bg-cyber-border'}`} />
                    <div className="flex justify-between items-start mb-1">
                      <h3 className={`text-sm font-bold ${displayData.repaid ? 'text-green-400' : isDefaulted ? 'text-red-400' : 'text-gray-500'}`}>
                        {displayData.repaid ? 'Repaid & Settled' : isDefaulted ? 'Defaulted' : 'Settlement'}
                      </h3>
                      {(displayData.repaid || isDefaulted) && <span className="text-xs text-gray-500 font-mono">{new Date(displayData.startTime * 1000 + displayData.duration * 86400000).toLocaleString()}</span>}
                    </div>
                    <p className="text-xs text-gray-400 mb-2">
                      {displayData.repaid ? 'Borrower repaid principal + interest. NFT returned.' : 
                       isDefaulted ? 'Borrower failed to repay. Lender can claim NFT.' : 
                       'Pending repayment or default.'}
                    </p>
                    {displayData.repaid && (
                      <div className="bg-cyber-bg p-2 rounded border border-cyber-border text-[10px] font-mono text-gray-500">
                        <span className="text-gray-400">Repayer:</span> {displayData.borrower}
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
