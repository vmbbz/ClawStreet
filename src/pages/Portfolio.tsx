import React, { useState, useEffect } from 'react';
import { Link } from 'react-router-dom';
import { useReadContract, useWriteContract, useAccount, useWaitForTransactionReceipt } from 'wagmi';
import { formatUnits } from 'viem';
import { CONTRACT_ADDRESSES, clawStreetLoanABI, clawStreetCallVaultABI, getTokenSymbol } from '../config/contracts';
import { Modal } from '../components/Modal';
import { AlertCircle, ShieldCheck, User, Loader2, Wallet, Target, Copy, Check } from 'lucide-react';
import { toast } from '../components/Toast';

function CopyAddress({ addr }: { addr: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      onClick={e => { e.stopPropagation(); navigator.clipboard.writeText(addr); setCopied(true); setTimeout(() => setCopied(false), 1500); }}
      className="ml-1 text-gray-600 hover:text-gray-300 transition-colors"
      title="Copy address"
    >
      {copied ? <Check size={10} className="text-green-400" /> : <Copy size={10} />}
    </button>
  );
}

type PortfolioTab = 'loans' | 'options';

export default function Portfolio() {
  const { address } = useAccount();
  const [tab, setTab] = useState<PortfolioTab>('loans');

  const { data: loanCounter, isError: isLoanError } = useReadContract({
    address: CONTRACT_ADDRESSES.LOAN_ENGINE,
    abi: clawStreetLoanABI,
    functionName: 'loanCounter',
  });

  const { data: optionCounter, isError: isOptionError } = useReadContract({
    address: CONTRACT_ADDRESSES.CALL_VAULT,
    abi: clawStreetCallVaultABI,
    functionName: 'optionCounter',
  });

  const isCounterError = isLoanError && isOptionError;
  const isLoading = (loanCounter === undefined && !isLoanError) || (optionCounter === undefined && !isOptionError);
  const isMockData = isCounterError;
  const totalLoans = isMockData ? 2 : Number(loanCounter ?? 0);
  const totalOptions = isMockData ? 1 : Number(optionCounter ?? 0);
  const isEmpty = !isLoading && !isMockData && totalLoans === 0 && totalOptions === 0;
  const loanIds = Array.from({ length: totalLoans }, (_, i) => i);
  const optionIds = Array.from({ length: totalOptions }, (_, i) => i);

  const TABS: { key: PortfolioTab; label: string; count: number }[] = [
    { key: 'loans',   label: 'Loans',   count: totalLoans   },
    { key: 'options', label: 'Options', count: totalOptions },
  ];

  return (
    <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-12">
      {isMockData && (
        <div className="mb-6 p-4 bg-orange-500/10 border border-orange-500/20 rounded-lg flex items-center space-x-3 text-orange-400 text-sm">
          <AlertCircle size={18} />
          <span>RPC unavailable — showing demo portfolio data.</span>
        </div>
      )}

      {!address && (
        <div className="mb-6 p-4 bg-cyber-surface border border-cyber-border rounded-lg flex items-center space-x-3 text-gray-400 text-sm">
          <Wallet size={18} />
          <span>Connect your wallet to see your positions.</span>
        </div>
      )}

      <h1 className="text-3xl font-bold mb-2 text-white">Portfolio</h1>
      <p className="text-gray-400 text-sm mb-6">
        Your active and historical positions on ClawStreet.
        {!isMockData && !isLoading && <span className="ml-2 text-green-400">● Live</span>}
      </p>

      {/* Tab bar */}
      <div className="flex gap-1 mb-8 border-b border-cyber-border">
        {TABS.map(t => (
          <button
            key={t.key}
            onClick={() => setTab(t.key)}
            className={`flex items-center gap-2 px-4 py-2.5 text-sm font-medium rounded-t-md transition-colors ${
              tab === t.key
                ? 'text-white border-b-2 border-base-blue -mb-px'
                : 'text-gray-500 hover:text-gray-300'
            }`}
          >
            {t.label}
            {!isLoading && t.count > 0 && (
              <span className={`text-[10px] font-bold px-1.5 py-0.5 rounded-full ${
                tab === t.key
                  ? 'bg-base-blue/20 text-base-blue'
                  : 'bg-white/8 text-gray-500'
              }`}>
                {t.count}
              </span>
            )}
          </button>
        ))}
      </div>

      {isLoading && (
        <div className="flex items-center justify-center py-20 text-gray-500">
          <Loader2 className="animate-spin mr-3" size={20} />
          <span className="text-sm">Reading from Base Sepolia...</span>
        </div>
      )}

      {isEmpty && (
        <div className="text-center py-20 border border-dashed border-cyber-border rounded-xl">
          <Wallet className="mx-auto mb-4 text-gray-600" size={40} />
          <h3 className="text-lg font-semibold text-white mb-2">No positions yet</h3>
          <p className="text-gray-500 text-sm">Visit the <Link to="/market" className="text-base-blue hover:underline">Market</Link> to create or fund a deal.</p>
        </div>
      )}

      {/* Loans tab */}
      {!isLoading && !isEmpty && tab === 'loans' && (
        <div className="grid md:grid-cols-2 gap-8">
          <div>
            <h2 className="text-lg font-semibold mb-4 text-gray-300 border-b border-cyber-border pb-2">Borrowed</h2>
            <div className="space-y-4">
              {loanIds.map(id => (
                <BorrowedItem key={`borrow-${id}`} id={id} isMock={isMockData} />
              ))}
              {isMockData && <BorrowedItem id={99} isMock={true} />}
            </div>
          </div>
          <div>
            <h2 className="text-lg font-semibold mb-4 text-gray-300 border-b border-cyber-border pb-2">Lent</h2>
            <div className="space-y-4">
              {loanIds.map(id => (
                <LentItem key={`lent-${id}`} id={id} isMock={isMockData} />
              ))}
            </div>
          </div>
        </div>
      )}

      {/* Options tab */}
      {!isLoading && !isEmpty && tab === 'options' && (
        <div className="grid md:grid-cols-2 gap-8">
          <div>
            <h2 className="text-lg font-semibold mb-4 text-gray-300 border-b border-cyber-border pb-2">Written (as writer)</h2>
            <div className="space-y-4">
              {optionIds.map(id => (
                <WrittenOptionItem key={`written-${id}`} id={id} isMock={isMockData} />
              ))}
            </div>
          </div>
          <div>
            <h2 className="text-lg font-semibold mb-4 text-gray-300 border-b border-cyber-border pb-2">Bought (as buyer)</h2>
            <div className="space-y-4">
              {optionIds.map(id => (
                <BoughtOptionItem key={`bought-${id}`} id={id} isMock={isMockData} />
              ))}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function BorrowedItem({ id, isMock }: { id: number, isMock: boolean, key?: React.Key }) {
  const { address } = useAccount();
  const [isRepayModalOpen, setIsRepayModalOpen] = useState(false);
  const [isCancelModalOpen, setIsCancelModalOpen] = useState(false);

  const { data: loanData } = useReadContract({
    address: CONTRACT_ADDRESSES.LOAN_ENGINE,
    abi: clawStreetLoanABI,
    functionName: 'loans',
    args: [BigInt(id)],
    query: { enabled: !isMock }
  });

  const { writeContract: repayLoan, isPending: isRepaying, data: repayTxHash } = useWriteContract();
  const { isLoading: isRepayConfirming, isSuccess: isRepaySuccess } = useWaitForTransactionReceipt({ hash: repayTxHash });

  const { writeContract: cancelLoan, isPending: isCanceling, data: cancelTxHash } = useWriteContract();
  const { isLoading: isCancelConfirming, isSuccess: isCancelSuccess } = useWaitForTransactionReceipt({ hash: cancelTxHash });

  useEffect(() => { if (isRepaySuccess && repayTxHash) toast.tx(`Loan #${id} repaid!`, repayTxHash); }, [isRepaySuccess, repayTxHash, id]);
  useEffect(() => { if (isCancelSuccess && cancelTxHash) toast.tx(`Loan offer #${id} cancelled.`, cancelTxHash); }, [isCancelSuccess, cancelTxHash, id]);

  const handleRepay = () => {
    repayLoan({
      address: CONTRACT_ADDRESSES.LOAN_ENGINE,
      abi: clawStreetLoanABI,
      functionName: 'repayLoan',
      args: [BigInt(id)],
    } as any);
  };

  const handleCancel = () => {
    cancelLoan({
      address: CONTRACT_ADDRESSES.LOAN_ENGINE,
      abi: clawStreetLoanABI,
      functionName: 'cancelLoanOffer',
      args: [BigInt(id)],
    } as any);
  };

  const displayData = isMock ? {
    borrower: address,
    lender: '0x0000000000000000000000000000000000000000',
    principal: '500',
    interest: '25',
    active: true,
    repaid: false,
    nftContract: '0xUniswapV3...'
  } : loanData ? {
    borrower: loanData[0],
    lender: loanData[1],
    principal: formatUnits(loanData[4], 6),
    interest: formatUnits(loanData[5], 6),
    active: loanData[9],
    repaid: loanData[10],
    nftContract: `${loanData[2].slice(0,6)}...${loanData[2].slice(-4)}`,
    nftContractFull: loanData[2],
  } : null;

  if (!displayData || (!isMock && displayData.borrower !== address) || (!displayData.active && !displayData.repaid)) return null;

  const totalOwed = Number(displayData.principal) + Number(displayData.interest);
  const isUnfunded = displayData.lender === '0x0000000000000000000000000000000000000000';

  return (
    <>
      <div className="bg-cyber-surface p-4 rounded-xl border border-cyber-border flex justify-between items-center hover:border-base-blue/30 transition-colors">
        <div>
          <div className="flex items-center gap-1">
            <Link to={`/loan/${id}`} className="font-semibold text-white text-sm hover:text-base-blue transition-colors">
              NFT: {displayData.nftContract}
            </Link>
            {'nftContractFull' in displayData && displayData.nftContractFull && (
              <CopyAddress addr={displayData.nftContractFull as string} />
            )}
          </div>
          <p className="text-xs text-gray-400 mt-1">Owe: {totalOwed} USDC</p>
          {displayData.repaid ? (
            <p className="text-[10px] text-green-400 mt-1 font-medium">Repaid</p>
          ) : isUnfunded ? (
            <p className="text-[10px] text-yellow-400 mt-1 font-medium">Awaiting Funder</p>
          ) : (
            <p className="text-[10px] text-red-400 mt-1 font-medium">Active Loan</p>
          )}
        </div>
        {!displayData.repaid && (
          isUnfunded ? (
            <button 
              onClick={() => setIsCancelModalOpen(true)}
              className="px-4 py-2 bg-red-500/20 text-red-400 rounded-lg text-xs font-medium hover:bg-red-500/30 transition-colors border border-red-500/50"
            >
              Cancel Offer
            </button>
          ) : (
            <button 
              onClick={() => setIsRepayModalOpen(true)}
              className="px-4 py-2 bg-base-blue text-white rounded-lg text-xs font-medium hover:bg-base-dark transition-colors"
            >
              Repay
            </button>
          )
        )}
      </div>

      <Modal isOpen={isRepayModalOpen} onClose={() => setIsRepayModalOpen(false)} title="Repay Loan">
        <div className="space-y-4">
          <p className="text-sm text-gray-400">
            You are about to repay Loan #{id}. Total amount due is <strong className="text-white">{totalOwed} USDC</strong>.
            Your NFT will be returned to your wallet.
          </p>
          
          {isRepaySuccess && (
            <div className="p-3 bg-green-500/20 border border-green-500/50 rounded-lg text-green-400 text-sm">
              Successfully repaid! Tx: {repayTxHash?.slice(0, 10)}...
            </div>
          )}

          {!address ? (
            <div className="w-full py-2.5 bg-cyber-border text-gray-400 rounded-lg font-medium text-sm text-center">
              Connect Wallet Required
            </div>
          ) : (
            <button 
              onClick={handleRepay}
              disabled={isRepaying || isRepayConfirming || isRepaySuccess}
              className="w-full py-2.5 bg-base-blue text-white rounded-lg font-medium text-sm hover:bg-base-dark transition-colors disabled:opacity-50"
            >
              {isRepaying || isRepayConfirming ? 'Confirming...' : isRepaySuccess ? 'Repaid' : 'Confirm Repayment'}
            </button>
          )}
        </div>
      </Modal>

      <Modal isOpen={isCancelModalOpen} onClose={() => setIsCancelModalOpen(false)} title="Cancel Loan Offer">
        <div className="space-y-4">
          <p className="text-sm text-gray-400">
            You are about to cancel your unaccepted loan offer. Your NFT will be returned to your wallet.
          </p>
          
          {isCancelSuccess && (
            <div className="p-3 bg-green-500/20 border border-green-500/50 rounded-lg text-green-400 text-sm">
              Successfully cancelled! Tx: {cancelTxHash?.slice(0, 10)}...
            </div>
          )}

          <button 
            onClick={handleCancel}
            disabled={isCanceling || isCancelConfirming || isCancelSuccess}
            className="w-full py-2.5 bg-red-500/20 text-red-400 border border-red-500/50 rounded-lg font-medium text-sm hover:bg-red-500/30 transition-colors disabled:opacity-50"
          >
            {isCanceling || isCancelConfirming ? 'Confirming...' : isCancelSuccess ? 'Cancelled' : 'Confirm Cancellation'}
          </button>
        </div>
      </Modal>
    </>
  );
}

function LentItem({ id, isMock }: { id: number, isMock: boolean, key?: React.Key }) {
  const { address } = useAccount();
  const [isClaimModalOpen, setIsClaimModalOpen] = useState(false);

  const { data: loanData } = useReadContract({
    address: CONTRACT_ADDRESSES.LOAN_ENGINE,
    abi: clawStreetLoanABI,
    functionName: 'loans',
    args: [BigInt(id)],
    query: { enabled: !isMock }
  });

  const { writeContract: claimDefault, isPending: isClaiming, data: claimTxHash } = useWriteContract();
  const { isLoading: isClaimConfirming, isSuccess: isClaimSuccess } = useWaitForTransactionReceipt({ hash: claimTxHash });

  useEffect(() => { if (isClaimSuccess && claimTxHash) toast.tx(`NFT from Loan #${id} claimed!`, claimTxHash); }, [isClaimSuccess, claimTxHash, id]);

  const handleClaim = () => {
    claimDefault({
      address: CONTRACT_ADDRESSES.LOAN_ENGINE,
      abi: clawStreetLoanABI,
      functionName: 'claimDefault',
      args: [BigInt(id)],
    } as any);
  };

  const isAgent = id % 2 === 0; // Mock logic

  const displayData = isMock ? {
    lender: address,
    principal: '2000',
    interest: '120',
    duration: 7,
    startTime: Math.floor(Date.now() / 1000) - 8 * 86400, // 8 days ago (defaulted)
    active: true,
    repaid: false,
    nftContract: 'Agent Skill Bundle #12',
    isAgent
  } : loanData ? {
    lender: loanData[1],
    principal: formatUnits(loanData[4], 6),
    interest: formatUnits(loanData[5], 6),
    duration: Number(loanData[6]),
    startTime: Number(loanData[7]),
    active: loanData[9],
    repaid: loanData[10],
    nftContract: `${loanData[2].slice(0,6)}...${loanData[2].slice(-4)}`,
    isAgent: true
  } : null;

  if (!displayData || (!isMock && displayData.lender !== address) || (!displayData.active && !displayData.repaid)) return null;

  const isDefaulted = !displayData.repaid && displayData.active && (Math.floor(Date.now() / 1000) > Number(displayData.startTime) + Number(displayData.duration) * 86400);

  return (
    <>
      <div className="bg-cyber-surface p-4 rounded-xl border border-cyber-border flex justify-between items-center hover:border-base-blue/30 transition-colors">
        <div>
          <div className="flex items-center space-x-2">
            <Link to={`/loan/${id}`} className="font-semibold text-white text-sm hover:text-base-blue transition-colors">
              {displayData.nftContract}
            </Link>
            {displayData.isAgent ? (
              <div className="flex items-center text-[10px] text-green-400 bg-green-500/10 border border-green-500/20 px-1.5 py-0.5 rounded" title="x402 Agent Reputation Score: 850">
                <ShieldCheck size={10} className="mr-1" />
                850
              </div>
            ) : (
              <div className="flex items-center text-[10px] text-gray-400 bg-gray-500/10 border border-gray-500/20 px-1.5 py-0.5 rounded" title="Standard Human User">
                <User size={10} className="mr-1" />
                User
              </div>
            )}
          </div>
          <p className="text-xs text-gray-400 mt-1">Principal: {displayData.principal} USDC</p>
          <p className="text-[10px] text-green-400 mt-1 font-medium">
            {displayData.repaid ? 'Completed' : isDefaulted ? <span className="text-red-400">Defaulted</span> : `Earning ${displayData.interest} USDC`}
          </p>
        </div>
        {isDefaulted ? (
          <button 
            onClick={() => setIsClaimModalOpen(true)}
            className="px-4 py-2 bg-red-500/20 text-red-400 rounded-lg text-xs font-medium hover:bg-red-500/30 transition-colors border border-red-500/50"
          >
            Claim NFT
          </button>
        ) : (
          <button className="px-4 py-2 bg-cyber-bg text-gray-500 rounded-lg text-xs font-medium cursor-not-allowed border border-cyber-border">
            {displayData.repaid ? 'Settled' : 'Locked'}
          </button>
        )}
      </div>

      <Modal isOpen={isClaimModalOpen} onClose={() => setIsClaimModalOpen(false)} title="Claim Defaulted NFT">
        <div className="space-y-4">
          <p className="text-sm text-gray-400">
            The borrower has failed to repay Loan #{id} in time. You can now claim the collateral NFT.
          </p>
          
          {isClaimSuccess && (
            <div className="p-3 bg-green-500/20 border border-green-500/50 rounded-lg text-green-400 text-sm">
              Successfully claimed NFT! Tx: {claimTxHash?.slice(0, 10)}...
            </div>
          )}

          <button 
            onClick={handleClaim}
            disabled={isClaiming || isClaimConfirming || isClaimSuccess}
            className="w-full py-2.5 bg-red-500/20 text-red-400 border border-red-500/50 rounded-lg font-medium text-sm hover:bg-red-500/30 transition-colors disabled:opacity-50"
          >
            {isClaiming || isClaimConfirming ? 'Confirming...' : isClaimSuccess ? 'Claimed' : 'Confirm Claim'}
          </button>
        </div>
      </Modal>
    </>
  );
}

// ─── Options: Written ─────────────────────────────────────────────────────────

function WrittenOptionItem({ id, isMock }: { key?: React.Key; id: number; isMock: boolean }) {
  const { address } = useAccount();

  const { data: optionData } = useReadContract({
    address: CONTRACT_ADDRESSES.CALL_VAULT,
    abi: clawStreetCallVaultABI,
    functionName: 'options',
    args: [BigInt(id)],
    query: { enabled: !isMock },
  });

  const { writeContract: cancelOption, isPending: isCanceling, data: cancelTxHash } = useWriteContract();
  const { isLoading: isCancelConfirming, isSuccess: isCancelSuccess } = useWaitForTransactionReceipt({ hash: cancelTxHash });

  const displayData = isMock ? {
    writer: address,
    buyer: '0x0000000000000000000000000000000000000000',
    underlying: '0xE93695aE429a2C156F216Bc615E9Dd8d1A9794dE',
    underlyingSymbol: 'WETH',
    amount: '1.0',
    strike: '2000',
    premium: '50',
    exercised: false,
    active: true,
  } : optionData ? {
    writer: optionData[0],
    buyer: optionData[1],
    underlying: optionData[2],
    underlyingSymbol: getTokenSymbol(optionData[2]),
    amount: formatUnits(optionData[3], 18),
    strike: formatUnits(optionData[4], 6),
    premium: formatUnits(optionData[5], 6),
    exercised: optionData[7],
    active: optionData[8],
  } : null;

  if (!displayData) return null;
  if (!isMock && displayData.writer !== address) return null;
  if (!displayData.active && !displayData.exercised) return null;

  const hasBuyer = displayData.buyer !== '0x0000000000000000000000000000000000000000';
  const amtNum = parseFloat(displayData.amount);
  const amtDisplay = amtNum < 0.001 ? amtNum.toFixed(6) : amtNum < 1 ? amtNum.toFixed(4) : amtNum.toFixed(2);

  return (
    <div className="bg-cyber-surface p-4 rounded-xl border border-cyber-border hover:border-claw-pink/30 transition-colors">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <Link to={`/option/${id}`} className="font-semibold text-white text-sm hover:text-claw-pink transition-colors flex items-center gap-1.5">
            <Target size={12} className="text-claw-pink shrink-0" />
            Call Option #{id}
          </Link>
          {/* Token symbol + amount */}
          <div className="flex items-center gap-2 mt-1.5">
            <span className="text-xs font-bold text-white bg-claw-pink/10 border border-claw-pink/25 px-2 py-0.5 rounded font-mono">
              {displayData.underlyingSymbol}
            </span>
            <span className="text-xs text-gray-300 font-mono">{amtDisplay}</span>
            <span className="text-gray-600 text-xs">@</span>
            <span className="text-xs text-gray-300">${displayData.strike} <span className="text-gray-500">strike</span></span>
          </div>
          <div className="flex items-center gap-2 mt-1.5">
            <span className="text-[10px] font-medium">
              {displayData.exercised
                ? <span className="text-gray-500 bg-gray-500/10 px-1.5 py-0.5 rounded">Exercised</span>
                : hasBuyer
                ? <span className="text-claw-pink bg-claw-pink/10 px-1.5 py-0.5 rounded">Sold</span>
                : <span className="text-yellow-400 bg-yellow-400/10 px-1.5 py-0.5 rounded">Open</span>
              }
            </span>
            <span className="text-[10px] text-gray-500">Premium: <span className="text-gray-300">${displayData.premium}</span></span>
          </div>
        </div>
        {!hasBuyer && !displayData.exercised && (
          <button
            onClick={() => cancelOption({
              address: CONTRACT_ADDRESSES.CALL_VAULT,
              abi: clawStreetCallVaultABI,
              functionName: 'cancelOption',
              args: [BigInt(id)],
            } as any)}
            disabled={isCanceling || isCancelConfirming || isCancelSuccess}
            className="shrink-0 px-3 py-1.5 text-xs bg-red-500/10 text-red-400 border border-red-500/20 rounded-lg hover:bg-red-500/20 transition-colors disabled:opacity-50"
          >
            {isCanceling || isCancelConfirming ? 'Canceling...' : isCancelSuccess ? 'Cancelled' : 'Cancel'}
          </button>
        )}
      </div>
    </div>
  );
}

// ─── Options: Bought ──────────────────────────────────────────────────────────

function BoughtOptionItem({ id, isMock }: { key?: React.Key; id: number; isMock: boolean }) {
  const { address } = useAccount();

  const { data: optionData } = useReadContract({
    address: CONTRACT_ADDRESSES.CALL_VAULT,
    abi: clawStreetCallVaultABI,
    functionName: 'options',
    args: [BigInt(id)],
    query: { enabled: !isMock },
  });

  const { writeContract: exerciseOption, isPending: isExercising, data: exerciseTxHash } = useWriteContract();
  const { isLoading: isExerciseConfirming, isSuccess: isExerciseSuccess } = useWaitForTransactionReceipt({ hash: exerciseTxHash });

  const displayData = isMock ? null : optionData ? {
    writer: optionData[0],
    buyer: optionData[1],
    underlying: optionData[2],
    underlyingSymbol: getTokenSymbol(optionData[2]),
    amount: formatUnits(optionData[3], 18),
    strike: formatUnits(optionData[4], 6),
    expiry: Number(optionData[5]),
    exercised: optionData[7],
    active: optionData[8],
  } : null;

  if (!displayData) return null;
  if (displayData.buyer !== address) return null;

  const isExpired = Math.floor(Date.now() / 1000) > displayData.expiry;
  const amtNum = parseFloat(displayData.amount);
  const amtDisplay = amtNum < 0.001 ? amtNum.toFixed(6) : amtNum < 1 ? amtNum.toFixed(4) : amtNum.toFixed(2);
  const expiryDate = new Date(displayData.expiry * 1000).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });

  return (
    <div className="bg-cyber-surface p-4 rounded-xl border border-cyber-border hover:border-claw-pink/30 transition-colors">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <Link to={`/option/${id}`} className="font-semibold text-white text-sm hover:text-claw-pink transition-colors flex items-center gap-1.5">
            <Target size={12} className="text-claw-pink shrink-0" />
            Call Option #{id}
          </Link>
          {/* Token symbol + amount */}
          <div className="flex items-center gap-2 mt-1.5">
            <span className="text-xs font-bold text-white bg-claw-pink/10 border border-claw-pink/25 px-2 py-0.5 rounded font-mono">
              {displayData.underlyingSymbol}
            </span>
            <span className="text-xs text-gray-300 font-mono">{amtDisplay}</span>
            <span className="text-gray-600 text-xs">@</span>
            <span className="text-xs text-gray-300">${displayData.strike} <span className="text-gray-500">strike</span></span>
          </div>
          <div className="flex items-center gap-2 mt-1.5">
            <span className="text-[10px] font-medium">
              {displayData.exercised
                ? <span className="text-green-400 bg-green-400/10 px-1.5 py-0.5 rounded">Exercised ✓</span>
                : isExpired
                ? <span className="text-gray-500 bg-gray-500/10 px-1.5 py-0.5 rounded">Expired</span>
                : <span className="text-claw-pink bg-claw-pink/10 px-1.5 py-0.5 rounded">Active</span>
              }
            </span>
            {!isExpired && !displayData.exercised && (
              <span className="text-[10px] text-gray-500">Exp <span className="text-gray-300">{expiryDate}</span></span>
            )}
          </div>
        </div>
        {!displayData.exercised && !isExpired && (
          <button
            onClick={() => exerciseOption({
              address: CONTRACT_ADDRESSES.CALL_VAULT,
              abi: clawStreetCallVaultABI,
              functionName: 'exercise',
              args: [BigInt(id)],
            } as any)}
            disabled={isExercising || isExerciseConfirming || isExerciseSuccess}
            className="shrink-0 px-3 py-1.5 text-xs bg-claw-pink/15 text-claw-pink border border-claw-pink/30 rounded-lg hover:bg-claw-pink/25 transition-colors disabled:opacity-50"
          >
            {isExercising || isExerciseConfirming ? 'Exercising...' : isExerciseSuccess ? 'Done ✓' : 'Exercise'}
          </button>
        )}
      </div>
    </div>
  );
}
