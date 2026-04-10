import React, { useState } from 'react';
import { Link } from 'react-router-dom';
import { useReadContract, useWriteContract, useAccount, useWaitForTransactionReceipt } from 'wagmi';
import { formatUnits } from 'viem';
import { CONTRACT_ADDRESSES, clawStreetLoanABI } from '../config/contracts';
import { Modal } from '../components/Modal';
import { AlertCircle, ShieldCheck, User } from 'lucide-react';

export default function Portfolio() {
  const { address } = useAccount();

  const { data: loanCounter, isError: isCounterError } = useReadContract({
    address: CONTRACT_ADDRESSES.LOAN_ENGINE,
    abi: clawStreetLoanABI,
    functionName: 'loanCounter',
  });

  const isMockData = isCounterError || loanCounter === undefined || Number(loanCounter) === 0;
  const totalLoans = isMockData ? 2 : Number(loanCounter);
  const loanIds = Array.from({ length: totalLoans }, (_, i) => i);

  return (
    <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-12">
      {isMockData && (
        <div className="mb-6 p-4 bg-yellow-500/10 border border-yellow-500/20 rounded-lg flex items-center space-x-3 text-yellow-500 text-sm">
          <AlertCircle size={18} />
          <span>Smart contracts not detected on this network. Displaying placeholder portfolio.</span>
        </div>
      )}

      <h1 className="text-3xl font-bold mb-8 text-white">My Loans & Positions</h1>
      
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
    nftContract: `${loanData[2].slice(0,6)}...${loanData[2].slice(-4)}`
  } : null;

  if (!displayData || (!isMock && displayData.borrower !== address) || (!displayData.active && !displayData.repaid)) return null;

  const totalOwed = Number(displayData.principal) + Number(displayData.interest);
  const isUnfunded = displayData.lender === '0x0000000000000000000000000000000000000000';

  return (
    <>
      <div className="bg-cyber-surface p-4 rounded-xl border border-cyber-border flex justify-between items-center hover:border-base-blue/30 transition-colors">
        <div>
          <Link to={`/loan/${id}`} className="font-semibold text-white text-sm hover:text-base-blue transition-colors">
            NFT: {displayData.nftContract}
          </Link>
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

  const isDefaulted = !displayData.repaid && displayData.active && (Math.floor(Date.now() / 1000) > displayData.startTime + displayData.duration * 86400);

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
