import React, { useState } from 'react';
import { Link } from 'react-router-dom';
import { useWriteContract, useReadContract, useAccount, useWaitForTransactionReceipt } from 'wagmi';
import { parseUnits, formatUnits } from 'viem';
import { CONTRACT_ADDRESSES, clawStreetCallVaultABI, erc20ABI } from '../config/contracts';
import { Modal } from '../components/Modal';
import { AlertCircle, ShieldCheck, User } from 'lucide-react';

export default function HedgeVault() {
  const { address } = useAccount();
  const [isWriteModalOpen, setIsWriteModalOpen] = useState(false);

  // Form State
  const [underlying, setUnderlying] = useState('');
  const [amount, setAmount] = useState('');
  const [strike, setStrike] = useState('');
  const [expiry, setExpiry] = useState('');
  const [premium, setPremium] = useState('');

  // Read Option Counter
  const { data: optionCounter, isError: isCounterError } = useReadContract({
    address: CONTRACT_ADDRESSES.CALL_VAULT,
    abi: clawStreetCallVaultABI,
    functionName: 'optionCounter',
  });

  const isMockData = isCounterError || optionCounter === undefined || Number(optionCounter) === 0;
  const totalOptions = isMockData ? 3 : Number(optionCounter);
  const optionIds = Array.from({ length: totalOptions }, (_, i) => i);

  // Write Hooks
  const { writeContract: approveToken, data: approveTxHash, isPending: isApproving } = useWriteContract();
  const { writeContract: writeCall, data: writeTxHash, isPending: isWriting } = useWriteContract();

  const { isLoading: isApproveConfirming, isSuccess: isApproveSuccess } = useWaitForTransactionReceipt({ hash: approveTxHash });
  const { isLoading: isWriteConfirming, isSuccess: isWriteSuccess } = useWaitForTransactionReceipt({ hash: writeTxHash });

  const handleWriteCall = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!underlying || !amount || !strike || !expiry || !premium) return;

    if (!isApproveSuccess) {
      approveToken({
        address: underlying as `0x${string}`,
        abi: erc20ABI,
        functionName: 'approve',
        args: [CONTRACT_ADDRESSES.CALL_VAULT, parseUnits(amount, 18)],
      } as any);
      return;
    }

    writeCall({
      address: CONTRACT_ADDRESSES.CALL_VAULT,
      abi: clawStreetCallVaultABI,
      functionName: 'writeCoveredCall',
      args: [
        underlying as `0x${string}`,
        parseUnits(amount, 18),
        parseUnits(strike, 6),
        BigInt(Math.floor(Date.now() / 1000) + Number(expiry) * 86400),
        parseUnits(premium, 6),
      ],
    } as any);
  };

  return (
    <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-12">
      {isMockData && (
        <div className="mb-6 p-4 bg-yellow-500/10 border border-yellow-500/20 rounded-lg flex items-center space-x-3 text-yellow-500 text-sm">
          <AlertCircle size={18} />
          <span>Smart contracts not detected on this network. Displaying placeholder options.</span>
        </div>
      )}

      <div className="flex flex-col sm:flex-row justify-between items-start sm:items-end mb-8 gap-4">
        <div>
          <h1 className="text-3xl font-bold mb-2 text-white">Hedge Vault</h1>
          <p className="text-gray-400 text-sm">Write covered calls to earn premium, or buy calls for upside protection.</p>
        </div>
        <button 
          onClick={() => setIsWriteModalOpen(true)}
          className="px-5 py-2.5 bg-base-blue text-white rounded-lg font-medium text-sm hover:bg-base-dark transition-colors shadow-lg shadow-base-blue/20"
        >
          Write Covered Call
        </button>
      </div>

      <div className="grid md:grid-cols-2 lg:grid-cols-3 gap-6">
        {optionIds.map((id) => (
          <OptionCard key={id} id={id} isMock={isMockData} />
        ))}
      </div>

      <Modal isOpen={isWriteModalOpen} onClose={() => setIsWriteModalOpen(false)} title="Write Covered Call">
        {isWriteSuccess && (
          <div className="mb-4 p-3 bg-green-500/20 border border-green-500/50 rounded-lg text-green-400 text-sm">
            Call written successfully! Tx: {writeTxHash?.slice(0, 10)}...
          </div>
        )}

        <form className="space-y-4" onSubmit={handleWriteCall}>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-xs font-medium text-gray-400 mb-1">Underlying Asset Address</label>
              <input 
                type="text" value={underlying} onChange={(e) => setUnderlying(e.target.value)}
                className="w-full bg-cyber-bg border border-cyber-border rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-base-blue" 
                placeholder="0x..." required
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-gray-400 mb-1">Amount</label>
              <input 
                type="number" value={amount} onChange={(e) => setAmount(e.target.value)}
                className="w-full bg-cyber-bg border border-cyber-border rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-base-blue" 
                placeholder="1.5" required
              />
            </div>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-xs font-medium text-gray-400 mb-1">Strike Price (USD)</label>
              <input 
                type="number" value={strike} onChange={(e) => setStrike(e.target.value)}
                className="w-full bg-cyber-bg border border-cyber-border rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-base-blue" 
                placeholder="3500" required
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-gray-400 mb-1">Expiry (Days)</label>
              <input 
                type="number" value={expiry} onChange={(e) => setExpiry(e.target.value)}
                className="w-full bg-cyber-bg border border-cyber-border rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-base-blue" 
                placeholder="7" required
              />
            </div>
          </div>
          <div>
            <label className="block text-xs font-medium text-gray-400 mb-1">Premium Asked (USDC)</label>
            <input 
              type="number" value={premium} onChange={(e) => setPremium(e.target.value)}
              className="w-full bg-cyber-bg border border-cyber-border rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-base-blue" 
              placeholder="150" required
            />
          </div>
          
          {!address ? (
            <div className="w-full py-2.5 bg-cyber-border text-gray-400 rounded-lg font-medium text-sm text-center">
              Connect Wallet Required
            </div>
          ) : (
            <button 
              type="submit" 
              disabled={isApproving || isApproveConfirming || isWriting || isWriteConfirming}
              className="w-full py-2.5 bg-base-blue text-white rounded-lg font-medium text-sm hover:bg-base-dark transition-colors disabled:opacity-50"
            >
              {!isApproveSuccess 
                ? (isApproving || isApproveConfirming ? 'Approving...' : '1. Approve Asset')
                : (isWriting || isWriteConfirming ? 'Writing Call...' : '2. Lock Asset & Write Call')}
            </button>
          )}
        </form>
      </Modal>
    </div>
  );
}

function OptionCard({ id, isMock }: { id: number, isMock: boolean, key?: React.Key }) {
  const { address } = useAccount();
  const [isBuyModalOpen, setIsBuyModalOpen] = useState(false);
  const [isExerciseModalOpen, setIsExerciseModalOpen] = useState(false);

  const { data: optionData } = useReadContract({
    address: CONTRACT_ADDRESSES.CALL_VAULT,
    abi: clawStreetCallVaultABI,
    functionName: 'options',
    args: [BigInt(id)],
    query: { enabled: !isMock }
  });

  const { writeContract: buyOption, isPending: isBuying, data: buyTxHash } = useWriteContract();
  const { isLoading: isBuyConfirming, isSuccess: isBuySuccess } = useWaitForTransactionReceipt({ hash: buyTxHash });

  const { writeContract: exerciseOption, isPending: isExercising, data: exerciseTxHash } = useWriteContract();
  const { isLoading: isExerciseConfirming, isSuccess: isExerciseSuccess } = useWaitForTransactionReceipt({ hash: exerciseTxHash });

  const handleBuy = () => {
    buyOption({
      address: CONTRACT_ADDRESSES.CALL_VAULT,
      abi: clawStreetCallVaultABI,
      functionName: 'buyOption',
      args: [BigInt(id)],
    } as any);
  };

  const handleExercise = () => {
    exerciseOption({
      address: CONTRACT_ADDRESSES.CALL_VAULT,
      abi: clawStreetCallVaultABI,
      functionName: 'exercise',
      args: [BigInt(id)],
    } as any);
  };

  const isAgent = id % 2 === 0; // Mock logic

  const displayData = isMock ? {
    writer: '0x1234...5678',
    underlying: 'WETH',
    amount: '1.5',
    strike: '3800',
    premium: '85',
    expiryDays: '5',
    isExpired: false,
    active: true,
    exercised: false,
    buyer: '0x0000000000000000000000000000000000000000',
    isAgent
  } : optionData ? {
    writer: `${optionData[0].slice(0,6)}...${optionData[0].slice(-4)}`,
    underlying: `${optionData[2].slice(0,6)}...`,
    amount: formatUnits(optionData[3], 18),
    strike: formatUnits(optionData[4], 6),
    premium: formatUnits(optionData[6], 6),
    expiryDays: Math.max(0, Math.floor((Number(optionData[5]) - Date.now()/1000) / 86400)).toString(),
    isExpired: Number(optionData[5]) < Date.now() / 1000,
    active: optionData[8],
    exercised: optionData[7],
    buyer: optionData[1],
    isAgent: true
  } : null;

  if (!displayData) return null;

  const isBuyer = address && displayData.buyer.toLowerCase() === address.toLowerCase();
  const isAvailable = displayData.buyer === '0x0000000000000000000000000000000000000000';

  // Hide if it's inactive and not exercised, or if it's expired and nobody bought it
  if (!displayData.active && !displayData.exercised) return null;
  if (displayData.isExpired && isAvailable) return null;
  if (!isAvailable && !isBuyer && !displayData.exercised) return null;

  return (
    <>
      <div className={`p-5 rounded-xl border flex flex-col justify-between h-full transition-colors ${displayData.exercised || displayData.isExpired ? 'bg-cyber-bg border-cyber-border/50 opacity-60' : 'bg-cyber-surface border-cyber-border hover:border-base-blue/50'}`}>
        <div>
          <div className="flex items-center space-x-2 mb-3">
            <span className={`text-[10px] font-bold px-2 py-0.5 rounded uppercase tracking-wider ${displayData.exercised ? 'bg-gray-500/20 text-gray-400' : 'bg-green-500/20 text-green-400'}`}>
              {displayData.exercised ? 'EXERCISED' : 'CALL'}
            </span>
            <h3 className={`font-bold text-base ${displayData.exercised ? 'text-gray-400' : 'text-white'}`}>{displayData.amount} {displayData.underlying} @ ${displayData.strike}</h3>
          </div>
          <div className="flex items-center space-x-2 mb-4">
            <p className="text-xs text-gray-500 font-mono">Writer: {displayData.writer}</p>
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
          <p className="text-xs text-gray-400 mb-4">
            {displayData.isExpired ? 'Expired' : `Expires in ${displayData.expiryDays} days`}
          </p>
        </div>
        
        <div className="flex items-end justify-between mt-4">
          <div>
            <p className="text-[10px] text-gray-500 uppercase tracking-wider mb-0.5">Premium</p>
            <p className={`font-bold text-lg ${displayData.exercised ? 'text-gray-500' : 'text-base-blue'}`}>{displayData.premium} USDC</p>
          </div>
          <div className="flex space-x-2">
            <Link 
              to={`/option/${id}`}
              className="px-4 py-2 bg-cyber-bg text-white border border-cyber-border rounded-lg font-semibold text-xs hover:bg-cyber-surface transition-colors"
            >
              Details
            </Link>
            {isAvailable ? (
              <button 
                onClick={() => setIsBuyModalOpen(true)}
                className="px-4 py-2 bg-white text-black rounded-lg font-semibold text-xs hover:bg-gray-200 transition-colors"
              >
                Buy
              </button>
            ) : displayData.exercised ? (
              <button className="px-4 py-2 bg-cyber-border text-gray-500 rounded-lg font-semibold text-xs cursor-not-allowed">
                Settled
              </button>
            ) : displayData.isExpired ? (
              <button className="px-4 py-2 bg-red-500/20 text-red-400 rounded-lg font-semibold text-xs cursor-not-allowed">
                Expired
              </button>
            ) : (
              <button 
                onClick={() => setIsExerciseModalOpen(true)}
                className="px-4 py-2 bg-green-500 text-white rounded-lg font-semibold text-xs hover:bg-green-600 transition-colors"
              >
                Exercise
              </button>
            )}
          </div>
        </div>
      </div>

      <Modal isOpen={isBuyModalOpen} onClose={() => setIsBuyModalOpen(false)} title="Buy Call Option">
        <div className="space-y-4">
          <p className="text-sm text-gray-400">
            You are about to buy a call option for <strong className="text-white">{displayData.amount} {displayData.underlying}</strong> at a strike price of <strong className="text-white">${displayData.strike}</strong>.
            This option expires in <strong className="text-white">{displayData.expiryDays} days</strong>.
          </p>
          <div className="p-4 bg-cyber-bg rounded-lg border border-cyber-border flex justify-between items-center">
            <span className="text-sm text-gray-400">Premium Cost</span>
            <span className="text-lg font-bold text-base-blue">{displayData.premium} USDC</span>
          </div>
          
          {isBuySuccess && (
            <div className="p-3 bg-green-500/20 border border-green-500/50 rounded-lg text-green-400 text-sm">
              Option purchased! Tx: {buyTxHash?.slice(0, 10)}...
            </div>
          )}

          {!address ? (
            <div className="w-full py-2.5 bg-cyber-border text-gray-400 rounded-lg font-medium text-sm text-center">
              Connect Wallet Required
            </div>
          ) : (
            <button 
              onClick={handleBuy}
              disabled={isBuying || isBuyConfirming || isBuySuccess}
              className="w-full py-2.5 bg-base-blue text-white rounded-lg font-medium text-sm hover:bg-base-dark transition-colors disabled:opacity-50"
            >
              {isBuying || isBuyConfirming ? 'Confirming...' : isBuySuccess ? 'Purchased' : 'Confirm Purchase'}
            </button>
          )}
        </div>
      </Modal>

      <Modal isOpen={isExerciseModalOpen} onClose={() => setIsExerciseModalOpen(false)} title="Exercise Call Option">
        <div className="space-y-4">
          <p className="text-sm text-gray-400">
            You are about to exercise your call option. You will pay <strong className="text-white">${displayData.strike} USDC</strong> to receive <strong className="text-base-blue">{displayData.amount} {displayData.underlying}</strong>.
          </p>
          
          {isExerciseSuccess && (
            <div className="p-3 bg-green-500/20 border border-green-500/50 rounded-lg text-green-400 text-sm">
              Option exercised successfully! Tx: {exerciseTxHash?.slice(0, 10)}...
            </div>
          )}

          <button 
            onClick={handleExercise}
            disabled={isExercising || isExerciseConfirming || isExerciseSuccess}
            className="w-full py-2.5 bg-green-500 text-white rounded-lg font-medium text-sm hover:bg-green-600 transition-colors disabled:opacity-50"
          >
            {isExercising || isExerciseConfirming ? 'Confirming...' : isExerciseSuccess ? 'Exercised' : 'Confirm Exercise'}
          </button>
        </div>
      </Modal>
    </>
  );
}
