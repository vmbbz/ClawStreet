import React, { useState } from 'react';
import { Link } from 'react-router-dom';
import { motion } from 'motion/react';
import { useWriteContract, useReadContract, useAccount, useWaitForTransactionReceipt } from 'wagmi';
import { parseUnits, formatUnits } from 'viem';
import { CONTRACT_ADDRESSES, clawStreetLoanABI, erc721ABI, PYTH_FEEDS, getAgentInfo } from '../config/contracts';
import { fetchPythVAA } from '../lib/pyth';
import { Modal } from '../components/Modal';
import { AlertCircle, Package, ShieldCheck, User, Loader2 } from 'lucide-react';

export default function Marketplace() {
  const { address } = useAccount();
  const [isCreateModalOpen, setIsCreateModalOpen] = useState(false);
  
  // Form State
  const [nftContract, setNftContract] = useState('');
  const [nftId, setNftId] = useState('');
  const [principal, setPrincipal] = useState('');
  const [duration, setDuration] = useState('');
  const [interest, setInterest] = useState('');

  // Read Loan Counter
  const { data: loanCounter, isError: isCounterError } = useReadContract({
    address: CONTRACT_ADDRESSES.LOAN_ENGINE,
    abi: clawStreetLoanABI,
    functionName: 'loanCounter',
  });

  // 3-state data model: loading → empty | error (demo) | real data
  const isLoading = loanCounter === undefined && !isCounterError;
  const isMockData = isCounterError;  // demo mode only when RPC is actually down
  const isEmpty = !isLoading && !isMockData && Number(loanCounter ?? 0) === 0;
  const totalLoans = isMockData ? 6 : Number(loanCounter ?? 0);
  const loanIds = Array.from({ length: totalLoans }, (_, i) => i);

  // Write Hooks for Create
  const { writeContract: approveNft, data: approveTxHash, isPending: isApproving } = useWriteContract();
  const { writeContract: createLoan, data: createTxHash, isPending: isCreating } = useWriteContract();

  const { isLoading: isApproveConfirming, isSuccess: isApproveSuccess } = useWaitForTransactionReceipt({ hash: approveTxHash });
  const { isLoading: isCreateConfirming, isSuccess: isCreateSuccess } = useWaitForTransactionReceipt({ hash: createTxHash });

  const handleCreateOffer = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!nftContract || !nftId || !principal || !duration || !interest) return;

    if (!isApproveSuccess) {
      approveNft({
        address: nftContract as `0x${string}`,
        abi: erc721ABI,
        functionName: 'approve',
        args: [CONTRACT_ADDRESSES.LOAN_ENGINE, BigInt(nftId)],
      } as any);
      return;
    }

    createLoan({
      address: CONTRACT_ADDRESSES.LOAN_ENGINE,
      abi: clawStreetLoanABI,
      functionName: 'createLoanOffer',
      args: [
        nftContract as `0x${string}`,
        BigInt(nftId),
        parseUnits(principal, 6),
        parseUnits(interest, 6),
        BigInt(Number(duration) * 86400),
      ],
    } as any);
  };

  return (
    <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-12">
      {isMockData && (
        <div className="mb-6 p-4 bg-orange-500/10 border border-orange-500/20 rounded-lg flex items-center space-x-3 text-orange-400 text-sm">
          <AlertCircle size={18} />
          <span>RPC unavailable — showing demo data. Set <code className="font-mono bg-orange-500/10 px-1 rounded">VITE_BASE_SEPOLIA_RPC</code> in <code className="font-mono bg-orange-500/10 px-1 rounded">.env</code> for reliable reads.</span>
        </div>
      )}

      <div className="flex flex-col sm:flex-row justify-between items-start sm:items-end mb-8 gap-4">
        <div>
          <h1 className="text-3xl font-bold mb-2 text-white">OTC Liquidity Market</h1>
          <p className="text-gray-400 text-sm">Peer-to-peer NFT lending powered by Pyth oracles.{!isMockData && !isLoading && <span className="ml-2 text-green-400">● Live</span>}</p>
        </div>
        <button
          onClick={() => setIsCreateModalOpen(true)}
          className="px-5 py-2.5 bg-base-blue text-white rounded-lg font-medium text-sm hover:bg-base-dark transition-colors shadow-lg shadow-base-blue/20"
        >
          Create Offer
        </button>
      </div>

      {isLoading && (
        <div className="flex items-center justify-center py-20 text-gray-500">
          <Loader2 className="animate-spin mr-3" size={20} />
          <span className="text-sm">Reading from Base Sepolia...</span>
        </div>
      )}

      {isEmpty && (
        <div className="text-center py-20 border border-dashed border-cyber-border rounded-xl">
          <Package className="mx-auto mb-4 text-gray-600" size={40} />
          <h3 className="text-lg font-semibold text-white mb-2">No listings yet</h3>
          <p className="text-gray-500 text-sm mb-6">Be the first to create a loan offer, or run <code className="font-mono bg-cyber-surface px-1.5 py-0.5 rounded text-gray-300">npm run seed</code> to populate with agent data.</p>
          <button
            onClick={() => setIsCreateModalOpen(true)}
            className="px-5 py-2.5 bg-base-blue text-white rounded-lg font-medium text-sm hover:bg-base-dark transition-colors"
          >
            Create First Offer
          </button>
        </div>
      )}

      {!isLoading && !isEmpty && (
        <div className="grid md:grid-cols-2 lg:grid-cols-3 gap-6">
          {loanIds.map((id) => (
            <LoanCard key={id} id={id} isMock={isMockData} />
          ))}
        </div>
      )}

      <Modal isOpen={isCreateModalOpen} onClose={() => setIsCreateModalOpen(false)} title="List NFT as Collateral">
        {isCreateSuccess && (
          <div className="mb-4 p-3 bg-green-500/20 border border-green-500/50 rounded-lg text-green-400 text-sm">
            Offer created! Tx: {createTxHash?.slice(0, 10)}...
          </div>
        )}
        <form className="space-y-4" onSubmit={handleCreateOffer}>
          <div>
            <label className="block text-xs font-medium text-gray-400 mb-1">NFT Contract</label>
            <input 
              type="text" value={nftContract} onChange={(e) => setNftContract(e.target.value)}
              className="w-full bg-cyber-bg border border-cyber-border rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-base-blue" 
              placeholder="0x..." required
            />
          </div>
          <div>
            <label className="block text-xs font-medium text-gray-400 mb-1">Token ID</label>
            <input 
              type="text" value={nftId} onChange={(e) => setNftId(e.target.value)}
              className="w-full bg-cyber-bg border border-cyber-border rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-base-blue" 
              placeholder="42" required
            />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-xs font-medium text-gray-400 mb-1">Principal (USDC)</label>
              <input 
                type="number" value={principal} onChange={(e) => setPrincipal(e.target.value)}
                className="w-full bg-cyber-bg border border-cyber-border rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-base-blue" 
                placeholder="1000" required
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-gray-400 mb-1">Duration (Days)</label>
              <input 
                type="number" value={duration} onChange={(e) => setDuration(e.target.value)}
                className="w-full bg-cyber-bg border border-cyber-border rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-base-blue" 
                placeholder="30" required
              />
            </div>
          </div>
          <div>
            <label className="block text-xs font-medium text-gray-400 mb-1">Total Interest (USDC)</label>
            <input 
              type="number" value={interest} onChange={(e) => setInterest(e.target.value)}
              className="w-full bg-cyber-bg border border-cyber-border rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-base-blue" 
              placeholder="50" required
            />
          </div>
          
          {!address ? (
            <div className="w-full py-2.5 bg-cyber-border text-gray-400 rounded-lg font-medium text-sm text-center">
              Connect Wallet Required
            </div>
          ) : (
            <button 
              type="submit" 
              disabled={isApproving || isApproveConfirming || isCreating || isCreateConfirming}
              className="w-full py-2.5 bg-base-blue text-white rounded-lg font-medium text-sm hover:bg-base-dark transition-colors disabled:opacity-50"
            >
              {!isApproveSuccess 
                ? (isApproving || isApproveConfirming ? 'Approving...' : '1. Approve NFT')
                : (isCreating || isCreateConfirming ? 'Creating...' : '2. Create Offer')}
            </button>
          )}
        </form>
      </Modal>
    </div>
  );
}

function LoanCard({ id, isMock }: { id: number, isMock: boolean, key?: React.Key }) {
  const { address } = useAccount();
  const [isFundModalOpen, setIsFundModalOpen] = useState(false);
  
  const { data: loanData } = useReadContract({
    address: CONTRACT_ADDRESSES.LOAN_ENGINE,
    abi: clawStreetLoanABI,
    functionName: 'loans',
    args: [BigInt(id)],
    query: { enabled: !isMock }
  });

  const { writeContract: fundLoan, isPending: isFunding, data: fundTxHash } = useWriteContract();
  const { isLoading: isFundConfirming, isSuccess: isFundSuccess } = useWaitForTransactionReceipt({ hash: fundTxHash });

  const handleFund = async () => {
    // Fetch fresh Pyth VAA before submitting (required by acceptLoan)
    const vaa = await fetchPythVAA([PYTH_FEEDS.ETH_USD]).catch(() => [] as `0x${string}`[]);
    fundLoan({
      address: CONTRACT_ADDRESSES.LOAN_ENGINE,
      abi: clawStreetLoanABI,
      functionName: 'acceptLoan',
      args: [BigInt(id), vaa],
      value: vaa.length > 0 ? 1n : 0n,  // Pyth update fee (1 wei)
    } as any);
  };

  const mockIsAgent = id % 2 === 0;
  const realIsAgent = loanData ? !!getAgentInfo(loanData[0]) : false;

  const displayData = isMock ? {
    principal: '1500',
    duration: '30',
    interest: '75',
    health: 70 + (id * 7 % 30),  // deterministic, not random
    active: true,
    nftContract: '0x8f3...2a1',
    borrower: '0x0000...demo',
    isAgent: mockIsAgent,
  } : loanData ? {
    principal: formatUnits(loanData[4], 6),
    duration: (Number(loanData[6]) / 86400).toString(),
    interest: formatUnits(loanData[5], 6),
    health: Number(loanData[8]),
    active: loanData[9],
    nftContract: `${loanData[2].slice(0,6)}...${loanData[2].slice(-4)}`,
    borrower: loanData[0],
    isAgent: realIsAgent,
  } : null;

  if (!displayData || !displayData.active) return null;

  return (
    <motion.div 
      initial={{ opacity: 0, scale: 0.95 }}
      animate={{ opacity: 1, scale: 1 }}
      className="bg-cyber-surface rounded-xl border border-cyber-border overflow-hidden hover:border-base-blue/30 transition-colors flex flex-col"
    >
      <div className="h-24 bg-cyber-bg relative flex items-center justify-center border-b border-cyber-border">
        <Package className="text-gray-500 w-8 h-8" />
        <div className="absolute top-3 right-3 bg-black/50 backdrop-blur-sm px-2 py-0.5 rounded text-[10px] font-mono text-base-blue border border-base-blue/30">
          Health: {displayData.health}
        </div>
      </div>
      <div className="p-5 flex-grow flex flex-col">
        <div className="mb-4">
          <div className="flex justify-between items-start">
            <h3 className="font-bold text-white text-base">{displayData.isAgent ? 'Agent Bundle' : 'User Collateral'} #{id * 142 || id}</h3>
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
          <p className="text-xs text-gray-500 font-mono">{displayData.nftContract}</p>
        </div>
        
        <div className="grid grid-cols-2 gap-3 mb-6 flex-grow">
          <div className="bg-cyber-bg p-2.5 rounded-lg border border-cyber-border">
            <p className="text-[10px] text-gray-500 mb-0.5 uppercase tracking-wider">Principal</p>
            <p className="font-semibold text-white text-sm">{displayData.principal} USDC</p>
          </div>
          <div className="bg-cyber-bg p-2.5 rounded-lg border border-cyber-border">
            <p className="text-[10px] text-gray-500 mb-0.5 uppercase tracking-wider">Duration</p>
            <p className="font-semibold text-white text-sm">{displayData.duration} Days</p>
          </div>
          <div className="bg-cyber-bg p-2.5 rounded-lg border border-cyber-border">
            <p className="text-[10px] text-gray-500 mb-0.5 uppercase tracking-wider">Interest</p>
            <p className="font-semibold text-green-400 text-sm">+{displayData.interest} USDC</p>
          </div>
          <div className="bg-cyber-bg p-2.5 rounded-lg border border-cyber-border">
            <p className="text-[10px] text-gray-500 mb-0.5 uppercase tracking-wider">APR</p>
            <p className="font-semibold text-white text-sm">
              {Math.round((Number(displayData.interest) / Number(displayData.principal)) * (365 / Number(displayData.duration)) * 100)}%
            </p>
          </div>
        </div>
        
        <div className="flex space-x-3">
          <Link 
            to={`/loan/${id}`}
            className="w-1/2 py-2.5 bg-cyber-bg text-white border border-cyber-border rounded-lg font-semibold text-sm hover:bg-cyber-surface transition-colors text-center"
          >
            View Details
          </Link>
          <button 
            onClick={() => setIsFundModalOpen(true)}
            className="w-1/2 py-2.5 bg-white text-black rounded-lg font-semibold text-sm hover:bg-gray-200 transition-colors"
          >
            Fund Loan
          </button>
        </div>

        <Modal isOpen={isFundModalOpen} onClose={() => setIsFundModalOpen(false)} title="Confirm Funding">
          <div className="space-y-4">
            <p className="text-sm text-gray-400">
              You are about to fund Loan #{id} with <strong className="text-white">{displayData.principal} USDC</strong>. 
              You will receive the principal + <strong className="text-green-400">{displayData.interest} USDC</strong> interest after {displayData.duration} days.
            </p>
            
            {isFundSuccess && (
              <div className="p-3 bg-green-500/20 border border-green-500/50 rounded-lg text-green-400 text-sm">
                Successfully funded! Tx: {fundTxHash?.slice(0, 10)}...
              </div>
            )}

            {!address ? (
              <div className="w-full py-2.5 bg-cyber-border text-gray-400 rounded-lg font-medium text-sm text-center">
                Connect Wallet Required
              </div>
            ) : (
              <button 
                onClick={handleFund}
                disabled={isFunding || isFundConfirming || isFundSuccess}
                className="w-full py-2.5 bg-base-blue text-white rounded-lg font-medium text-sm hover:bg-base-dark transition-colors disabled:opacity-50"
              >
                {isFunding || isFundConfirming ? 'Confirming...' : isFundSuccess ? 'Funded' : 'Confirm & Fund'}
              </button>
            )}
          </div>
        </Modal>
      </div>
    </motion.div>
  );
}
