import { useState, useEffect } from 'react';
import { useAccount, useWriteContract, useWaitForTransactionReceipt, useReadContract, useReadContracts } from 'wagmi';
import { parseUnits, formatUnits } from 'viem';
import { Modal } from '../components/Modal';
import { CONTRACT_ADDRESSES, clawTokenABI, clawStreetStakingABI } from '../config/contracts';

type Step = 'idle' | 'approving' | 'staking' | 'success';

export default function Staking() {
  const { address } = useAccount();
  const [isStakeModalOpen, setIsStakeModalOpen] = useState(false);
  const [isClaimModalOpen, setIsClaimModalOpen] = useState(false);
  const [amount, setAmount] = useState('');
  const [step, setStep] = useState<Step>('idle');

  // ── Contract reads ──────────────────────────────────────────────────────────
  const { data: reads, refetch: refetchReads } = useReadContracts({
    contracts: [
      {
        address: CONTRACT_ADDRESSES.CLAW_TOKEN,
        abi: clawTokenABI,
        functionName: 'balanceOf',
        args: [address ?? '0x0000000000000000000000000000000000000000'],
      },
      {
        address: CONTRACT_ADDRESSES.CLAW_TOKEN,
        abi: clawTokenABI,
        functionName: 'allowance',
        args: [
          address ?? '0x0000000000000000000000000000000000000000',
          CONTRACT_ADDRESSES.STAKING,
        ],
      },
      {
        address: CONTRACT_ADDRESSES.STAKING,
        abi: clawStreetStakingABI,
        functionName: 'positions',
        args: [address ?? '0x0000000000000000000000000000000000000000'],
      },
      {
        address: CONTRACT_ADDRESSES.STAKING,
        abi: clawStreetStakingABI,
        functionName: 'pendingRevenue',
        args: [address ?? '0x0000000000000000000000000000000000000000'],
      },
      {
        address: CONTRACT_ADDRESSES.STAKING,
        abi: clawStreetStakingABI,
        functionName: 'lockRemaining',
        args: [address ?? '0x0000000000000000000000000000000000000000'],
      },
      {
        address: CONTRACT_ADDRESSES.STAKING,
        abi: clawStreetStakingABI,
        functionName: 'totalStaked',
      },
    ],
    query: { enabled: !!address },
  });

  const clawBalance   = (reads?.[0]?.result as bigint | undefined) ?? 0n;
  const clawAllowance = (reads?.[1]?.result as bigint | undefined) ?? 0n;
  const position      = reads?.[2]?.result as [bigint, bigint, bigint, bigint, boolean] | undefined;
  const pendingRev    = (reads?.[3]?.result as bigint | undefined) ?? 0n;
  const lockLeft      = (reads?.[4]?.result as bigint | undefined) ?? 0n;
  const totalStaked   = (reads?.[5]?.result as bigint | undefined) ?? 0n;

  const stakedAmount = position?.[0] ?? 0n;
  const hasPass      = position?.[4] ?? false;

  const amountWei = amount ? parseUnits(amount, 18) : 0n;
  const needsApproval = clawAllowance < amountWei;

  // ── Approve ─────────────────────────────────────────────────────────────────
  const { writeContract: approve, isPending: isApproving, data: approveTxHash } = useWriteContract();
  const { isLoading: isApproveConfirming, isSuccess: isApproveSuccess } = useWaitForTransactionReceipt({ hash: approveTxHash });

  // ── Stake ───────────────────────────────────────────────────────────────────
  const { writeContract: stakeTokens, isPending: isStaking, data: stakeTxHash } = useWriteContract();
  const { isLoading: isStakeConfirming, isSuccess: isStakeSuccess } = useWaitForTransactionReceipt({ hash: stakeTxHash });

  // ── Claim revenue ───────────────────────────────────────────────────────────
  const { writeContract: claimRev, isPending: isClaiming, data: claimTxHash } = useWriteContract();
  const { isLoading: isClaimConfirming, isSuccess: isClaimSuccess } = useWaitForTransactionReceipt({ hash: claimTxHash });

  // ── Unstake ─────────────────────────────────────────────────────────────────
  const { writeContract: unstake, isPending: isUnstaking, data: unstakeTxHash } = useWriteContract();
  const { isSuccess: isUnstakeSuccess } = useWaitForTransactionReceipt({ hash: unstakeTxHash });

  // Advance step after approval confirms
  useEffect(() => {
    if (isApproveSuccess && step === 'approving') {
      setStep('staking');
      stakeTokens({
        address: CONTRACT_ADDRESSES.STAKING,
        abi: clawStreetStakingABI,
        functionName: 'stake',
        args: [amountWei],
      });
    }
  }, [isApproveSuccess]);

  useEffect(() => {
    if (isStakeSuccess) {
      setStep('success');
      refetchReads();
    }
  }, [isStakeSuccess]);

  useEffect(() => {
    if (isClaimSuccess || isUnstakeSuccess) {
      refetchReads();
    }
  }, [isClaimSuccess, isUnstakeSuccess]);

  const handleStakeConfirm = () => {
    if (!address || !amountWei) return;

    if (needsApproval) {
      setStep('approving');
      approve({
        address: CONTRACT_ADDRESSES.CLAW_TOKEN,
        abi: clawTokenABI,
        functionName: 'approve',
        args: [CONTRACT_ADDRESSES.STAKING, amountWei],
      });
    } else {
      setStep('staking');
      stakeTokens({
        address: CONTRACT_ADDRESSES.STAKING,
        abi: clawStreetStakingABI,
        functionName: 'stake',
        args: [amountWei],
      });
    }
  };

  const handleClaimRevenue = () => {
    claimRev({
      address: CONTRACT_ADDRESSES.STAKING,
      abi: clawStreetStakingABI,
      functionName: 'claimRevenue',
    });
  };

  const handleUnstake = () => {
    unstake({
      address: CONTRACT_ADDRESSES.STAKING,
      abi: clawStreetStakingABI,
      functionName: 'unstake',
    });
  };

  const isBusy = isApproving || isApproveConfirming || isStaking || isStakeConfirming;

  const lockDays = lockLeft > 0n ? Math.ceil(Number(lockLeft) / 86400) : 0;

  const stepLabel =
    step === 'approving' || isApproving || isApproveConfirming ? 'Approving…' :
    step === 'staking'   || isStaking  || isStakeConfirming   ? 'Staking…'   :
    step === 'success' ? 'Staked!' :
    needsApproval ? 'Approve & Stake' : 'Stake & Mint Pass';

  return (
    <div className="max-w-4xl mx-auto px-4 sm:px-6 lg:px-8 py-20 text-center">
      <div className="mb-12">
        <span className="text-6xl mb-6 block drop-shadow-[0_0_15px_rgba(0,82,255,0.5)]">🦞</span>
        <h1 className="text-4xl md:text-5xl font-extrabold mb-4 text-white tracking-tight">Stake $CLAW</h1>
        <p className="text-lg text-gray-400 max-w-2xl mx-auto">
          Lock your tokens to mint a ClawStreet Pass NFT. Earn protocol revenue, govern the street, and get priority OTC matching.
        </p>
      </div>

      {/* ── Active Position Card (if staked) ── */}
      {address && stakedAmount > 0n && (
        <div className="bg-cyber-surface p-6 rounded-2xl border border-lobster-orange/30 shadow-[0_0_30px_rgba(255,90,0,0.08)] max-w-md mx-auto mb-8 text-left">
          <div className="flex items-center justify-between mb-4">
            <h2 className="text-sm font-bold uppercase tracking-wider text-lobster-orange">Active Position</h2>
            {hasPass && (
              <span className="text-xs bg-lobster-orange/10 text-lobster-orange px-2 py-1 rounded-full font-semibold">
                ClawPass Minted
              </span>
            )}
          </div>
          <div className="space-y-2 text-sm mb-5">
            <div className="flex justify-between">
              <span className="text-gray-400">Staked</span>
              <span className="text-white font-mono font-bold">{formatUnits(stakedAmount, 18)} CLAW</span>
            </div>
            <div className="flex justify-between">
              <span className="text-gray-400">Pending Revenue</span>
              <span className="text-green-400 font-mono font-bold">{formatUnits(pendingRev, 6)} USDC</span>
            </div>
            <div className="flex justify-between">
              <span className="text-gray-400">Lock Remaining</span>
              <span className={lockDays > 0 ? 'text-yellow-400 font-medium' : 'text-green-400 font-medium'}>
                {lockDays > 0 ? `${lockDays}d remaining` : 'Unlocked'}
              </span>
            </div>
          </div>
          <div className="flex gap-3">
            {pendingRev > 0n && (
              <button
                onClick={() => setIsClaimModalOpen(true)}
                disabled={isClaiming || isClaimConfirming}
                className="flex-1 py-2 bg-green-500/10 text-green-400 border border-green-500/20 rounded-lg text-sm font-semibold hover:bg-green-500/20 transition-colors disabled:opacity-50"
              >
                {isClaiming || isClaimConfirming ? 'Claiming…' : 'Claim Revenue'}
              </button>
            )}
            {lockDays === 0 && (
              <button
                onClick={handleUnstake}
                disabled={isUnstaking}
                className="flex-1 py-2 bg-red-500/10 text-red-400 border border-red-500/20 rounded-lg text-sm font-semibold hover:bg-red-500/20 transition-colors disabled:opacity-50"
              >
                {isUnstaking ? 'Unstaking…' : 'Unstake'}
              </button>
            )}
          </div>
        </div>
      )}

      {/* ── Stake Input Card ── */}
      <div className="bg-cyber-surface p-8 rounded-2xl border border-base-blue/30 shadow-[0_0_40px_rgba(0,82,255,0.1)] max-w-md mx-auto relative overflow-hidden">
        <div className="absolute top-0 left-0 w-full h-1 bg-gradient-to-r from-transparent via-base-blue to-transparent opacity-50" />

        <div className="flex justify-between text-xs text-gray-400 mb-2 uppercase tracking-wider font-semibold">
          <span>Available Balance</span>
          <span className="font-mono text-white">
            {address ? `${Number(formatUnits(clawBalance, 18)).toLocaleString()} CLAW` : '—'}
          </span>
        </div>

        <div className="relative mb-8">
          <input
            type="number"
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
            className="w-full bg-cyber-bg border border-cyber-border rounded-xl px-4 py-5 text-3xl text-white focus:outline-none focus:border-base-blue text-center font-mono shadow-inner"
            placeholder="0"
          />
          <button
            onClick={() => setAmount(formatUnits(clawBalance, 18))}
            className="absolute right-4 top-1/2 -translate-y-1/2 text-[10px] font-bold bg-white/10 px-2.5 py-1.5 rounded text-white hover:bg-white/20 transition-colors uppercase tracking-wider"
          >
            MAX
          </button>
        </div>

        <div className="bg-cyber-bg rounded-xl p-5 mb-8 text-left space-y-3 border border-cyber-border">
          <div className="flex justify-between text-sm">
            <span className="text-gray-400">Est. APY</span>
            <span className="text-green-400 font-bold">~24.5%</span>
          </div>
          <div className="flex justify-between text-sm">
            <span className="text-gray-400">Lock Period</span>
            <span className="text-white font-medium">30 Days</span>
          </div>
          <div className="flex justify-between text-sm">
            <span className="text-gray-400">Total Protocol Staked</span>
            <span className="text-white font-mono">{Number(formatUnits(totalStaked, 18)).toLocaleString()} CLAW</span>
          </div>
          <div className="flex justify-between text-sm pt-3 border-t border-cyber-border">
            <span className="text-gray-400">You Receive</span>
            <span className="text-base-blue font-bold">1x ClawStreet Pass</span>
          </div>
        </div>

        {!address ? (
          <div className="w-full py-3.5 bg-cyber-border text-gray-400 rounded-xl font-semibold text-sm text-center">
            Connect Wallet to Stake
          </div>
        ) : (
          <button
            onClick={() => { setStep('idle'); setIsStakeModalOpen(true); }}
            disabled={!amount || Number(amount) <= 0 || isBusy}
            className="w-full py-3.5 bg-base-blue text-white rounded-xl font-bold text-sm hover:bg-base-dark transition-colors shadow-lg shadow-base-blue/20 disabled:opacity-50"
          >
            Stake & Mint Pass
          </button>
        )}
      </div>

      {/* ── Stake Confirm Modal ── */}
      <Modal isOpen={isStakeModalOpen} onClose={() => { setIsStakeModalOpen(false); setStep('idle'); }} title="Confirm Staking">
        <div className="space-y-4">
          <p className="text-sm text-gray-400">
            You are about to stake <strong className="text-white">{amount} $CLAW</strong> for 30 days.
            In return, you will{hasPass ? ' top up your position and' : ''} mint a ClawStreet Pass NFT.
          </p>
          {needsApproval && step === 'idle' && (
            <p className="text-xs text-yellow-400 bg-yellow-400/5 border border-yellow-400/20 rounded-lg p-3">
              Step 1 of 2: You'll first approve $CLAW spend, then confirm the stake.
            </p>
          )}
          {step === 'success' ? (
            <div className="text-center py-2">
              <div className="text-green-400 font-bold text-lg mb-1">Staked!</div>
              <p className="text-xs text-gray-400">Your ClawPass NFT has been minted.</p>
              <button
                onClick={() => { setIsStakeModalOpen(false); setStep('idle'); setAmount(''); }}
                className="mt-4 w-full py-2.5 bg-base-blue text-white rounded-lg font-medium text-sm"
              >
                Done
              </button>
            </div>
          ) : (
            <button
              onClick={handleStakeConfirm}
              disabled={isBusy}
              className="w-full py-2.5 bg-base-blue text-white rounded-lg font-medium text-sm hover:bg-base-dark transition-colors disabled:opacity-50"
            >
              {stepLabel}
            </button>
          )}
        </div>
      </Modal>

      {/* ── Claim Revenue Modal ── */}
      <Modal isOpen={isClaimModalOpen} onClose={() => setIsClaimModalOpen(false)} title="Claim Revenue">
        <div className="space-y-4">
          <p className="text-sm text-gray-400">
            Claim <strong className="text-white">{formatUnits(pendingRev, 6)} USDC</strong> in accrued protocol revenue.
          </p>
          <button
            onClick={() => { handleClaimRevenue(); setIsClaimModalOpen(false); }}
            disabled={isClaiming || isClaimConfirming}
            className="w-full py-2.5 bg-green-600 text-white rounded-lg font-medium text-sm hover:bg-green-700 transition-colors disabled:opacity-50"
          >
            {isClaiming || isClaimConfirming ? 'Claiming…' : 'Confirm Claim'}
          </button>
        </div>
      </Modal>
    </div>
  );
}
