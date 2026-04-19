/**
 * Market.tsx — Unified Deal Hub
 * Combines Marketplace (loans) + HedgeVault (options) into one filterable page.
 * The old /vault route redirects here via App.tsx.
 */
import React, { useState, useCallback } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { motion } from 'motion/react';
import {
  useWriteContract, useReadContract, useReadContracts, useAccount,
  useWaitForTransactionReceipt, useSignMessage, usePublicClient,
} from 'wagmi';
import { parseUnits, formatUnits } from 'viem';
import {
  CONTRACT_ADDRESSES, TEST_TOKENS, clawStreetLoanABI, clawStreetCallVaultABI,
  erc721ABI, erc20ABI, getAgentInfo, PYTH_FEEDS,
} from '../config/contracts';
import { fetchPythVAA, usePythPrice, formatPriceUSD } from '../lib/pyth';
import { Modal } from '../components/Modal';
import { SkeletonGrid } from '../components/SkeletonCard';
import { toast } from '../components/Toast';
import {
  AlertCircle, Package, TrendingUp, ShieldCheck,
  User, ChevronDown, Filter, Plus, Copy, Check, Zap, Droplets, MessageSquare,
} from 'lucide-react';

// ─── Bargain Modal ─────────────────────────────────────────────────────────────

function BargainModal({
  isOpen, onClose,
  dealType, dealId, dealOwner, address,
  currentTermLabel,   // e.g. "Interest: 75 USDC" or "Premium: 50 USDC"
  termKey,            // 'interestRate' | 'premium'
  termLabel,          // label shown in form
}: {
  isOpen: boolean; onClose: () => void;
  dealType: 'loan' | 'option'; dealId: number;
  dealOwner: string; address?: string;
  currentTermLabel: string; termKey: 'interestRate' | 'premium'; termLabel: string;
}) {
  const { signMessageAsync } = useSignMessage();
  const [value, setValue]   = useState('');
  const [msg, setMsg]       = useState('');
  const [busy, setBusy]     = useState(false);

  async function handleSubmit() {
    if (!address || !value) return;
    setBusy(true);
    try {
      const timestamp    = Math.floor(Date.now() / 1000);
      const proposedTerms = { [termKey]: Number(value), message: msg || undefined };
      const message = [
        'ClawStreet Negotiation Offer',
        `DealType: ${dealType}`,
        `DealId: ${dealId}`,
        `Terms: ${JSON.stringify(proposedTerms)}`,
        `Timestamp: ${timestamp}`,
      ].join('\n');

      const signature = await signMessageAsync({ account: address as `0x${string}`, message });

      const res = await fetch('/api/negotiate/offer', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ from: address, to: dealOwner, dealType, dealId, proposedTerms, timestamp, signature }),
      });
      const data = await res.json();
      if (data.success) {
        toast.success('Offer submitted! The deal creator has been notified.');
        onClose();
      } else {
        toast.error(data.error ?? 'Offer failed');
      }
    } catch (e: any) {
      if (e?.code !== 4001) toast.error(e?.message ?? 'Failed');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal isOpen={isOpen} onClose={onClose} title={`Propose Terms — ${dealType === 'loan' ? 'Loan' : 'Option'} #${dealId}`}>
      <div className="space-y-4">
        <p className="text-sm text-gray-400">
          Current: <span className="text-white">{currentTermLabel}</span>. Propose different terms — the deal creator will be notified.
        </p>
        <div>
          <label className="block text-xs text-gray-500 mb-1 uppercase tracking-wider">{termLabel} *</label>
          <input
            value={value}
            onChange={e => setValue(e.target.value)}
            type="number"
            placeholder="e.g. 50"
            className="w-full bg-cyber-bg border border-cyber-border rounded-lg px-3 py-2 text-sm text-white placeholder-gray-600 focus:outline-none focus:border-base-blue/50"
          />
        </div>
        <div>
          <label className="block text-xs text-gray-500 mb-1 uppercase tracking-wider">Message <span className="normal-case text-gray-600">(optional, max 280 chars)</span></label>
          <textarea
            value={msg}
            onChange={e => setMsg(e.target.value.slice(0, 280))}
            rows={2}
            placeholder="Why should they accept your offer?"
            className="w-full bg-cyber-bg border border-cyber-border rounded-lg px-3 py-2 text-sm text-white placeholder-gray-600 focus:outline-none focus:border-base-blue/50 resize-none"
          />
        </div>
        <div className="flex gap-3 pt-1">
          <button
            onClick={handleSubmit}
            disabled={busy || !value || !address}
            className="flex-1 py-2.5 bg-base-blue text-white rounded-lg font-semibold text-sm hover:bg-blue-500 disabled:opacity-40 transition-colors"
          >
            {busy ? 'Signing...' : 'Sign & Submit Offer'}
          </button>
          <button onClick={onClose} className="px-4 py-2.5 bg-cyber-bg border border-cyber-border text-gray-400 rounded-lg text-sm hover:text-white transition-colors">
            Cancel
          </button>
        </div>
        {!address && <p className="text-xs text-yellow-500">Connect wallet to make an offer.</p>}
      </div>
    </Modal>
  );
}

// ─── Types ────────────────────────────────────────────────────────────────────

type DealType = 'all' | 'loans' | 'options';
type SortOrder = 'newest' | 'oldest' | 'value_desc' | 'value_asc';

// ─── MockUSDC Faucet Banner ───────────────────────────────────────────────────

type FaucetKey = 'usdc' | 'weth' | 'wbtc' | 'link';

function FaucetBanner({ address }: { address: string }) {
  const [claiming, setClaiming] = useState<FaucetKey | null>(null);
  const [claimed, setClaimed] = useState<Set<FaucetKey>>(new Set());
  const [errors, setErrors] = useState<Partial<Record<FaucetKey, string>>>({});

  const { data: usdcBalance, refetch: refetchBalance } = useReadContract({
    address: CONTRACT_ADDRESSES.MOCK_USDC,
    abi: erc20ABI,
    functionName: 'balanceOf',
    args: [address as `0x${string}`],
  });

  const balanceNum = usdcBalance ? Number(formatUnits(usdcBalance as bigint, 6)) : null;
  const needsUsdc = balanceNum !== null && balanceNum < 100;
  const hasTestTokens = !!TEST_TOKENS.WETH;

  const handleClaim = async (token: FaucetKey) => {
    setClaiming(token);
    setErrors(prev => ({ ...prev, [token]: undefined }));
    try {
      const endpoint = token === 'usdc' ? '/api/faucet/usdc'
        : token === 'weth' ? '/api/faucet/weth'
        : token === 'wbtc' ? '/api/faucet/wbtc'
        : '/api/faucet/link';
      const r = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ address }),
      });
      const data = await r.json();
      if (data.success) {
        setClaimed(prev => new Set([...prev, token]));
        const labels: Record<FaucetKey, string> = {
          usdc: '1000 MockUSDC', weth: '5 tWETH', wbtc: '0.1 tWBTC', link: '100 tLINK',
        };
        toast.tx(`${labels[token]} sent!`, data.txHash);
        if (token === 'usdc') setTimeout(refetchBalance, 5000);
      } else {
        setErrors(prev => ({ ...prev, [token]: data.error ?? 'Faucet error' }));
      }
    } catch {
      setErrors(prev => ({ ...prev, [token]: 'Network error' }));
    } finally {
      setClaiming(null);
    }
  };

  const showBanner = (needsUsdc && !claimed.has('usdc')) || hasTestTokens;
  if (!showBanner) return null;

  return (
    <div className="mb-6 space-y-2">
      {/* USDC row */}
      {(needsUsdc || claimed.has('usdc')) && (
        <div className="p-3 bg-blue-500/10 border border-blue-500/20 rounded-lg flex items-center justify-between gap-3 text-sm">
          <div className="flex items-center gap-2 text-blue-300">
            <Droplets size={16} />
            <span>
              {claimed.has('usdc')
                ? '1000 MockUSDC on the way — refresh in a few seconds'
                : `Your wallet has ${balanceNum?.toFixed(0) ?? 0} MockUSDC — get test tokens to fund deals`}
            </span>
            {errors.usdc && <span className="text-red-400 ml-2">{errors.usdc}</span>}
          </div>
          {!claimed.has('usdc') && (
            <button
              onClick={() => handleClaim('usdc')}
              disabled={claiming !== null}
              className="flex-shrink-0 px-3 py-1.5 bg-blue-500 hover:bg-blue-400 disabled:opacity-50 text-white rounded-lg text-xs font-semibold transition-colors"
            >
              {claiming === 'usdc' ? 'Sending...' : 'Get 1000 MockUSDC'}
            </button>
          )}
        </div>
      )}

      {/* Bundle collateral row — only shown when TestTokens are deployed */}
      {hasTestTokens && (
        <div className="p-3 bg-teal-500/8 border border-teal-500/20 rounded-lg text-sm">
          <div className="flex items-center gap-2 text-teal-300 mb-2">
            <Droplets size={16} />
            <span>Bundle collateral faucets — deposit into BundleVault to create loan collateral</span>
          </div>
          <div className="flex flex-wrap gap-2">
            {(['weth', 'wbtc', 'link'] as const).map(token => {
              const labels = { weth: '5 tWETH', wbtc: '0.1 tWBTC', link: '100 tLINK' };
              const isClaimed = claimed.has(token);
              return (
                <div key={token} className="flex items-center gap-1">
                  <button
                    onClick={() => handleClaim(token)}
                    disabled={claiming !== null || isClaimed}
                    className="px-2.5 py-1 bg-teal-600/40 hover:bg-teal-500/50 disabled:opacity-50 text-teal-200 rounded text-xs font-semibold transition-colors border border-teal-500/30"
                  >
                    {isClaimed ? `✓ ${labels[token]} sent` : claiming === token ? 'Sending...' : `Get ${labels[token]}`}
                  </button>
                  {errors[token] && <span className="text-red-400 text-xs">{errors[token]}</span>}
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}

// ─── Main Component ───────────────────────────────────────────────────────────

export default function Market() {
  const { address } = useAccount();
  const [searchParams, setSearchParams] = useSearchParams();
  const [dealType, setDealType] = useState<DealType>((searchParams.get('type') as DealType) ?? 'all');
  const [activeOnly, setActiveOnly] = useState(true);
  const [myDeals, setMyDeals] = useState(false);
  const [sort, setSort] = useState<SortOrder>('newest');
  const [isCreateLoanOpen, setIsCreateLoanOpen] = useState(false);
  const [isWriteCallOpen, setIsWriteCallOpen] = useState(false);
  const [createMenuOpen, setCreateMenuOpen] = useState(false);

  // Read counters
  const { data: loanCounter, isError: loanCounterError } = useReadContract({
    address: CONTRACT_ADDRESSES.LOAN_ENGINE,
    abi: clawStreetLoanABI,
    functionName: 'loanCounter',
  });
  const { data: optionCounter, isError: optionCounterError } = useReadContract({
    address: CONTRACT_ADDRESSES.CALL_VAULT,
    abi: clawStreetCallVaultABI,
    functionName: 'optionCounter',
  });

  const loansLoading  = loanCounter === undefined && !loanCounterError;
  const optionsLoading = optionCounter === undefined && !optionCounterError;
  const isLoading = (dealType === 'loans' ? loansLoading : dealType === 'options' ? optionsLoading : loansLoading || optionsLoading);

  const isMockData = (dealType !== 'options' && loanCounterError) || (dealType !== 'loans' && optionCounterError);

  const totalLoans   = loanCounterError   ? 6 : Number(loanCounter ?? 0);
  const totalOptions = optionCounterError ? 3 : Number(optionCounter ?? 0);

  // Sort: for newest/oldest we reverse the ID array (higher ID = newer in most contracts)
  const makeSortedIds = (count: number) => {
    const ids = Array.from({ length: count }, (_, i) => i);
    if (sort === 'oldest') return ids;
    if (sort === 'newest') return [...ids].reverse();
    // value_desc / value_asc: cards report their value via callback, sorted inline
    // For now newest/oldest is the reliable path; value sort is best-effort
    return [...ids].reverse(); // default newest
  };

  const loanIds   = makeSortedIds(totalLoans);
  const optionIds = makeSortedIds(totalOptions);

  const showLoans   = dealType === 'all' || dealType === 'loans';
  const showOptions = dealType === 'all' || dealType === 'options';

  const totalCount = (showLoans ? totalLoans : 0) + (showOptions ? totalOptions : 0);
  const isEmpty = !isLoading && !isMockData && totalCount === 0;

  // Live ETH price for oracle context
  const { price: ethPrice, loading: ethPriceLoading } = usePythPrice(PYTH_FEEDS.ETH_USD);

  // Filter tab click
  const setType = (t: DealType) => {
    setDealType(t);
    if (t === 'all') searchParams.delete('type');
    else searchParams.set('type', t);
    setSearchParams(searchParams);
  };

  return (
    <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-12">
      {/* Faucet banner — shown when wallet is connected */}
      {address && !isMockData && <FaucetBanner address={address} />}

      {/* Error banner */}
      {isMockData && (
        <div className="mb-6 p-4 bg-orange-500/10 border border-orange-500/20 rounded-lg flex items-center gap-3 text-orange-400 text-sm">
          <AlertCircle size={18} />
          <span>RPC unavailable — showing demo data. Add <code className="font-mono bg-orange-500/10 px-1 rounded">VITE_BASE_SEPOLIA_RPC</code> to <code className="font-mono bg-orange-500/10 px-1 rounded">.env</code> for live reads.</span>
        </div>
      )}

      {/* Header */}
      <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center mb-6 gap-4">
        <div>
          <h1 className="text-3xl font-bold text-white">Market</h1>
          <div className="flex items-center gap-3 mt-1 flex-wrap">
            <p className="text-gray-400 text-sm">NFT-backed loans & covered call options.</p>
            {!isMockData && !isLoading && <span className="text-green-400 text-xs">● Live on Base Sepolia</span>}
            {/* Live ETH price from Pyth */}
            <div className="flex items-center gap-1.5 text-xs bg-cyber-surface border border-cyber-border rounded-full px-2.5 py-1">
              <Zap size={10} className="text-yellow-400" />
              <span className="text-gray-500">ETH/USD</span>
              <span className="text-white font-medium font-mono">
                {ethPriceLoading ? '...' : ethPrice ? formatPriceUSD(ethPrice) : '—'}
              </span>
              <span className="text-gray-600 text-[10px]">Pyth</span>
            </div>
          </div>
        </div>

        {/* Create Deal button */}
        <div className="relative">
          <button
            onClick={() => setCreateMenuOpen(!createMenuOpen)}
            className="flex items-center gap-2 px-5 py-2.5 bg-base-blue text-white rounded-lg font-medium text-sm hover:bg-base-dark transition-colors shadow-lg shadow-base-blue/20"
          >
            <Plus size={16} />
            Create Deal
            <ChevronDown size={14} className={`transition-transform ${createMenuOpen ? 'rotate-180' : ''}`} />
          </button>
          {createMenuOpen && (
            <div className="absolute right-0 mt-2 w-48 bg-cyber-surface border border-cyber-border rounded-xl shadow-2xl z-10">
              <button
                onClick={() => { setIsCreateLoanOpen(true); setCreateMenuOpen(false); }}
                className="w-full text-left px-4 py-3 text-sm text-gray-300 hover:text-white hover:bg-white/5 rounded-t-xl flex items-center gap-2 transition-colors"
              >
                <Package size={14} className="text-base-blue" />
                NFT Loan Offer
              </button>
              <button
                onClick={() => { setIsWriteCallOpen(true); setCreateMenuOpen(false); }}
                className="w-full text-left px-4 py-3 text-sm text-gray-300 hover:text-white hover:bg-white/5 rounded-b-xl flex items-center gap-2 transition-colors"
              >
                <TrendingUp size={14} className="text-purple-400" />
                Covered Call
              </button>
            </div>
          )}
        </div>
      </div>

      {/* Filter bar */}
      <div className="flex flex-col sm:flex-row gap-3 mb-8">
        {/* Deal type tabs */}
        <div className="flex bg-cyber-surface border border-cyber-border rounded-lg p-0.5 gap-0.5">
          {(['all', 'loans', 'options'] as DealType[]).map(t => (
            <button
              key={t}
              onClick={() => setType(t)}
              className={`px-4 py-1.5 rounded-md text-sm font-medium transition-colors capitalize ${
                dealType === t ? 'bg-base-blue text-white' : 'text-gray-400 hover:text-white'
              }`}
            >
              {t === 'all' ? 'All' : t === 'loans' ? `Loans${!loanCounterError ? ` (${totalLoans})` : ''}` : `Options${!optionCounterError ? ` (${totalOptions})` : ''}`}
            </button>
          ))}
        </div>

        <div className="flex gap-2 items-center flex-wrap">
          {/* Active only toggle */}
          <label className="flex items-center gap-2 text-sm text-gray-400 cursor-pointer select-none">
            <input
              type="checkbox"
              checked={activeOnly}
              onChange={e => setActiveOnly(e.target.checked)}
              className="accent-blue-500"
            />
            Active Only
          </label>

          {/* My deals */}
          {address && (
            <label className="flex items-center gap-2 text-sm text-gray-400 cursor-pointer select-none">
              <input
                type="checkbox"
                checked={myDeals}
                onChange={e => setMyDeals(e.target.checked)}
                className="accent-blue-500"
              />
              My Deals
            </label>
          )}

          {/* Sort */}
          <div className="ml-auto flex items-center gap-2 text-sm text-gray-400">
            <Filter size={14} />
            <select
              value={sort}
              onChange={e => setSort(e.target.value as SortOrder)}
              className="bg-cyber-surface border border-cyber-border rounded-lg px-2 py-1 text-sm text-gray-300 focus:outline-none"
            >
              <option value="newest">Newest</option>
              <option value="oldest">Oldest</option>
              <option value="value_desc">Value: High</option>
              <option value="value_asc">Value: Low</option>
            </select>
          </div>
        </div>
      </div>

      {/* Loading — skeleton cards instead of spinner */}
      {isLoading && <SkeletonGrid count={6} />}

      {/* Empty */}
      {isEmpty && (
        <div className="text-center py-20 border border-dashed border-cyber-border rounded-xl">
          <Package className="mx-auto mb-4 text-gray-600" size={40} />
          <h3 className="text-lg font-semibold text-white mb-2">No deals yet</h3>
          <p className="text-gray-500 text-sm mb-6">
            Create the first listing, or seed the protocol with agent activity:
            <code className="ml-2 font-mono bg-cyber-surface px-1.5 py-0.5 rounded text-gray-300">npm run seed</code>
          </p>
          <button
            onClick={() => setCreateMenuOpen(true)}
            className="px-5 py-2.5 bg-base-blue text-white rounded-lg font-medium text-sm hover:bg-base-dark transition-colors"
          >
            Create First Deal
          </button>
        </div>
      )}

      {/* Deal Grid */}
      {!isLoading && !isEmpty && (
        <div className="grid md:grid-cols-2 lg:grid-cols-3 gap-6">
          {showLoans && loanIds.map(id => (
            <LoanCard key={`loan-${id}`} id={id} isMock={loanCounterError} address={address} myDeals={myDeals} activeOnly={activeOnly} />
          ))}
          {showOptions && optionIds.map(id => (
            <OptionCard key={`option-${id}`} id={id} isMock={optionCounterError} address={address} myDeals={myDeals} activeOnly={activeOnly} />
          ))}
        </div>
      )}

      {/* Create Loan Modal */}
      <CreateLoanModal isOpen={isCreateLoanOpen} onClose={() => setIsCreateLoanOpen(false)} address={address} />

      {/* Write Call Modal */}
      <WriteCallModal isOpen={isWriteCallOpen} onClose={() => setIsWriteCallOpen(false)} address={address} />
    </div>
  );
}

// ─── Copy address button ──────────────────────────────────────────────────────

function CopyAddress({ addr }: { addr: string }) {
  const [copied, setCopied] = useState(false);
  const handleCopy = (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    navigator.clipboard.writeText(addr);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };
  return (
    <button onClick={handleCopy} className="text-gray-600 hover:text-gray-300 transition-colors" title="Copy address">
      {copied ? <Check size={10} className="text-green-400" /> : <Copy size={10} />}
    </button>
  );
}

// ─── Loan Card ────────────────────────────────────────────────────────────────

function LoanCard({ id, isMock, address, myDeals, activeOnly }: { key?: React.Key; id: number; isMock: boolean; address?: string; myDeals?: boolean; activeOnly?: boolean }) {
  const [isFundModalOpen, setIsFundModalOpen] = useState(false);
  const [isBargainOpen, setIsBargainOpen] = useState(false);

  const { data: loanData } = useReadContract({
    address: CONTRACT_ADDRESSES.LOAN_ENGINE,
    abi: clawStreetLoanABI,
    functionName: 'loans',
    args: [BigInt(id)],
    query: { enabled: !isMock },
  });

  // Live health score (not the stale healthSnapshot from loan creation)
  const { data: liveHealth } = useReadContract({
    address: CONTRACT_ADDRESSES.LOAN_ENGINE,
    abi: clawStreetLoanABI,
    functionName: 'getHealthScore',
    args: loanData ? [loanData[2], loanData[3], loanData[4], loanData[0]] : undefined,
    query: { enabled: !isMock && !!loanData && loanData[9] /* active */ },
  });

  const publicClient = usePublicClient();
  const { writeContract: approveUsdc, isPending: isApproving, data: approveTxHash } = useWriteContract();
  const { isLoading: isApproveConfirming, isSuccess: isApproveSuccess } = useWaitForTransactionReceipt({ hash: approveTxHash });

  const { writeContract: fundLoan, isPending: isFunding, data: fundTxHash, error: fundError } = useWriteContract();
  const { isLoading: isFundConfirming, isSuccess: isFundSuccess } = useWaitForTransactionReceipt({ hash: fundTxHash });

  // Check lender's USDC allowance
  const principal = loanData ? loanData[4] : 0n;
  const { data: usdcAllowance } = useReadContract({
    address: CONTRACT_ADDRESSES.MOCK_USDC,
    abi: erc20ABI,
    functionName: 'allowance',
    args: address && loanData ? [address as `0x${string}`, CONTRACT_ADDRESSES.LOAN_ENGINE] : undefined,
    query: { enabled: !!address && !!loanData && isFundModalOpen },
  });

  const needsApproval = !isApproveSuccess && (usdcAllowance === undefined || (usdcAllowance as bigint) < principal);

  const handleApprove = () => {
    approveUsdc({
      address: CONTRACT_ADDRESSES.MOCK_USDC,
      abi: erc20ABI,
      functionName: 'approve',
      args: [CONTRACT_ADDRESSES.LOAN_ENGINE, principal],
    } as any);
  };

  const handleFund = async () => {
    try {
      const vaa = await fetchPythVAA([PYTH_FEEDS.ETH_USD]).catch(() => [] as `0x${string}`[]);
      // Get exact Pyth oracle fee on-chain (same as daemon does)
      let pythFee = 0n;
      if (vaa.length > 0 && publicClient) {
        try {
          pythFee = await (publicClient as any).readContract({
            address: '0xA2aa501b19aff244D90cc15a4Cf739D2725B5729' as `0x${string}`,
            abi: [{ name: 'getUpdateFee', type: 'function', stateMutability: 'view', inputs: [{ name: 'updateData', type: 'bytes[]' }], outputs: [{ name: 'feeAmount', type: 'uint256' }] }],
            functionName: 'getUpdateFee',
            args: [vaa],
          }) as bigint;
        } catch { pythFee = 1n; }
      }
      fundLoan({
        address: CONTRACT_ADDRESSES.LOAN_ENGINE,
        abi: clawStreetLoanABI,
        functionName: 'acceptLoan',
        args: [BigInt(id), vaa],
        value: pythFee,
      } as any);
    } catch {
      toast.error('Failed to fetch price data. Try again.');
    }
  };

  // Toast on success
  if (isFundSuccess && fundTxHash) {
    toast.tx(`Loan #${id} funded successfully!`, fundTxHash);
  }

  const agentInfo = loanData ? getAgentInfo(loanData[0]) : null;

  // Derive loan status from on-chain state
  // loanData: [borrower, lender, nftContract, nftId, principal, interest, duration, startTime, healthSnapshot, active, repaid]
  const ZERO_ADDR = '0x0000000000000000000000000000000000000000';
  const loanStatus = !loanData ? null
    : loanData[1] === ZERO_ADDR ? 'open'        // no lender yet — seeking funding
    : loanData[9]               ? 'funded'      // active loan running
    : loanData[10]              ? 'repaid'      // borrower repaid
    : 'ended';                                  // defaulted / closed

  const displayData = isMock ? {
    principal: '1500', duration: '30', interest: '75',
    health: 70 + (id * 7 % 30),
    loanStatus: 'open' as typeof loanStatus,
    nftContract: '0x8f3...2a1',
    borrower: '0x0000000000000000000000000000000000000000',
    isAgent: id % 2 === 0,
    agentName: id % 2 === 0 ? 'BorrowerAgent_Delta' : null,
  } : loanData ? {
    principal: formatUnits(loanData[4], 6),
    duration: (Number(loanData[6]) / 86400).toString(),
    interest: formatUnits(loanData[5], 6),
    health: liveHealth !== undefined ? Number(liveHealth) : Number(loanData[8]),
    loanStatus,
    nftContract: `${loanData[2].slice(0,6)}...${loanData[2].slice(-4)}`,
    borrower: loanData[0],
    isAgent: !!agentInfo,
    agentName: agentInfo?.name ?? null,
  } : null;

  if (!displayData) return null;
  // Active Only = show open (seeking funding) + funded (running). Hide repaid/ended.
  if (activeOnly && displayData.loanStatus !== 'open' && displayData.loanStatus !== 'funded') return null;

  // My Deals filter: show only if connected address is borrower or lender
  if (myDeals && address && !isMock && loanData) {
    const isBorrower = loanData[0].toLowerCase() === address.toLowerCase();
    const isLender   = loanData[1].toLowerCase() === address.toLowerCase();
    if (!isBorrower && !isLender) return null;
  }

  const apr = Math.round((Number(displayData.interest) / Number(displayData.principal)) * (365 / Number(displayData.duration)) * 100);

  return (
    <motion.div
      initial={{ opacity: 0, scale: 0.95 }}
      animate={{ opacity: 1, scale: 1 }}
      className="bg-cyber-surface rounded-xl border border-cyber-border overflow-hidden hover:border-base-blue/30 transition-colors flex flex-col"
    >
      {/* Card header */}
      <div className="h-20 bg-cyber-bg relative flex items-center justify-center border-b border-cyber-border">
        <Package className="text-gray-500 w-7 h-7" />
        <div className="absolute top-2 left-3 flex items-center gap-1.5">
          <span className="text-[10px] font-bold px-2 py-0.5 rounded bg-base-blue/20 text-base-blue border border-base-blue/30 uppercase tracking-wider">
            LOAN
          </span>
          {/* Status badge */}
          {displayData.loanStatus === 'open' && (
            <span className="text-[10px] font-bold px-2 py-0.5 rounded bg-green-500/20 text-green-400 border border-green-500/30 uppercase tracking-wider">OPEN</span>
          )}
          {displayData.loanStatus === 'funded' && (
            <span className="text-[10px] font-bold px-2 py-0.5 rounded bg-blue-500/20 text-blue-400 border border-blue-500/30 uppercase tracking-wider">FUNDED</span>
          )}
          {displayData.loanStatus === 'repaid' && (
            <span className="text-[10px] font-bold px-2 py-0.5 rounded bg-gray-500/20 text-gray-400 border border-gray-500/30 uppercase tracking-wider">REPAID</span>
          )}
          {displayData.loanStatus === 'ended' && (
            <span className="text-[10px] font-bold px-2 py-0.5 rounded bg-red-500/20 text-red-400 border border-red-500/30 uppercase tracking-wider">ENDED</span>
          )}
          {/* TEST CYCLE badge */}
          {displayData.isAgent && !isMock && displayData.loanStatus === 'open' && (
            <span className="text-[10px] font-bold px-2 py-0.5 rounded bg-yellow-500/20 text-yellow-400 border border-yellow-500/30 uppercase tracking-wider" title="Created by CTP automation — external funding welcome">
              TEST CYCLE
            </span>
          )}
        </div>
        {/* Health badge — only shown when loan is funded/running */}
        {displayData.loanStatus === 'funded' && (
          <div className={`absolute top-2 right-3 backdrop-blur-sm px-2 py-0.5 rounded text-[10px] font-mono border ${
            displayData.health >= 80 ? 'bg-green-500/10 text-green-400 border-green-500/30'
            : displayData.health >= 60 ? 'bg-yellow-500/10 text-yellow-400 border-yellow-500/30'
            : 'bg-red-500/10 text-red-400 border-red-500/30'
          }`}>
            Health: {liveHealth !== undefined ? displayData.health : `~${displayData.health}`}
          </div>
        )}
      </div>

      <div className="p-4 flex-grow flex flex-col">
        <div className="flex justify-between items-start mb-3">
          <div>
            <h3 className="font-bold text-white text-sm">
              #{id} · {displayData.agentName ?? (displayData.isAgent ? 'Agent' : 'User')} Collateral
            </h3>
            <div className="flex items-center gap-1 mt-0.5">
              <p className="text-xs text-gray-500 font-mono">{displayData.nftContract}</p>
              <CopyAddress addr={typeof displayData.borrower === 'string' ? displayData.borrower : ''} />
            </div>
          </div>
          {displayData.isAgent ? (
            <Link to={`/profile/${displayData.borrower}`} className="flex items-center text-[10px] text-green-400 bg-green-500/10 border border-green-500/20 px-1.5 py-0.5 rounded hover:bg-green-500/20 transition-colors" title="View agent profile">
              <ShieldCheck size={10} className="mr-1" />
              AGENT
            </Link>
          ) : (
            <Link to={`/profile/${displayData.borrower}`} className="flex items-center text-[10px] text-gray-400 bg-gray-500/10 border border-gray-500/20 px-1.5 py-0.5 rounded hover:bg-gray-500/20 transition-colors">
              <User size={10} className="mr-1" />
              User
            </Link>
          )}
        </div>

        <div className="grid grid-cols-2 gap-2 mb-4 flex-grow">
          <div className="bg-cyber-bg p-2 rounded-lg border border-cyber-border">
            <p className="text-[10px] text-gray-500 mb-0.5 uppercase tracking-wider">Principal</p>
            <p className="font-semibold text-white text-sm">{displayData.principal} USDC</p>
          </div>
          <div className="bg-cyber-bg p-2 rounded-lg border border-cyber-border">
            <p className="text-[10px] text-gray-500 mb-0.5 uppercase tracking-wider">Duration</p>
            <p className="font-semibold text-white text-sm">{displayData.duration}d</p>
          </div>
          <div className="bg-cyber-bg p-2 rounded-lg border border-cyber-border">
            <p className="text-[10px] text-gray-500 mb-0.5 uppercase tracking-wider">Interest</p>
            <p className="font-semibold text-green-400 text-sm">+{displayData.interest} USDC</p>
          </div>
          <div className="bg-cyber-bg p-2 rounded-lg border border-cyber-border">
            <p className="text-[10px] text-gray-500 mb-0.5 uppercase tracking-wider">APR</p>
            <p className="font-semibold text-white text-sm">{apr}%</p>
          </div>
        </div>

        <div className="flex gap-2">
          <Link to={`/loan/${id}`} className="flex-1 py-2 bg-cyber-bg text-white border border-cyber-border rounded-lg font-semibold text-xs hover:bg-cyber-surface transition-colors text-center">
            Details
          </Link>
          {displayData.loanStatus === 'open' && (
            <>
              <button onClick={() => setIsFundModalOpen(true)} className="flex-1 py-2 bg-white text-black rounded-lg font-semibold text-xs hover:bg-gray-200 transition-colors">
                Fund Loan
              </button>
              {!isMock && address && address.toLowerCase() !== displayData.borrower?.toLowerCase() && (
                <button
                  onClick={() => setIsBargainOpen(true)}
                  title="Propose different terms"
                  className="px-2.5 py-2 bg-cyber-bg border border-cyber-border text-gray-500 hover:text-base-blue hover:border-base-blue/40 rounded-lg text-xs transition-colors"
                >
                  <MessageSquare size={13} />
                </button>
              )}
            </>
          )}
          {displayData.loanStatus === 'funded' && (
            <span className="flex-1 py-2 bg-blue-500/10 text-blue-400 border border-blue-500/20 rounded-lg font-semibold text-xs text-center">Active Loan</span>
          )}
          {(displayData.loanStatus === 'repaid' || displayData.loanStatus === 'ended') && (
            <span className="flex-1 py-2 bg-cyber-border text-gray-500 rounded-lg font-semibold text-xs text-center cursor-not-allowed">Closed</span>
          )}
        </div>
        {!isMock && isBargainOpen && (
          <BargainModal
            isOpen={isBargainOpen}
            onClose={() => setIsBargainOpen(false)}
            dealType="loan"
            dealId={id}
            dealOwner={displayData.borrower ?? ''}
            address={address}
            currentTermLabel={`Interest: ${displayData.interest} USDC`}
            termKey="interestRate"
            termLabel="Proposed Interest (USDC)"
          />
        )}

        <Modal isOpen={isFundModalOpen} onClose={() => setIsFundModalOpen(false)} title="Confirm Funding">
          <div className="space-y-4">
            <p className="text-sm text-gray-400">Fund Loan #{id} with <strong className="text-white">{displayData.principal} USDC</strong>. You receive principal + <strong className="text-green-400">{displayData.interest} USDC</strong> interest after {displayData.duration} days.</p>
            {isFundSuccess && <div className="p-3 bg-green-500/20 border border-green-500/50 rounded-lg text-green-400 text-sm">Funded! Tx: {fundTxHash?.slice(0, 10)}...</div>}
            {fundError && <div className="p-3 bg-red-500/20 border border-red-500/50 rounded-lg text-red-400 text-xs break-all">{(fundError as Error).message?.split('\n')[0]}</div>}
            {!address ? (
              <div className="w-full py-2.5 bg-cyber-border text-gray-400 rounded-lg font-medium text-sm text-center">Connect Wallet</div>
            ) : needsApproval ? (
              <button onClick={handleApprove} disabled={isApproving || isApproveConfirming} className="w-full py-2.5 bg-yellow-500 text-black rounded-lg font-medium text-sm hover:bg-yellow-400 transition-colors disabled:opacity-50">
                {isApproving || isApproveConfirming ? 'Approving USDC...' : `1. Approve ${displayData.principal} USDC`}
              </button>
            ) : (
              <button onClick={handleFund} disabled={isFunding || isFundConfirming || isFundSuccess} className="w-full py-2.5 bg-base-blue text-white rounded-lg font-medium text-sm hover:bg-base-dark transition-colors disabled:opacity-50">
                {isFunding || isFundConfirming ? 'Confirming...' : isFundSuccess ? 'Funded ✓' : 'Confirm & Fund'}
              </button>
            )}
          </div>
        </Modal>
      </div>
    </motion.div>
  );
}

// ─── Option Card ──────────────────────────────────────────────────────────────

function OptionCard({ id, isMock, address, myDeals, activeOnly }: { key?: React.Key; id: number; isMock: boolean; address?: string; myDeals?: boolean; activeOnly?: boolean }) {
  const [isBuyModalOpen, setIsBuyModalOpen] = useState(false);
  const [isBargainOpen, setIsBargainOpen] = useState(false);

  const { data: optionData } = useReadContract({
    address: CONTRACT_ADDRESSES.CALL_VAULT,
    abi: clawStreetCallVaultABI,
    functionName: 'options',
    args: [BigInt(id)],
    query: { enabled: !isMock },
  });

  const { writeContract: approveUsdcOpt, isPending: isApprovingOpt, data: approveTxHashOpt } = useWriteContract();
  const { isLoading: isApproveConfirmingOpt, isSuccess: isApproveSuccessOpt } = useWaitForTransactionReceipt({ hash: approveTxHashOpt });

  const { writeContract: buyOption, isPending: isBuying, data: buyTxHash, error: buyError } = useWriteContract();
  const { isLoading: isBuyConfirming, isSuccess: isBuySuccess } = useWaitForTransactionReceipt({ hash: buyTxHash });

  const premium = optionData ? optionData[6] : 0n;
  const { data: usdcAllowanceOpt } = useReadContract({
    address: CONTRACT_ADDRESSES.MOCK_USDC,
    abi: erc20ABI,
    functionName: 'allowance',
    args: address && optionData ? [address as `0x${string}`, CONTRACT_ADDRESSES.CALL_VAULT] : undefined,
    query: { enabled: !!address && !!optionData && isBuyModalOpen },
  });

  const needsApprovalOpt = !isApproveSuccessOpt && (usdcAllowanceOpt === undefined || (usdcAllowanceOpt as bigint) < premium);

  const handleApproveOpt = () => {
    approveUsdcOpt({
      address: CONTRACT_ADDRESSES.MOCK_USDC,
      abi: erc20ABI,
      functionName: 'approve',
      args: [CONTRACT_ADDRESSES.CALL_VAULT, premium],
    } as any);
  };

  const handleBuy = () => {
    buyOption({ address: CONTRACT_ADDRESSES.CALL_VAULT, abi: clawStreetCallVaultABI, functionName: 'buyOption', args: [BigInt(id)] } as any);
  };

  // Toast on buy success
  if (isBuySuccess && buyTxHash) {
    toast.tx(`Option #${id} purchased!`, buyTxHash);
  }

  const agentInfo = optionData ? getAgentInfo(optionData[0]) : null;
  const expirySecondsLeft = optionData ? Number(optionData[5]) - Date.now() / 1000 : null;

  const displayData = isMock ? {
    writer: '0x1234567890abcdef1234', underlying: 'tWETH', amount: '1.5', strike: '3800', premium: '85',
    expiryDays: 5, expiryHours: 0, isExpired: false, active: true, exercised: false,
    buyer: '0x0000000000000000000000000000000000000000',
    isAgent: id % 2 === 0, agentName: id % 2 === 0 ? 'HedgeAgent_Epsilon' : null,
    expiringSoon: false,
  } : optionData ? {
    writer: optionData[0],
    underlying: `${optionData[2].slice(0,6)}...${optionData[2].slice(-4)}`,
    amount: formatUnits(optionData[3], 18),
    strike: formatUnits(optionData[4], 6),
    premium: formatUnits(optionData[6], 6),
    expiryDays: Math.max(0, Math.floor((expirySecondsLeft ?? 0) / 86400)),
    expiryHours: Math.max(0, Math.floor(((expirySecondsLeft ?? 0) % 86400) / 3600)),
    isExpired: (expirySecondsLeft ?? 1) <= 0,
    active: optionData[8],
    exercised: optionData[7],
    buyer: optionData[1],
    isAgent: !!agentInfo,
    agentName: agentInfo?.name ?? null,
    expiringSoon: (expirySecondsLeft ?? Infinity) < 86400 && (expirySecondsLeft ?? 1) > 0,
  } : null;

  if (!displayData) return null;
  // Active Only = hide expired and exercised options. Show OPEN + SOLD.
  if (activeOnly && (displayData.isExpired || displayData.exercised)) return null;

  // My Deals filter: show only if connected address is writer or buyer
  if (myDeals && address && !isMock && optionData) {
    const isWriter = optionData[0].toLowerCase() === address.toLowerCase();
    const isBuyer  = optionData[1].toLowerCase() !== '0x0000000000000000000000000000000000000000'
                     && optionData[1].toLowerCase() === address.toLowerCase();
    if (!isWriter && !isBuyer) return null;
  }

  const isAvailable = displayData.buyer === '0x0000000000000000000000000000000000000000';
  const statusLabel = displayData.exercised ? 'EXERCISED' : displayData.isExpired ? 'EXPIRED' : isAvailable ? 'OPEN' : 'SOLD';
  const statusColor = displayData.exercised ? 'bg-gray-500/20 text-gray-400 border-gray-500/30'
    : displayData.isExpired ? 'bg-red-500/20 text-red-400 border-red-500/30'
    : isAvailable ? 'bg-green-500/20 text-green-400 border-green-500/30'
    : 'bg-purple-500/20 text-purple-400 border-purple-500/30';

  return (
    <motion.div
      initial={{ opacity: 0, scale: 0.95 }}
      animate={{ opacity: 1, scale: 1 }}
      className={`bg-cyber-surface rounded-xl border overflow-hidden flex flex-col transition-colors ${
        displayData.isExpired || displayData.exercised
          ? 'border-cyber-border/40 opacity-60'
          : displayData.expiringSoon
          ? 'border-red-500/50 hover:border-red-500/70 shadow-[0_0_12px_rgba(239,68,68,0.15)] animate-pulse-border'
          : 'border-cyber-border hover:border-purple-500/30'
      }`}
    >
      <div className="h-20 bg-cyber-bg relative flex items-center justify-center border-b border-cyber-border">
        <TrendingUp className="text-gray-500 w-7 h-7" />
        <div className="absolute top-2 left-3 flex items-center gap-1.5">
          <span className="text-[10px] font-bold px-2 py-0.5 rounded bg-purple-500/20 text-purple-400 border border-purple-500/30 uppercase tracking-wider">
            CALL OPTION
          </span>
          {/* TEST CYCLE badge — shown when a known agent wrote an available (unbuilt) option */}
          {displayData.isAgent && isAvailable && !isMock && (
            <span className="text-[10px] font-bold px-2 py-0.5 rounded bg-yellow-500/20 text-yellow-400 border border-yellow-500/30 uppercase tracking-wider" title="Created by CTP automation — external purchase welcome">
              TEST CYCLE
            </span>
          )}
        </div>
        <div className={`absolute top-2 right-3 text-[10px] font-bold px-2 py-0.5 rounded border uppercase tracking-wider ${statusColor}`}>
          {statusLabel}
        </div>
      </div>

      <div className="p-4 flex-grow flex flex-col">
        <div className="flex justify-between items-start mb-3">
          <div>
            <h3 className="font-bold text-white text-sm">
              #{id} · {displayData.agentName ? `${displayData.agentName} ` : ''}{displayData.amount} {displayData.underlying} @ ${displayData.strike}
            </h3>
            <div className="flex items-center gap-1 mt-0.5">
              <p className={`text-xs ${displayData.expiringSoon ? 'text-red-400 font-medium' : 'text-gray-500'}`}>
                {displayData.isExpired
                  ? 'Expired'
                  : displayData.expiringSoon
                  ? `⚠ Expires in ${displayData.expiryHours}h`
                  : `Expires in ${displayData.expiryDays}d`}
              </p>
              <CopyAddress addr={typeof displayData.writer === 'string' ? displayData.writer : ''} />
            </div>
          </div>
          {displayData.isAgent ? (
            <Link to={`/profile/${displayData.writer}`} className="flex items-center text-[10px] text-green-400 bg-green-500/10 border border-green-500/20 px-1.5 py-0.5 rounded hover:bg-green-500/20 transition-colors">
              <ShieldCheck size={10} className="mr-1" />
              AGENT
            </Link>
          ) : (
            <Link to={`/profile/${displayData.writer}`} className="flex items-center text-[10px] text-gray-400 bg-gray-500/10 border border-gray-500/20 px-1.5 py-0.5 rounded">
              <User size={10} className="mr-1" />
              Writer
            </Link>
          )}
        </div>

        <div className="flex items-end justify-between mt-auto">
          <div>
            <p className="text-[10px] text-gray-500 uppercase tracking-wider mb-0.5">Premium</p>
            <p className={`font-bold text-lg ${displayData.exercised ? 'text-gray-500' : 'text-purple-400'}`}>{displayData.premium} USDC</p>
          </div>
          <div className="flex gap-2">
            <Link to={`/option/${id}`} className="px-3 py-2 bg-cyber-bg text-white border border-cyber-border rounded-lg font-semibold text-xs hover:bg-cyber-surface transition-colors">
              Details
            </Link>
            {isAvailable && !displayData.isExpired && !displayData.exercised ? (
              <>
                <button onClick={() => setIsBuyModalOpen(true)} className="px-3 py-2 bg-white text-black rounded-lg font-semibold text-xs hover:bg-gray-200 transition-colors">
                  Buy
                </button>
                {!isMock && address && address.toLowerCase() !== (typeof displayData.writer === 'string' ? displayData.writer.toLowerCase() : '') && (
                  <button
                    onClick={() => setIsBargainOpen(true)}
                    title="Propose different premium"
                    className="px-2.5 py-2 bg-cyber-bg border border-cyber-border text-gray-500 hover:text-purple-400 hover:border-purple-500/40 rounded-lg text-xs transition-colors"
                  >
                    <MessageSquare size={13} />
                  </button>
                )}
              </>
            ) : displayData.exercised ? (
              <span className="px-3 py-2 bg-cyber-border text-gray-500 rounded-lg font-semibold text-xs cursor-not-allowed">Settled</span>
            ) : null}
          </div>
        </div>
        {!isMock && isBargainOpen && (
          <BargainModal
            isOpen={isBargainOpen}
            onClose={() => setIsBargainOpen(false)}
            dealType="option"
            dealId={id}
            dealOwner={typeof displayData.writer === 'string' ? displayData.writer : ''}
            address={address}
            currentTermLabel={`Premium: ${displayData.premium} USDC`}
            termKey="premium"
            termLabel="Proposed Premium (USDC)"
          />
        )}

        <Modal isOpen={isBuyModalOpen} onClose={() => setIsBuyModalOpen(false)} title="Buy Call Option">
          <div className="space-y-4">
            <p className="text-sm text-gray-400">Buy a call option for <strong className="text-white">{displayData.amount} {displayData.underlying}</strong> at strike <strong className="text-white">${displayData.strike}</strong>, expires in {displayData.expiryDays} days.</p>
            <div className="p-4 bg-cyber-bg rounded-lg border border-cyber-border flex justify-between items-center">
              <span className="text-sm text-gray-400">Premium Cost</span>
              <span className="text-lg font-bold text-purple-400">{displayData.premium} USDC</span>
            </div>
            {isBuySuccess && <div className="p-3 bg-green-500/20 border border-green-500/50 rounded-lg text-green-400 text-sm">Purchased! Tx: {buyTxHash?.slice(0, 10)}...</div>}
            {buyError && <div className="p-3 bg-red-500/20 border border-red-500/50 rounded-lg text-red-400 text-xs break-all">{(buyError as Error).message?.split('\n')[0]}</div>}
            {!address ? (
              <div className="w-full py-2.5 bg-cyber-border text-gray-400 rounded-lg font-medium text-sm text-center">Connect Wallet</div>
            ) : needsApprovalOpt ? (
              <button onClick={handleApproveOpt} disabled={isApprovingOpt || isApproveConfirmingOpt} className="w-full py-2.5 bg-yellow-500 text-black rounded-lg font-medium text-sm hover:bg-yellow-400 transition-colors disabled:opacity-50">
                {isApprovingOpt || isApproveConfirmingOpt ? 'Approving USDC...' : `1. Approve ${displayData.premium} USDC`}
              </button>
            ) : (
              <button onClick={handleBuy} disabled={isBuying || isBuyConfirming || isBuySuccess} className="w-full py-2.5 bg-base-blue text-white rounded-lg font-medium text-sm hover:bg-base-dark transition-colors disabled:opacity-50">
                {isBuying || isBuyConfirming ? 'Confirming...' : isBuySuccess ? 'Purchased ✓' : 'Confirm Purchase'}
              </button>
            )}
          </div>
        </Modal>
      </div>
    </motion.div>
  );
}

// ─── Create Loan Modal ────────────────────────────────────────────────────────

function CreateLoanModal({ isOpen, onClose, address }: { isOpen: boolean; onClose: () => void; address?: string }) {
  const [nftContract, setNftContract] = useState('');
  const [nftId, setNftId] = useState('');
  const [principal, setPrincipal] = useState('');
  const [duration, setDuration] = useState('');
  const [interest, setInterest] = useState('');

  const { writeContract: approveNft, data: approveTxHash, isPending: isApproving } = useWriteContract();
  const { writeContract: createLoan, data: createTxHash, isPending: isCreating } = useWriteContract();
  const { isLoading: isApproveConfirming, isSuccess: isApproveSuccess } = useWaitForTransactionReceipt({ hash: approveTxHash });
  const { isLoading: isCreateConfirming, isSuccess: isCreateSuccess } = useWaitForTransactionReceipt({ hash: createTxHash });

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!isApproveSuccess) {
      approveNft({ address: nftContract as `0x${string}`, abi: erc721ABI, functionName: 'approve', args: [CONTRACT_ADDRESSES.LOAN_ENGINE, BigInt(nftId)] } as any);
      return;
    }
    createLoan({ address: CONTRACT_ADDRESSES.LOAN_ENGINE, abi: clawStreetLoanABI, functionName: 'createLoanOffer', args: [nftContract as `0x${string}`, BigInt(nftId), parseUnits(principal, 6), parseUnits(interest, 6), BigInt(Number(duration) * 86400)] } as any);
  };

  return (
    <Modal isOpen={isOpen} onClose={onClose} title="Create NFT Loan Offer">
      {isCreateSuccess && <div className="mb-4 p-3 bg-green-500/20 border border-green-500/50 rounded-lg text-green-400 text-sm">Offer created! Tx: {createTxHash?.slice(0, 10)}...</div>}
      <form className="space-y-4" onSubmit={handleSubmit}>
        <div>
          <label className="block text-xs font-medium text-gray-400 mb-1">NFT Contract</label>
          <input type="text" value={nftContract} onChange={e => setNftContract(e.target.value)} className="w-full bg-cyber-bg border border-cyber-border rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-base-blue" placeholder={`MockNFT: ${CONTRACT_ADDRESSES.MOCK_NFT}`} required />
        </div>
        <div>
          <label className="block text-xs font-medium text-gray-400 mb-1">Token ID</label>
          <input type="text" value={nftId} onChange={e => setNftId(e.target.value)} className="w-full bg-cyber-bg border border-cyber-border rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-base-blue" placeholder="1" required />
        </div>
        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="block text-xs font-medium text-gray-400 mb-1">Principal (USDC)</label>
            <input type="number" value={principal} onChange={e => setPrincipal(e.target.value)} className="w-full bg-cyber-bg border border-cyber-border rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-base-blue" placeholder="1000" required />
          </div>
          <div>
            <label className="block text-xs font-medium text-gray-400 mb-1">Duration (Days)</label>
            <input type="number" value={duration} onChange={e => setDuration(e.target.value)} className="w-full bg-cyber-bg border border-cyber-border rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-base-blue" placeholder="30" required />
          </div>
        </div>
        <div>
          <label className="block text-xs font-medium text-gray-400 mb-1">Total Interest (USDC)</label>
          <input type="number" value={interest} onChange={e => setInterest(e.target.value)} className="w-full bg-cyber-bg border border-cyber-border rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-base-blue" placeholder="50" required />
        </div>
        {!address ? (
          <div className="w-full py-2.5 bg-cyber-border text-gray-400 rounded-lg font-medium text-sm text-center">Connect Wallet Required</div>
        ) : (
          <button type="submit" disabled={isApproving || isApproveConfirming || isCreating || isCreateConfirming} className="w-full py-2.5 bg-base-blue text-white rounded-lg font-medium text-sm hover:bg-base-dark transition-colors disabled:opacity-50">
            {!isApproveSuccess ? (isApproving || isApproveConfirming ? 'Approving...' : '1. Approve NFT') : (isCreating || isCreateConfirming ? 'Creating...' : '2. Create Offer')}
          </button>
        )}
      </form>
    </Modal>
  );
}

// ─── Write Call Modal ─────────────────────────────────────────────────────────

function WriteCallModal({ isOpen, onClose, address }: { isOpen: boolean; onClose: () => void; address?: string }) {
  const [underlying, setUnderlying] = useState('');
  const [amount, setAmount] = useState('');
  const [strike, setStrike] = useState('');
  const [expiry, setExpiry] = useState('');
  const [premium, setPremium] = useState('');

  const { writeContract: approveToken, data: approveTxHash, isPending: isApproving } = useWriteContract();
  const { writeContract: writeCall, data: writeTxHash, isPending: isWriting } = useWriteContract();
  const { isLoading: isApproveConfirming, isSuccess: isApproveSuccess } = useWaitForTransactionReceipt({ hash: approveTxHash });
  const { isLoading: isWriteConfirming, isSuccess: isWriteSuccess } = useWaitForTransactionReceipt({ hash: writeTxHash });

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!isApproveSuccess) {
      approveToken({ address: underlying as `0x${string}`, abi: erc20ABI, functionName: 'approve', args: [CONTRACT_ADDRESSES.CALL_VAULT, parseUnits(amount, 18)] } as any);
      return;
    }
    writeCall({ address: CONTRACT_ADDRESSES.CALL_VAULT, abi: clawStreetCallVaultABI, functionName: 'writeCoveredCall', args: [underlying as `0x${string}`, parseUnits(amount, 18), parseUnits(strike, 6), BigInt(Math.floor(Date.now() / 1000) + Number(expiry) * 86400), parseUnits(premium, 6)] } as any);
  };

  return (
    <Modal isOpen={isOpen} onClose={onClose} title="Write Covered Call">
      {isWriteSuccess && <div className="mb-4 p-3 bg-green-500/20 border border-green-500/50 rounded-lg text-green-400 text-sm">Call written! Tx: {writeTxHash?.slice(0, 10)}...</div>}
      <form className="space-y-4" onSubmit={handleSubmit}>
        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="block text-xs font-medium text-gray-400 mb-1">Underlying Address</label>
            <input type="text" value={underlying} onChange={e => setUnderlying(e.target.value)} className="w-full bg-cyber-bg border border-cyber-border rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-base-blue" placeholder="0x..." required />
          </div>
          <div>
            <label className="block text-xs font-medium text-gray-400 mb-1">Amount</label>
            <input type="number" value={amount} onChange={e => setAmount(e.target.value)} className="w-full bg-cyber-bg border border-cyber-border rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-base-blue" placeholder="1.0" required />
          </div>
        </div>
        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="block text-xs font-medium text-gray-400 mb-1">Strike Price (USDC)</label>
            <input type="number" value={strike} onChange={e => setStrike(e.target.value)} className="w-full bg-cyber-bg border border-cyber-border rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-base-blue" placeholder="2000" required />
          </div>
          <div>
            <label className="block text-xs font-medium text-gray-400 mb-1">Expiry (Days)</label>
            <input type="number" value={expiry} onChange={e => setExpiry(e.target.value)} className="w-full bg-cyber-bg border border-cyber-border rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-base-blue" placeholder="7" required />
          </div>
        </div>
        <div>
          <label className="block text-xs font-medium text-gray-400 mb-1">Premium Asked (USDC)</label>
          <input type="number" value={premium} onChange={e => setPremium(e.target.value)} className="w-full bg-cyber-bg border border-cyber-border rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-base-blue" placeholder="50" required />
        </div>
        {!address ? (
          <div className="w-full py-2.5 bg-cyber-border text-gray-400 rounded-lg font-medium text-sm text-center">Connect Wallet Required</div>
        ) : (
          <button type="submit" disabled={isApproving || isApproveConfirming || isWriting || isWriteConfirming} className="w-full py-2.5 bg-base-blue text-white rounded-lg font-medium text-sm hover:bg-base-dark transition-colors disabled:opacity-50">
            {!isApproveSuccess ? (isApproving || isApproveConfirming ? 'Approving...' : '1. Approve Asset') : (isWriting || isWriteConfirming ? 'Writing...' : '2. Lock & Write Call')}
          </button>
        )}
      </form>
    </Modal>
  );
}
