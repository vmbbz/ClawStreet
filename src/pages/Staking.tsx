// @ts-nocheck
import { useState, useEffect, useRef } from 'react';
import { useAccount, useWriteContract, useWaitForTransactionReceipt, useReadContracts } from 'wagmi';
import { parseUnits, formatUnits } from 'viem';
import { Modal } from '../components/Modal';
import { CONTRACT_ADDRESSES, clawTokenABI, clawStreetStakingABI } from '../config/contracts';
import { toast } from '../components/Toast';
import {
  TrendingUp, Lock, Zap, Shield, BarChart3, Users, ChevronRight, ExternalLink,
  Loader2, CheckCircle2, XCircle, Clock, Award
} from 'lucide-react';

const BASESCAN_TX   = 'https://sepolia.basescan.org/tx/';
const BASESCAN_ADDR = 'https://sepolia.basescan.org/address/';

type Step = 'idle' | 'approving' | 'staking' | 'success' | 'error';

// ─── Pass Card visual ─────────────────────────────────────────────────────────

function ClawPassCard({ passId, address, stakedAmount }: { passId?: bigint; address?: string; stakedAmount: bigint }) {
  const id = passId ? Number(passId) : null;
  return (
    <div className="relative w-full aspect-[3/4] max-w-[220px] mx-auto select-none">
      {/* Card body */}
      <div className="absolute inset-0 rounded-2xl bg-gradient-to-br from-[#0a0e1a] via-[#0d1530] to-[#060a15] border border-base-blue/40 shadow-[0_0_40px_rgba(0,82,255,0.25)] overflow-hidden">
        {/* Shimmer top bar */}
        <div className="absolute top-0 left-0 right-0 h-1 bg-gradient-to-r from-transparent via-base-blue to-transparent opacity-80" />
        {/* Grid texture */}
        <div className="absolute inset-0 opacity-[0.04]" style={{
          backgroundImage: 'linear-gradient(rgba(0,82,255,1) 1px, transparent 1px), linear-gradient(90deg, rgba(0,82,255,1) 1px, transparent 1px)',
          backgroundSize: '24px 24px'
        }} />
        {/* Lobster glow */}
        <div className="absolute top-8 left-1/2 -translate-x-1/2 w-20 h-20 rounded-full bg-base-blue/15 blur-2xl" />

        <div className="relative p-5 flex flex-col h-full">
          {/* Header */}
          <div className="flex items-center justify-between mb-1">
            <span className="text-[9px] font-bold uppercase tracking-widest text-base-blue/70">ClawStreet</span>
            <span className="text-[9px] font-mono text-gray-600">BASE SEPOLIA</span>
          </div>

          {/* Claw icon */}
          <div className="flex-1 flex items-center justify-center">
            <div className="text-5xl drop-shadow-[0_0_20px_rgba(0,82,255,0.6)]">🦞</div>
          </div>

          {/* Pass name */}
          <div className="text-center mb-3">
            <p className="text-xs font-bold text-white tracking-wide">ClawPass NFT</p>
            {id !== null ? (
              <p className="text-[10px] text-base-blue font-mono">#{id.toString().padStart(4, '0')}</p>
            ) : (
              <p className="text-[10px] text-gray-600 italic">Not minted yet</p>
            )}
          </div>

          {/* Bottom info */}
          <div className="border-t border-white/5 pt-3 space-y-1">
            <div className="flex justify-between text-[9px]">
              <span className="text-gray-600 uppercase tracking-wider">Staked</span>
              <span className="text-white font-mono font-bold">
                {stakedAmount > 0n ? `${Number(formatUnits(stakedAmount, 18)).toLocaleString()}` : '—'} STREET
              </span>
            </div>
            {address && (
              <div className="flex justify-between text-[9px]">
                <span className="text-gray-600 uppercase tracking-wider">Holder</span>
                <span className="text-gray-400 font-mono">{address.slice(0, 6)}…{address.slice(-4)}</span>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

// ─── Stat tile ────────────────────────────────────────────────────────────────

function StatTile({ label, value, sub, color = 'text-white', icon }: {
  label: string; value: string; sub?: string; color?: string; icon: React.ReactNode;
}) {
  return (
    <div className="bg-cyber-surface border border-cyber-border rounded-xl p-4 flex items-start gap-3">
      <div className="p-2 rounded-lg bg-white/4 text-gray-400 shrink-0">{icon}</div>
      <div>
        <p className="text-[10px] text-gray-500 uppercase tracking-widest mb-0.5">{label}</p>
        <p className={`text-xl font-bold ${color}`}>{value}</p>
        {sub && <p className="text-[10px] text-gray-600 mt-0.5">{sub}</p>}
      </div>
    </div>
  );
}

// ─── Benefit pill ─────────────────────────────────────────────────────────────

function Benefit({ icon, title, desc }: { icon: React.ReactNode; title: string; desc: string }) {
  return (
    <div className="flex items-start gap-3 p-4 bg-cyber-surface border border-cyber-border rounded-xl hover:border-base-blue/30 transition-colors">
      <div className="p-2 rounded-lg bg-base-blue/10 text-base-blue shrink-0">{icon}</div>
      <div>
        <p className="text-sm font-semibold text-white">{title}</p>
        <p className="text-xs text-gray-500 mt-0.5 leading-relaxed">{desc}</p>
      </div>
    </div>
  );
}

// ─── Main Page ────────────────────────────────────────────────────────────────

export default function Staking() {
  const { address } = useAccount();
  const [isStakeModalOpen, setIsStakeModalOpen] = useState(false);
  const [isClaimModalOpen, setIsClaimModalOpen] = useState(false);
  const [amount, setAmount]   = useState('');
  const [step, setStep]       = useState<Step>('idle');
  const [txError, setTxError] = useState<string | null>(null);

  const amountWeiRef = useRef<bigint>(0n);

  // ── Contract reads ──────────────────────────────────────────────────────────
  const { data: reads, refetch: refetchReads } = useReadContracts({
    contracts: [
      { address: CONTRACT_ADDRESSES.CLAW_TOKEN, abi: clawTokenABI,         functionName: 'balanceOf',              args: [address ?? '0x0000000000000000000000000000000000000000'] },
      { address: CONTRACT_ADDRESSES.CLAW_TOKEN, abi: clawTokenABI,         functionName: 'allowance',              args: [address ?? '0x0000000000000000000000000000000000000000', CONTRACT_ADDRESSES.STAKING] },
      { address: CONTRACT_ADDRESSES.STAKING,    abi: clawStreetStakingABI, functionName: 'positions',              args: [address ?? '0x0000000000000000000000000000000000000000'] },
      { address: CONTRACT_ADDRESSES.STAKING,    abi: clawStreetStakingABI, functionName: 'pendingRevenue',         args: [address ?? '0x0000000000000000000000000000000000000000'] },
      { address: CONTRACT_ADDRESSES.STAKING,    abi: clawStreetStakingABI, functionName: 'lockRemaining',          args: [address ?? '0x0000000000000000000000000000000000000000'] },
      { address: CONTRACT_ADDRESSES.STAKING,    abi: clawStreetStakingABI, functionName: 'totalStaked' },
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
  const passId       = position?.[3];
  const hasPass      = position?.[4] ?? false;
  const isStaked     = stakedAmount > 0n;

  const amountWei = amount ? parseUnits(amount, 18) : 0n;
  amountWeiRef.current = amountWei;
  const needsApproval = clawAllowance < amountWei;

  const lockDays        = lockLeft > 0n ? Math.ceil(Number(lockLeft) / 86400) : 0;
  const lockProgressPct = lockLeft > 0n ? Math.min(100, Math.round(((30 - lockDays) / 30) * 100)) : 100;
  const unlockDate      = lockLeft > 0n
    ? new Date(Date.now() + Number(lockLeft) * 1000).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })
    : null;

  // Share of protocol (rough estimate)
  const myShare = totalStaked > 0n && stakedAmount > 0n
    ? ((Number(stakedAmount) / Number(totalStaked)) * 100).toFixed(1)
    : '0.0';

  // ── Approve ─────────────────────────────────────────────────────────────────
  const { writeContract: approve, isPending: isApproving, data: approveTxHash } = useWriteContract();
  const { isLoading: isApproveConfirming, isSuccess: isApproveSuccess, isError: isApproveError, error: approveError } = useWaitForTransactionReceipt({ hash: approveTxHash });

  // ── Stake ───────────────────────────────────────────────────────────────────
  const { writeContract: stakeTokens, isPending: isStaking, data: stakeTxHash } = useWriteContract();
  const { isLoading: isStakeConfirming, isSuccess: isStakeSuccess, isError: isStakeError, error: stakeError } = useWaitForTransactionReceipt({ hash: stakeTxHash });

  // ── Claim revenue ───────────────────────────────────────────────────────────
  const { writeContract: claimRev, isPending: isClaiming, data: claimTxHash } = useWriteContract();
  const { isLoading: isClaimConfirming, isSuccess: isClaimSuccess, isError: isClaimError } = useWaitForTransactionReceipt({ hash: claimTxHash });

  // ── Unstake ─────────────────────────────────────────────────────────────────
  const { writeContract: unstake, isPending: isUnstaking, data: unstakeTxHash } = useWriteContract();
  const { isSuccess: isUnstakeSuccess } = useWaitForTransactionReceipt({ hash: unstakeTxHash });

  // ── After approval: auto-submit stake ──────────────────────────────────────
  useEffect(() => {
    if (isApproveSuccess && step === 'approving') {
      setStep('staking');
      stakeTokens({ address: CONTRACT_ADDRESSES.STAKING, abi: clawStreetStakingABI, functionName: 'stake', args: [amountWeiRef.current] });
    }
  }, [isApproveSuccess, step, stakeTokens]);

  useEffect(() => {
    if (isStakeSuccess) {
      setStep('success');
      refetchReads();
      if (stakeTxHash) toast.tx('Staked & ClawPass minted!', stakeTxHash);
    }
  }, [isStakeSuccess, refetchReads, stakeTxHash]);

  useEffect(() => {
    if (isApproveError && step === 'approving') {
      setTxError(approveError?.message?.slice(0, 120) ?? 'Approval failed');
      setStep('error');
    }
  }, [isApproveError, step, approveError]);

  useEffect(() => {
    if (isStakeError && step === 'staking') {
      setTxError(stakeError?.message?.slice(0, 120) ?? 'Stake failed');
      setStep('error');
    }
  }, [isStakeError, step, stakeError]);

  useEffect(() => {
    if (isClaimSuccess) { refetchReads(); if (claimTxHash) toast.tx('Revenue claimed!', claimTxHash); }
  }, [isClaimSuccess, refetchReads, claimTxHash]);

  useEffect(() => {
    if (isUnstakeSuccess) { refetchReads(); if (unstakeTxHash) toast.tx('Unstaked!', unstakeTxHash); }
  }, [isUnstakeSuccess, refetchReads, unstakeTxHash]);

  useEffect(() => {
    if (isClaimError) { setIsClaimModalOpen(false); toast.error('Claim failed'); }
  }, [isClaimError]);

  const handleStakeConfirm = () => {
    if (!address || !amountWei) return;
    setTxError(null);
    if (needsApproval) {
      setStep('approving');
      approve({ address: CONTRACT_ADDRESSES.CLAW_TOKEN, abi: clawTokenABI, functionName: 'approve', args: [CONTRACT_ADDRESSES.STAKING, amountWei] });
    } else {
      setStep('staking');
      stakeTokens({ address: CONTRACT_ADDRESSES.STAKING, abi: clawStreetStakingABI, functionName: 'stake', args: [amountWei] });
    }
  };

  const closeStakeModal = () => { setIsStakeModalOpen(false); setStep('idle'); setTxError(null); };

  const isBusy = isApproving || isApproveConfirming || isStaking || isStakeConfirming;
  const activeTxHash = stakeTxHash ?? approveTxHash;

  const stepLabel =
    step === 'error'   ? 'Transaction Failed' :
    step === 'success' ? 'Staked!' :
    isApproving || isApproveConfirming ? 'Approving…' :
    isStaking   || isStakeConfirming   ? 'Staking…'   :
    needsApproval ? 'Approve & Stake' : 'Stake & Mint Pass';

  // ── Render ──────────────────────────────────────────────────────────────────
  return (
    <div className="min-h-screen">

      {/* ── Hero ────────────────────────────────────────────────────────────── */}
      <div className="relative overflow-hidden border-b border-cyber-border">
        {/* Background glow grid */}
        <div className="absolute inset-0 opacity-[0.03]" style={{
          backgroundImage: 'linear-gradient(rgba(0,82,255,1) 1px, transparent 1px), linear-gradient(90deg, rgba(0,82,255,1) 1px, transparent 1px)',
          backgroundSize: '40px 40px'
        }} />
        <div className="absolute left-1/2 top-0 -translate-x-1/2 w-[600px] h-[300px] rounded-full bg-base-blue/8 blur-3xl pointer-events-none" />

        <div className="relative max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-16 text-center">
          <div className="inline-flex items-center gap-2 px-3 py-1.5 rounded-full bg-base-blue/10 border border-base-blue/25 text-xs text-base-blue font-semibold mb-6">
            <div className="w-1.5 h-1.5 rounded-full bg-green-400 animate-pulse" />
            Live on Base Sepolia
          </div>
          {/* <div className="text-7xl mb-5 drop-shadow-[0_0_30px_rgba(0,82,255,0.4)]">🦞</div> */}
          <h1 className="text-5xl md:text-6xl font-extrabold text-white tracking-tight mb-4">
            Stake <span className="text-base-blue">$STREET</span>
          </h1>
          <p className="text-lg text-gray-400 max-w-xl mx-auto leading-relaxed">
            Lock tokens to mint your <span className="text-white font-semibold">ClawPass NFT</span>. Earn protocol revenue from every deal, govern the street, and get priority OTC access.
          </p>
        </div>
      </div>

      {/* ── Protocol Stats ──────────────────────────────────────────────────── */}
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-10">
          <StatTile
            label="Total Staked"
            value={`${Number(formatUnits(totalStaked, 18)).toLocaleString()}`}
            sub="$STREET locked"
            color="text-white"
            icon={<BarChart3 size={16} />}
          />
          <StatTile
            label="Est. APY"
            value="~24.5%"
            sub="Protocol fee revenue"
            color="text-green-400"
            icon={<TrendingUp size={16} />}
          />
          <StatTile
            label="Lock Period"
            value="30 Days"
            sub="Minimum commitment"
            color="text-orange-400"
            icon={<Lock size={16} />}
          />
          <StatTile
            label="Pass Type"
            value="Soul-Bound"
            sub="ERC-721 · non-transferable"
            color="text-green-400"
            icon={<Award size={16} />}
          />
        </div>

        {/* ── 3-column layout ─────────────────────────────────────────────── */}
        <div className="grid lg:grid-cols-3 gap-8 items-start">

          {/* Col 1: Pass preview + benefits ─────────────────────────────── */}
          <div className="space-y-6">
            <ClawPassCard passId={passId} address={address} stakedAmount={stakedAmount} />

            <div className="space-y-3">
              <p className="text-xs font-bold text-gray-500 uppercase tracking-widest">Pass Benefits</p>
              <Benefit
                icon={<TrendingUp size={14} />}
                title="Protocol Revenue Share"
                desc="Earn a pro-rata slice of every broker fee collected from loans and option sales."
              />
              <Benefit
                icon={<Zap size={14} />}
                title="Priority OTC Matching"
                desc="ClawPass holders get early visibility into large OTC deals before market listing."
              />
              <Benefit
                icon={<Shield size={14} />}
                title="On-Chain Governance"
                desc="Vote on protocol parameters, fee rates, and new market listings via your Pass."
              />
              <Benefit
                icon={<Users size={14} />}
                title="Agent Score Boost"
                desc="Agents holding a ClawPass receive a 1.10× reputation multiplier on loan health scoring."
              />
            </div>
          </div>

          {/* Col 2: Stake input card ─────────────────────────────────────── */}
          <div className="space-y-4">

            {/* Active position card */}
            {address && isStaked && (
              <div className="bg-cyber-surface rounded-2xl border border-lobster-orange/25 shadow-[0_0_30px_rgba(255,90,0,0.06)] overflow-hidden">
                <div className="px-5 py-3 bg-lobster-orange/5 border-b border-lobster-orange/15 flex items-center justify-between">
                  <span className="text-xs font-bold uppercase tracking-widest text-lobster-orange">Active Position</span>
                  {hasPass && passId && (
                    <a
                      href={`${BASESCAN_ADDR}${CONTRACT_ADDRESSES.STAKING}`}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="flex items-center gap-1 text-[10px] text-lobster-orange/70 hover:text-lobster-orange transition-colors"
                    >
                      Pass #{Number(passId)} <ExternalLink size={8} />
                    </a>
                  )}
                </div>
                <div className="p-5 space-y-3">
                  {[
                    { label: 'Staked', value: `${Number(formatUnits(stakedAmount, 18)).toLocaleString()} $STREET`, color: 'text-white' },
                    { label: 'My Share', value: `${myShare}% of pool`, color: 'text-gray-300' },
                    { label: 'Pending Revenue', value: `${formatUnits(pendingRev, 6)} USDC`, color: 'text-green-400' },
                    { label: 'Lock Status', value: lockDays > 0 ? `${lockDays}d remaining` : 'Unlocked ✓', color: lockDays > 0 ? 'text-yellow-400' : 'text-green-400' },
                  ].map(({ label, value, color }) => (
                    <div key={label} className="flex justify-between items-center text-sm">
                      <span className="text-gray-500">{label}</span>
                      <span className={`font-semibold font-mono ${color}`}>{value}</span>
                    </div>
                  ))}

                  {/* Lock progress bar */}
                  {lockLeft > 0n && (
                    <div className="pt-1">
                      <div className="flex justify-between text-[10px] text-gray-600 mb-1.5 uppercase tracking-wider">
                        <span>Lock progress</span>
                        <span>{lockProgressPct}%</span>
                      </div>
                      <div className="h-1.5 bg-cyber-bg rounded-full overflow-hidden border border-cyber-border">
                        <div
                          className="h-full rounded-full transition-all duration-700 bg-gradient-to-r from-lobster-orange/60 to-lobster-orange"
                          style={{ width: `${lockProgressPct}%` }}
                        />
                      </div>
                      {unlockDate && <p className="text-[10px] text-gray-600 mt-1 text-right">Unlocks {unlockDate}</p>}
                    </div>
                  )}

                  {/* Action buttons */}
                  <div className="flex gap-3 pt-2">
                    {pendingRev > 0n && (
                      <button
                        onClick={() => setIsClaimModalOpen(true)}
                        disabled={isClaiming || isClaimConfirming}
                        className="flex-1 py-2 bg-green-500/10 text-green-400 border border-green-500/20 rounded-lg text-xs font-bold hover:bg-green-500/20 transition-colors disabled:opacity-50"
                      >
                        {isClaiming || isClaimConfirming ? <span className="flex items-center justify-center gap-1"><Loader2 size={12} className="animate-spin" />Claiming…</span> : `Claim ${formatUnits(pendingRev, 6)} USDC`}
                      </button>
                    )}
                    {lockDays === 0 && (
                      <button
                        onClick={handleUnstake}
                        disabled={isUnstaking}
                        className="flex-1 py-2 bg-red-500/10 text-red-400 border border-red-500/20 rounded-lg text-xs font-bold hover:bg-red-500/20 transition-colors disabled:opacity-50"
                      >
                        {isUnstaking ? <span className="flex items-center justify-center gap-1"><Loader2 size={12} className="animate-spin" />Unstaking…</span> : 'Unstake & Burn Pass'}
                      </button>
                    )}
                  </div>
                </div>
              </div>
            )}

            {/* Stake input card */}
            <div className="bg-cyber-surface rounded-2xl border border-base-blue/25 shadow-[0_0_40px_rgba(0,82,255,0.08)] overflow-hidden">
              <div className="px-5 py-3 bg-base-blue/5 border-b border-base-blue/15">
                <span className="text-xs font-bold uppercase tracking-widest text-base-blue">
                  {isStaked ? 'Top Up Position' : 'New Position'}
                </span>
              </div>

              <div className="p-5 space-y-5">
                {/* Balance row */}
                <div className="flex justify-between items-center text-xs text-gray-500">
                  <span>Available balance</span>
                  <span className="font-mono text-gray-300">
                    {address ? `${Number(formatUnits(clawBalance, 18)).toLocaleString()} $STREET` : '—'}
                  </span>
                </div>

                {/* Amount input */}
                <div className="relative">
                  <input
                    type="number"
                    value={amount}
                    onChange={(e) => setAmount(e.target.value)}
                    className="w-full bg-cyber-bg border border-cyber-border rounded-xl px-4 py-4 text-2xl text-white focus:outline-none focus:border-base-blue text-center font-mono transition-colors"
                    placeholder="0"
                    min="0"
                  />
                  <button
                    onClick={() => setAmount(formatUnits(clawBalance, 18))}
                    className="absolute right-3 top-1/2 -translate-y-1/2 text-[10px] font-bold bg-base-blue/15 hover:bg-base-blue/25 border border-base-blue/30 text-base-blue px-2.5 py-1 rounded-md transition-colors uppercase tracking-wider"
                  >
                    MAX
                  </button>
                </div>

                {/* Summary */}
                <div className="bg-cyber-bg rounded-xl p-4 space-y-2.5 border border-cyber-border">
                  {[
                    { label: 'Est. APY', value: '~24.5%', vcolor: 'text-green-400' },
                    { label: 'Lock Period', value: '30 days', vcolor: 'text-white' },
                    { label: 'Total Protocol Staked', value: `${Number(formatUnits(totalStaked, 18)).toLocaleString()} STREET`, vcolor: 'text-white' },
                  ].map(({ label, value, vcolor }) => (
                    <div key={label} className="flex justify-between text-sm">
                      <span className="text-gray-500">{label}</span>
                      <span className={`font-semibold ${vcolor}`}>{value}</span>
                    </div>
                  ))}
                  <div className="flex justify-between text-sm pt-2.5 border-t border-cyber-border">
                    <span className="text-gray-500">You Receive</span>
                    <span className="text-base-blue font-bold">1× ClawPass NFT</span>
                  </div>
                </div>

                {/* CTA */}
                {!address ? (
                  <div className="w-full py-3.5 bg-cyber-border text-gray-500 rounded-xl font-semibold text-sm text-center">
                    Connect Wallet to Stake
                  </div>
                ) : (
                  <button
                    onClick={() => { setStep('idle'); setTxError(null); setIsStakeModalOpen(true); }}
                    disabled={!amount || Number(amount) <= 0 || isBusy}
                    className="w-full py-3.5 bg-base-blue text-white rounded-xl font-bold text-sm hover:bg-base-dark transition-all shadow-lg shadow-base-blue/20 disabled:opacity-40 disabled:cursor-not-allowed"
                  >
                    {isBusy ? (
                      <span className="flex items-center justify-center gap-2">
                        <Loader2 size={14} className="animate-spin" /> Processing…
                      </span>
                    ) : isStaked ? 'Top Up & Extend Lock' : 'Stake & Mint ClawPass'}
                  </button>
                )}

                {/* Approval note */}
                {address && amount && Number(amount) > 0 && needsApproval && (
                  <p className="text-[10px] text-center text-yellow-400/70">
                    Requires 2 transactions: approve $STREET spend, then stake.
                  </p>
                )}
              </div>
            </div>

            {/* Contract links */}
            <div className="flex gap-2 flex-wrap justify-center">
              {[
                { label: 'Staking Contract', addr: CONTRACT_ADDRESSES.STAKING },
                { label: '$STREET Token', addr: CONTRACT_ADDRESSES.CLAW_TOKEN },
              ].map(({ label, addr }) => (
                <a
                  key={addr}
                  href={`${BASESCAN_ADDR}${addr}`}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="flex items-center gap-1.5 text-[11px] text-gray-500 hover:text-base-blue transition-colors px-3 py-1.5 bg-cyber-surface border border-cyber-border rounded-lg hover:border-base-blue/30"
                >
                  {label} <ExternalLink size={9} />
                </a>
              ))}
            </div>
          </div>

          {/* Col 3: How it works ─────────────────────────────────────────── */}
          <div className="space-y-6">
            <div className="bg-cyber-surface border border-cyber-border rounded-2xl overflow-hidden">
              <div className="px-5 py-3 border-b border-cyber-border">
                <span className="text-xs font-bold uppercase tracking-widest text-gray-400">How It Works</span>
              </div>
              <div className="p-5 space-y-0">
                {[
                  { n: '01', title: 'Approve $STREET', desc: 'Allow the Staking contract to transfer your tokens. One-time per amount.' },
                  { n: '02', title: 'Stake & Mint Pass', desc: 'Lock tokens for 30 days. A ClawPass NFT is minted to your wallet.' },
                  { n: '03', title: 'Earn Protocol Fees', desc: 'Every loan brokerage fee and option sale distributes USDC to all ClawPass holders.' },
                  { n: '04', title: 'Claim Revenue', desc: 'Call claimRevenue() any time. USDC lands directly in your wallet.' },
                  { n: '05', title: 'Unstake After Lock', desc: 'After 30 days, unstake to receive $STREET back. The ClawPass NFT is burned.' },
                ].map(({ n, title, desc }, i, arr) => (
                  <div key={n} className={`flex gap-4 py-4 ${i < arr.length - 1 ? 'border-b border-cyber-border/40' : ''}`}>
                    <div className="shrink-0 w-7 h-7 rounded-full bg-base-blue/10 border border-base-blue/20 flex items-center justify-center text-[10px] font-bold text-base-blue">
                      {n}
                    </div>
                    <div>
                      <p className="text-sm font-semibold text-white">{title}</p>
                      <p className="text-xs text-gray-500 mt-0.5 leading-relaxed">{desc}</p>
                    </div>
                  </div>
                ))}
              </div>
            </div>

            {/* Revenue source breakdown */}
            <div className="bg-cyber-surface border border-cyber-border rounded-2xl p-5 space-y-4">
              <p className="text-xs font-bold uppercase tracking-widest text-gray-400">Revenue Sources</p>
              {[
                { label: 'Loan Brokerage Fee', pct: '1%', desc: 'of every accepted loan principal' },
                { label: 'Option Premium Cut', pct: '~0%', desc: 'writer keeps full premium (direct)' },
                { label: 'Exercise Spread', pct: 'n/a', desc: 'strike goes to option writer' },
              ].map(({ label, pct, desc }) => (
                <div key={label} className="flex items-start justify-between gap-3">
                  <div>
                    <p className="text-xs font-semibold text-white">{label}</p>
                    <p className="text-[10px] text-gray-500 mt-0.5">{desc}</p>
                  </div>
                  <span className="shrink-0 text-xs font-bold text-green-400 bg-green-500/10 border border-green-500/20 px-2 py-0.5 rounded">{pct}</span>
                </div>
              ))}
            </div>

            {/* FAQ */}
            <div className="bg-cyber-surface border border-cyber-border rounded-2xl p-5 space-y-4">
              <p className="text-xs font-bold uppercase tracking-widest text-gray-400">FAQ</p>
              {[
                { q: 'Is the ClawPass transferable?', a: 'No. It\'s soul-bound — tied to your wallet address. It cannot be sold or transferred.' },
                { q: 'What if I top-up my stake?', a: 'Top-up resets the 30-day lock but also settles any pending USDC revenue first.' },
                { q: 'What happens to revenue if nobody is staked?', a: 'Fees accumulate in an unallocated reserve and are distributed to the first staker who joins.' },
              ].map(({ q, a }) => (
                <div key={q} className="text-xs space-y-1">
                  <p className="text-gray-300 font-semibold">{q}</p>
                  <p className="text-gray-500 leading-relaxed">{a}</p>
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>

      {/* ── Stake Confirm Modal ── */}
      <Modal isOpen={isStakeModalOpen} onClose={closeStakeModal} title="Confirm Stake">
        <div className="space-y-4">

          {step === 'error' && (
            <div className="space-y-3">
              <div className="flex items-start gap-3 p-3 bg-red-500/5 border border-red-500/20 rounded-lg">
                <XCircle size={16} className="text-red-400 shrink-0 mt-0.5" />
                <div>
                  <p className="text-sm font-semibold text-red-400 mb-1">Transaction Failed</p>
                  <p className="text-xs text-gray-400">{txError}</p>
                </div>
              </div>
              {activeTxHash && (
                <a href={`${BASESCAN_TX}${activeTxHash}`} target="_blank" rel="noopener noreferrer"
                  className="block text-center text-xs text-base-blue hover:underline">
                  View on Basescan ↗
                </a>
              )}
              <button onClick={closeStakeModal}
                className="w-full py-2.5 bg-white/5 text-gray-300 border border-white/10 rounded-lg font-medium text-sm hover:bg-white/10 transition-colors">
                Dismiss
              </button>
            </div>
          )}

          {step === 'success' && (
            <div className="text-center py-4 space-y-3">
              <CheckCircle2 size={40} className="text-green-400 mx-auto" />
              <div>
                <p className="text-green-400 font-bold text-lg">Staked!</p>
                <p className="text-xs text-gray-400 mt-1">Your ClawPass NFT has been minted to your wallet.</p>
              </div>
              {stakeTxHash && (
                <a href={`${BASESCAN_TX}${stakeTxHash}`} target="_blank" rel="noopener noreferrer"
                  className="block text-xs text-base-blue hover:underline">
                  View transaction ↗
                </a>
              )}
              <button onClick={() => { closeStakeModal(); setAmount(''); }}
                className="w-full py-2.5 bg-base-blue text-white rounded-lg font-bold text-sm hover:bg-base-dark transition-colors">
                Done
              </button>
            </div>
          )}

          {step !== 'success' && step !== 'error' && (
            <>
              <div className="bg-cyber-bg rounded-xl p-4 space-y-2 border border-cyber-border">
                <div className="flex justify-between text-sm">
                  <span className="text-gray-400">Amount</span>
                  <span className="text-white font-bold font-mono">{amount} $STREET</span>
                </div>
                <div className="flex justify-between text-sm">
                  <span className="text-gray-400">Lock period</span>
                  <span className="text-yellow-400 font-semibold">30 days</span>
                </div>
                <div className="flex justify-between text-sm">
                  <span className="text-gray-400">You receive</span>
                  <span className="text-base-blue font-bold">1× ClawPass NFT</span>
                </div>
              </div>

              {needsApproval && step === 'idle' && (
                <div className="flex items-start gap-2 px-3 py-2.5 bg-yellow-400/5 border border-yellow-400/20 rounded-lg">
                  <Clock size={13} className="text-yellow-400 shrink-0 mt-0.5" />
                  <p className="text-xs text-yellow-400">Step 1/2: Approve $STREET spend, then step 2/2 will confirm the stake automatically.</p>
                </div>
              )}

              {(isApproveConfirming || isStakeConfirming) && activeTxHash && (
                <div className="flex items-center justify-between px-3 py-2 bg-base-blue/5 border border-base-blue/20 rounded-lg">
                  <div className="flex items-center gap-2">
                    <Loader2 size={12} className="text-base-blue animate-spin" />
                    <span className="text-xs text-gray-400">
                      {isApproveConfirming ? 'Waiting for approval confirmation…' : 'Waiting for stake confirmation…'}
                    </span>
                  </div>
                  <a href={`${BASESCAN_TX}${activeTxHash}`} target="_blank" rel="noopener noreferrer"
                    className="text-xs text-base-blue hover:underline shrink-0">Basescan ↗</a>
                </div>
              )}

              <button onClick={handleStakeConfirm} disabled={isBusy}
                className="w-full py-2.5 bg-base-blue text-white rounded-lg font-bold text-sm hover:bg-base-dark transition-colors disabled:opacity-50 disabled:cursor-not-allowed">
                {isBusy ? <span className="flex items-center justify-center gap-2"><Loader2 size={13} className="animate-spin" />{stepLabel}</span> : stepLabel}
              </button>

              {isBusy && (
                <button onClick={closeStakeModal}
                  className="w-full py-1.5 text-gray-500 text-xs hover:text-gray-400 transition-colors">
                  Running in background — close this window
                </button>
              )}
            </>
          )}
        </div>
      </Modal>

      {/* ── Claim Revenue Modal ── */}
      <Modal isOpen={isClaimModalOpen} onClose={() => setIsClaimModalOpen(false)} title="Claim Revenue">
        <div className="space-y-4">
          <div className="bg-green-500/5 border border-green-500/20 rounded-xl p-4">
            <p className="text-sm text-gray-400 mb-1">Claimable USDC</p>
            <p className="text-2xl font-bold text-green-400 font-mono">{formatUnits(pendingRev, 6)} USDC</p>
            <p className="text-xs text-gray-500 mt-1">Accrued protocol fee revenue for your staking position.</p>
          </div>
          <button
            onClick={() => { claimRev({ address: CONTRACT_ADDRESSES.STAKING, abi: clawStreetStakingABI, functionName: 'claimRevenue' }); setIsClaimModalOpen(false); }}
            disabled={isClaiming || isClaimConfirming}
            className="w-full py-2.5 bg-green-600 text-white rounded-lg font-bold text-sm hover:bg-green-700 transition-colors disabled:opacity-50"
          >
            {isClaiming || isClaimConfirming
              ? <span className="flex items-center justify-center gap-2"><Loader2 size={13} className="animate-spin" />Claiming…</span>
              : 'Claim Revenue'}
          </button>
        </div>
      </Modal>
    </div>
  );
}
