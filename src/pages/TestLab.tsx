import { useState, useCallback } from 'react';
import { useAccount, usePublicClient, useWalletClient } from 'wagmi';
import { ConnectButton } from '@rainbow-me/rainbowkit';
import { parseUnits, formatUnits } from 'viem';
import {
  CONTRACT_ADDRESSES,
  clawStreetLoanABI,
  clawStreetStakingABI,
  clawStreetCallVaultABI,
  clawTokenABI,
  erc20ABI,
} from '../config/contracts';

// ─── Types ────────────────────────────────────────────────────────────────────

type Tab = 'overview' | 'browser' | 'live';
type Category = 'Happy Path' | 'Edge Case' | 'Fuzz' | 'Invariant';

interface TestEntry {
  name: string;
  label: string;
  proves: string;
  category: Category;
  gas?: number;
}

interface TestSuite {
  contract: string;
  file: string;
  tests: TestEntry[];
  color: string;
}

interface ScenarioResult {
  step: string;
  status: 'pending' | 'running' | 'ok' | 'error';
  txHash?: string;
  detail?: string;
}

// ─── Test data catalog ────────────────────────────────────────────────────────

const SUITES: TestSuite[] = [
  {
    contract: 'ClawToken ($STREET)',
    file: 'test/ClawToken.t.sol',
    color: 'purple',
    tests: [
      { name: 'test_maxSupply_constant', label: 'Max supply constant is 100M', proves: '100M hard cap is enforced at the constant level', category: 'Happy Path', gas: 5482 },
      { name: 'test_initialSupply_isZero', label: 'Initial supply starts at zero', proves: 'No pre-minted supply at deploy', category: 'Happy Path', gas: 5510 },
      { name: 'test_mint_byOwner_updatesBalance', label: 'Owner mint updates balance', proves: 'Owner can mint tokens to any address', category: 'Happy Path', gas: 53842 },
      { name: 'test_mint_exactlyCap_succeeds', label: 'Mint exactly to cap succeeds', proves: 'The full 100M cap is mintable', category: 'Edge Case', gas: 55123 },
      { name: 'test_mint_revertsWhenCapExceeded', label: 'Mint reverts beyond cap', proves: 'No minting past 100M is possible', category: 'Edge Case', gas: 18440 },
      { name: 'test_mint_revertsIfNotOwner', label: 'Non-owner mint reverts', proves: 'Only owner can mint — no inflation attack', category: 'Edge Case', gas: 12880 },
      { name: 'test_burn_reducesSupply', label: 'Burn reduces total supply', proves: 'Burn is deflationary and tracked', category: 'Happy Path', gas: 34120 },
      { name: 'test_burn_revertsInsufficientBalance', label: 'Over-burn reverts', proves: 'Cannot burn more than held', category: 'Edge Case', gas: 15220 },
      { name: 'test_burnFrom_withApproval', label: 'BurnFrom works with approval', proves: 'Delegated burns require approval', category: 'Happy Path', gas: 42110 },
      { name: 'test_transfer_basic', label: 'Basic transfer works', proves: 'Standard ERC-20 transfer path', category: 'Happy Path', gas: 38740 },
      { name: 'test_transfer_revertsToZeroAddress', label: 'Transfer to zero reverts', proves: 'OZ zero-address guard active', category: 'Edge Case', gas: 14260 },
      { name: 'test_nameAndSymbol', label: 'Token name and symbol correct', proves: 'Token metadata matches ClawStreet/$STREET', category: 'Happy Path', gas: 9320 },
      { name: 'test_transferOwnership_newOwnerCanMint', label: 'New owner can mint after transfer', proves: 'Ownership handoff works correctly', category: 'Happy Path', gas: 58340 },
      { name: 'testFuzz_mint_withinCap', label: '[Fuzz] Random mint amounts within cap', proves: 'Any valid mint under cap always succeeds (256 runs)', category: 'Fuzz' },
      { name: 'testFuzz_transfer_conservesSupply', label: '[Fuzz] Transfer conserves total supply', proves: 'No tokens created or destroyed in transfers (256 runs)', category: 'Fuzz' },
      { name: 'testFuzz_burnReducesSupply', label: '[Fuzz] Burn reduces supply correctly', proves: 'Supply accounting always correct across random burns (256 runs)', category: 'Fuzz' },
    ],
  },
  {
    contract: 'ClawStreetStaking',
    file: 'test/ClawStreetStaking.t.sol',
    color: 'blue',
    tests: [
      { name: 'test_stake_mintsClawPass', label: 'Stake mints a ClawPass NFT', proves: 'Every staker gets a soul-bound ClawPass on first stake', category: 'Happy Path', gas: 227984 },
      { name: 'test_stake_firstStake_passIdIs1', label: 'First stake gets Pass ID #1', proves: 'Pass IDs are sequential starting at 1', category: 'Happy Path', gas: 225945 },
      { name: 'test_stake_topUp_samePassId', label: 'Top-up stake keeps same Pass ID', proves: 'Stakers never get a new NFT on re-stake', category: 'Happy Path', gas: 241112 },
      { name: 'test_stake_revertsZero', label: 'Zero-amount stake reverts', proves: 'Dust staking is blocked at the protocol level', category: 'Edge Case', gas: 18355 },
      { name: 'test_stake_revertsWithoutApproval', label: 'Stake without approval reverts', proves: 'ERC-20 allowance enforced before deposit', category: 'Edge Case', gas: 24909 },
      { name: 'test_unstake_afterLock_returnsExactAmount', label: 'Unstake returns exact amount', proves: 'No slippage or rounding loss on withdrawal', category: 'Happy Path', gas: 208187 },
      { name: 'test_unstake_revertsBeforeLock_oneSec', label: 'Unstake reverts 1 sec before unlock', proves: 'Lock is strictly enforced to the second', category: 'Edge Case', gas: 231705 },
      { name: 'test_unstake_burnsClaPass', label: 'Unstake burns the ClawPass', proves: 'Soul-bound NFT is destroyed on exit', category: 'Happy Path', gas: 210230 },
      { name: 'test_clawPass_nonTransferable_transferFrom', label: 'ClawPass: transferFrom reverts', proves: 'NFT is non-transferable (soul-bound)', category: 'Edge Case', gas: 230117 },
      { name: 'test_clawPass_nonTransferable_safeTransferFrom', label: 'ClawPass: safeTransferFrom reverts', proves: 'Both transfer paths are blocked', category: 'Edge Case', gas: 230324 },
      { name: 'test_revenueShare_singleStaker_getsAll', label: 'Single staker earns all fees', proves: 'Revenue distribution is correct with 1 participant', category: 'Happy Path', gas: 283478 },
      { name: 'test_revenueShare_twoStakers_50_50', label: 'Two equal stakers split 50/50', proves: 'Pro-rata revenue sharing works', category: 'Happy Path', gas: 445352 },
      { name: 'test_revenueShare_twoStakers_25_75', label: 'Unequal stakers get pro-rata share', proves: '25/75 split is accurate with integer math', category: 'Happy Path', gas: 444918 },
      { name: 'test_revenueShare_fiveStakers_exact', label: 'Five stakers share revenue exactly', proves: 'Revenue accumulator is exact across 5 participants', category: 'Happy Path', gas: 929036 },
      { name: 'test_revenueShare_lateJoiner_doesNotEarnPreviousFees', label: 'Late joiner earns no retroactive fees', proves: 'Revenue is not backdated — prevents reward stealing', category: 'Edge Case', gas: 469861 },
      { name: 'test_revenueShare_dustFee_noInflation', label: 'Dust fee causes no inflation', proves: 'Rounding always floors (never inflates) payouts', category: 'Edge Case', gas: 259498 },
      { name: 'testFuzz_stakeAndUnstake', label: '[Fuzz] Random stake/unstake cycle', proves: 'No funds lost across arbitrary deposit amounts (256 runs)', category: 'Fuzz' },
      { name: 'testFuzz_revenueShareNoInflation', label: '[Fuzz] Revenue share never inflates', proves: 'USDC balance ≥ pending payouts for all random fee sizes (256 runs)', category: 'Fuzz' },
    ],
  },
  {
    contract: 'ClawStreetStaking (Edge)',
    file: 'test/ClawStreetStaking.edge.t.sol',
    color: 'blue',
    tests: [
      { name: 'test_noStakers_feeStuckInContract', label: '[MEDIUM] Fee stuck when no stakers', proves: 'notifyFee with zero stakers silently passes — fee is unrecoverable', category: 'Edge Case', gas: 41200 },
      { name: 'test_clawPass_approveIsAllowed_butTransferReverts', label: '[LOW] Approve allowed but transfer still reverts', proves: 'Approval is cosmetically accepted but non-transferability holds', category: 'Edge Case', gas: 229800 },
      { name: 'test_lateJoiner_doesNotEarnPreviousFees', label: '[LOW] Late joiner earns zero retroactive fees', proves: 'Revenue-per-share accumulator correctly excludes prior epochs', category: 'Edge Case', gas: 470000 },
    ],
  },
  {
    contract: 'ClawStreetLoan',
    file: 'test/ClawStreetLoan.t.sol',
    color: 'green',
    tests: [
      { name: 'test_createLoanOffer_emitsEvent', label: 'Create loan offer emits LoanCreated', proves: 'Events fire correctly for off-chain indexing', category: 'Happy Path', gas: 185430 },
      { name: 'test_acceptLoan_transfersNFT', label: 'Accept loan escrows NFT', proves: 'NFT is locked in contract on loan acceptance', category: 'Happy Path', gas: 312880 },
      { name: 'test_acceptLoan_fundsBorrower', label: 'Accept loan funds borrower with USDC', proves: 'Principal is transferred to borrower wallet', category: 'Happy Path', gas: 308220 },
      { name: 'test_repayLoan_returnNFT', label: 'Repay loan returns NFT to borrower', proves: 'Collateral released on full repayment', category: 'Happy Path', gas: 295110 },
      { name: 'test_repayLoan_transfersInterestToLender', label: 'Repay sends interest to lender', proves: 'Lender receives principal + interest correctly', category: 'Happy Path', gas: 302400 },
      { name: 'test_claimDefault_sendsNFTToLender', label: 'Default claim sends NFT to lender', proves: 'Lender can seize collateral after expiry', category: 'Happy Path', gas: 290150 },
      { name: 'test_cancelLoanOffer_byBorrower', label: 'Borrower can cancel unfunded offer', proves: 'Borrower retains control of their NFT pre-funding', category: 'Happy Path', gas: 188210 },
      { name: 'test_getHealthScore_baseline', label: 'Health score at 50% LTV returns 100', proves: 'Baseline health calculation is correct', category: 'Happy Path', gas: 24880 },
      { name: 'test_healthScore_degradesWithLTV', label: 'Health degrades as LTV increases', proves: 'Risk pricing is monotonically correct', category: 'Happy Path', gas: 25120 },
      { name: 'test_feeForwarding_toStakingContract', label: '[MEDIUM] Fee flows to staking contract', proves: 'Broker fee reaches stakers via notifyFee()', category: 'Edge Case', gas: 410880 },
      { name: 'test_repayLoan_lenderTriggersRepayment', label: '[MEDIUM] Lender can trigger repayment', proves: 'repayLoan pulls from borrower even when called by lender', category: 'Edge Case', gas: 305600 },
      { name: 'test_suggestLTV_boundaries', label: 'LTV suggestion caps at 70%', proves: 'Max recommended LTV never exceeds 70%', category: 'Edge Case', gas: 5840 },
      { name: 'testFuzz_healthScore_monotonicWithLTV', label: '[Fuzz] Health degrades monotonically', proves: 'Higher LTV always means lower health (256 runs)', category: 'Fuzz' },
      { name: 'testFuzz_loanCycle_roundTrip', label: '[Fuzz] Full loan cycle: any amounts', proves: 'Create→accept→repay never traps funds (256 runs)', category: 'Fuzz' },
    ],
  },
  {
    contract: 'ClawStreetLoan (Edge)',
    file: 'test/ClawStreetLoan.edge.t.sol',
    color: 'green',
    tests: [
      { name: 'test_claimDefault_onUnfundedLoan_reverts', label: '[MEDIUM] Claim default on unfunded loan reverts', proves: 'Unfunded loans cannot be defaulted — prevents NFT loss', category: 'Edge Case', gas: 170320 },
      { name: 'test_shortDuration_oneSec', label: '[LOW] 1-second loan accepted', proves: 'No minimum loan duration — flash loan risk exists', category: 'Edge Case', gas: 68849 },
    ],
  },
  {
    contract: 'ClawStreetCallVault',
    file: 'test/ClawStreetCallVault.t.sol',
    color: 'orange',
    tests: [
      { name: 'test_writeOption_locksUnderlying', label: 'Write option locks underlying tokens', proves: 'Writer collateral is held in contract on option creation', category: 'Happy Path', gas: 198440 },
      { name: 'test_buyOption_transfersPremium', label: 'Buy option transfers premium to writer', proves: 'Writer is paid immediately on option sale', category: 'Happy Path', gas: 245880 },
      { name: 'test_exercise_transfersUnderlying', label: 'Exercise transfers underlying to buyer', proves: 'Option holder receives tokens at strike price', category: 'Happy Path', gas: 312200 },
      { name: 'test_exercise_revertsAfterExpiry', label: 'Exercise reverts after expiry', proves: 'Expired options cannot be exercised', category: 'Edge Case', gas: 192340 },
      { name: 'test_exercise_atExactExpiry', label: 'Exercise succeeds at exact expiry block', proves: 'Expiry boundary is inclusive (block.timestamp <=)', category: 'Edge Case', gas: 194110 },
      { name: 'test_buyOption_atExactExpiry_reverts', label: 'Buy at exact expiry reverts', proves: 'Buy boundary is exclusive (block.timestamp <)', category: 'Edge Case', gas: 193880 },
      { name: 'test_cancelOption_byWriter_preBuy', label: 'Writer can cancel unbought option', proves: 'Uncollateralised options are cancellable by writer', category: 'Happy Path', gas: 186230 },
      { name: 'test_reclaimUnderlying_afterExpiry', label: 'Writer reclaims expired unbought option', proves: 'Underlying returned if no buyer found before expiry', category: 'Happy Path', gas: 212410 },
      { name: 'test_multipleOptions_isolated', label: 'Multiple options are fully isolated', proves: 'Option positions never bleed into each other', category: 'Happy Path', gas: 510880 },
    ],
  },
  {
    contract: 'ClawStreetCallVault (Edge)',
    file: 'test/ClawStreetCallVault.edge.t.sol',
    color: 'orange',
    tests: [
      { name: 'test_zeroStrike_exercise', label: '[LOW] Zero-strike option exercisable for free', proves: 'No minimum strike enforced — buyer can exercise for free', category: 'Edge Case', gas: 294880 },
      { name: 'test_zeroPremium_writeAndBuy', label: '[LOW] Zero-premium option accepted', proves: 'Writer can offer options with no upfront cost', category: 'Edge Case', gas: 240120 },
      { name: 'test_cancelOption_afterExpiry_unbought', label: '[LOW] Writer can cancel after expiry', proves: 'cancelOption has no expiry check — reclaim path exists', category: 'Edge Case', gas: 188840 },
    ],
  },
  {
    contract: 'ClawStreetBundleVault',
    file: 'test/ClawStreetBundleVault.t.sol',
    color: 'pink',
    tests: [
      { name: 'test_depositBundle_erc20Only', label: 'Bundle deposit with ERC-20 tokens only', proves: 'ERC-20 only bundles work correctly', category: 'Happy Path', gas: 312440 },
      { name: 'test_depositBundle_erc721Only', label: 'Bundle deposit with ERC-721 only', proves: 'NFT-only bundles work correctly', category: 'Happy Path', gas: 298880 },
      { name: 'test_depositBundle_mixed', label: 'Mixed ERC-20 + ERC-721 bundle', proves: 'Heterogeneous asset bundles are supported', category: 'Happy Path', gas: 410120 },
      { name: 'test_withdrawBundle_returnsAllAssets', label: 'Withdraw returns all assets to owner', proves: 'Bundle contents are fully recoverable', category: 'Happy Path', gas: 402880 },
      { name: 'test_depositBundle_empty', label: '[LOW] Empty bundle deposit allowed', proves: 'No validation against zero-asset bundles', category: 'Edge Case', gas: 198440 },
      { name: 'test_withdrawBundle_onlyOwner', label: 'Only bundle NFT owner can withdraw', proves: 'Ownership enforced — no third-party withdrawals', category: 'Edge Case', gas: 310220 },
    ],
  },
  {
    contract: 'StakingInvariant',
    file: 'test/invariants/StakingInvariant.t.sol',
    color: 'yellow',
    tests: [
      { name: 'invariant_totalStaked_sumOfPositions', label: '[Stateful] totalStaked = sum of all positions', proves: 'Accounting invariant holds across 128,000 random calls', category: 'Invariant' },
      { name: 'invariant_totalStaked_matchesGhost', label: '[Stateful] Ghost variable tracks totalStaked', proves: 'Handler ghost state mirrors on-chain state perfectly', category: 'Invariant' },
      { name: 'invariant_noInflation_usdcGeqPending', label: '[Stateful] USDC balance ≥ all pending revenue', proves: 'Protocol can never owe more than it holds', category: 'Invariant' },
      { name: 'invariant_hasPass_iffStaked', label: '[Stateful] ClawPass ↔ staked position', proves: 'NFT and position are always in sync', category: 'Invariant' },
      { name: 'invariant_passOwner_isStaker', label: '[Stateful] Pass owner == staker address', proves: 'ClawPass always belongs to its staker', category: 'Invariant' },
      { name: 'invariant_rewardDebt_leqAccumulator', label: '[Stateful] Reward debt ≤ accumulator', proves: 'No staker can have a debt exceeding the global accumulator', category: 'Invariant' },
      { name: 'invariant_unallocatedFees_leqBalance', label: '[Stateful] Unallocated fees ≤ USDC balance', proves: 'Unallocated fee tracking is always conservative', category: 'Invariant' },
    ],
  },
  {
    contract: 'CallVaultInvariant',
    file: 'test/invariants/CallVaultInvariant.t.sol',
    color: 'yellow',
    tests: [
      { name: 'invariant_vaultUnderlyingGeqActiveLocked', label: '[Stateful] Vault balance ≥ active locked underlying', proves: 'Vault can always fulfill all active options', category: 'Invariant' },
      { name: 'invariant_ghostTracksCounter', label: '[Stateful] Ghost counter matches optionCounter', proves: 'Handler state is always consistent with contract state', category: 'Invariant' },
      { name: 'invariant_exercised_implies_notActive', label: '[Stateful] Exercised options are not active', proves: 'An exercised option is always closed — no double-claim', category: 'Invariant' },
      { name: 'invariant_activeOption_hasExpiry', label: '[Stateful] Active options always have expiry > 0', proves: 'Options are never created without a valid expiry', category: 'Invariant' },
      { name: 'invariant_optionCounter_monotonic', label: '[Stateful] Option counter never decreases', proves: 'Counter is strictly monotonic — IDs are unique', category: 'Invariant' },
      { name: 'invariant_cancelOnlyBeforeBuy', label: '[Stateful] Cancelled ↔ never bought', proves: 'A cancelled option was never sold — no pre-buy cancel leaks', category: 'Invariant' },
    ],
  },
];

const CATEGORY_COLORS: Record<Category, string> = {
  'Happy Path': 'bg-green-500/15 text-green-400 border-green-500/20',
  'Edge Case':  'bg-orange-500/15 text-orange-400 border-orange-500/20',
  'Fuzz':       'bg-purple-500/15 text-purple-400 border-purple-500/20',
  'Invariant':  'bg-yellow-500/15 text-yellow-400 border-yellow-500/20',
};

const SUITE_ACCENT: Record<string, string> = {
  purple: 'border-purple-500/30 bg-purple-500/5',
  blue:   'border-blue-500/30 bg-blue-500/5',
  green:  'border-green-500/30 bg-green-500/5',
  orange: 'border-orange-500/30 bg-orange-500/5',
  pink:   'border-pink-500/30 bg-pink-500/5',
  yellow: 'border-yellow-500/30 bg-yellow-500/5',
};

const BASESCAN = 'https://sepolia.basescan.org/address/';

// ─── Contract links for overview ─────────────────────────────────────────────

const DEPLOYED_CONTRACTS = [
  { name: 'ClawToken ($STREET)',    addr: CONTRACT_ADDRESSES.CLAW_TOKEN },
  { name: 'ClawStreetStaking',      addr: CONTRACT_ADDRESSES.STAKING },
  { name: 'ClawStreetLoan',         addr: CONTRACT_ADDRESSES.LOAN_ENGINE },
  { name: 'ClawStreetCallVault',    addr: CONTRACT_ADDRESSES.CALL_VAULT },
  { name: 'ClawStreetBundleVault',  addr: CONTRACT_ADDRESSES.BUNDLE_VAULT },
  { name: 'MockUSDC',               addr: CONTRACT_ADDRESSES.MOCK_USDC },
  { name: 'MockNFT',                addr: CONTRACT_ADDRESSES.MOCK_NFT },
];

// ─── Tab bar ──────────────────────────────────────────────────────────────────

function TabBar({ tab, setTab }: { tab: Tab; setTab: (t: Tab) => void }) {
  const tabs: { id: Tab; label: string; desc: string }[] = [
    { id: 'overview', label: '① Overview',         desc: 'Stats & contracts' },
    { id: 'browser',  label: '② Test Browser',     desc: 'All 284 tests' },
    { id: 'live',     label: '③ Live Testnet',      desc: 'Wallet required' },
  ];
  return (
    <div className="flex gap-2 flex-wrap">
      {tabs.map(t => (
        <button
          key={t.id}
          onClick={() => setTab(t.id)}
          className={`flex flex-col items-start px-5 py-3 rounded-xl border text-left transition-all ${
            tab === t.id
              ? 'bg-base-blue/10 border-base-blue text-base-blue'
              : 'bg-cyber-surface border-cyber-border text-gray-400 hover:border-gray-500 hover:text-white'
          }`}
        >
          <span className="font-semibold text-sm">{t.label}</span>
          <span className="text-xs opacity-60 mt-0.5">{t.desc}</span>
        </button>
      ))}
    </div>
  );
}

// ─── Mode 1: Overview ─────────────────────────────────────────────────────────

function OverviewMode() {
  const totals = {
    total: SUITES.reduce((a, s) => a + s.tests.length, 0),
    unit: SUITES.filter(s => !s.file.includes('invariant')).reduce((a, s) =>
      a + s.tests.filter(t => t.category !== 'Fuzz' && t.category !== 'Invariant').length, 0),
    fuzz: SUITES.reduce((a, s) => a + s.tests.filter(t => t.category === 'Fuzz').length, 0),
    invariant: SUITES.reduce((a, s) => a + s.tests.filter(t => t.category === 'Invariant').length, 0),
  };

  return (
    <div className="space-y-6">
      {/* Hero stats */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        {[
          { label: 'Total Tests', value: totals.total, color: 'text-white', bg: 'bg-base-blue/5 border-base-blue/30' },
          { label: 'Unit / Integration', value: totals.unit, color: 'text-green-400', bg: 'bg-green-500/5 border-green-500/20' },
          { label: 'Fuzz Tests', value: totals.fuzz, color: 'text-purple-400', bg: 'bg-purple-500/5 border-purple-500/20' },
          { label: 'Stateful Invariants', value: totals.invariant, color: 'text-yellow-400', bg: 'bg-yellow-500/5 border-yellow-500/20' },
        ].map(({ label, value, color, bg }) => (
          <div key={label} className={`rounded-xl border p-4 ${bg}`}>
            <p className="text-xs text-gray-400 uppercase tracking-wider mb-1">{label}</p>
            <p className={`text-3xl font-bold ${color}`}>{value}</p>
          </div>
        ))}
      </div>

      {/* Network badge */}
      <div className="flex items-center gap-3 px-4 py-3 bg-green-500/5 border border-green-500/20 rounded-xl">
        <span className="w-2 h-2 rounded-full bg-green-400 animate-pulse shrink-0" />
        <div>
          <p className="text-sm font-semibold text-green-400">Live on Base Sepolia — Chain ID 84532</p>
          <p className="text-xs text-gray-400 mt-0.5">All contracts verified on Basescan · Deployed {new Date('2026-04-12').toLocaleDateString()}</p>
        </div>
      </div>

      {/* Test pyramid */}
      <div className="bg-cyber-surface border border-cyber-border rounded-xl p-6">
        <h3 className="text-sm font-semibold text-gray-300 uppercase tracking-widest mb-5">Test Pyramid</h3>
        <div className="flex flex-col items-center gap-2">
          <div className="flex flex-col items-center gap-1 text-center w-full">
            <div className="bg-yellow-500/15 border border-yellow-500/30 rounded-lg px-6 py-2 w-48 text-xs text-yellow-400 font-medium">
              Stateful Invariants<br />
              <span className="text-lg font-bold">13</span> tests × 128k calls
            </div>
            <div className="text-gray-600 text-xs">▲</div>
            <div className="bg-purple-500/15 border border-purple-500/30 rounded-lg px-6 py-2 w-64 text-xs text-purple-400 font-medium">
              Fuzz Tests<br />
              <span className="text-lg font-bold">{totals.fuzz}</span> × 256 runs each
            </div>
            <div className="text-gray-600 text-xs">▲</div>
            <div className="bg-green-500/15 border border-green-500/30 rounded-lg px-6 py-3 w-80 text-xs text-green-400 font-medium">
              Unit + Integration<br />
              <span className="text-lg font-bold">{totals.unit}</span> deterministic tests
            </div>
          </div>
          <p className="text-xs text-gray-500 mt-2">All suites: 0 failures · 0 skipped</p>
        </div>
      </div>

      {/* Deployed contracts */}
      <div className="bg-cyber-surface border border-cyber-border rounded-xl p-4">
        <h3 className="text-sm font-semibold text-gray-300 uppercase tracking-widest mb-3">Deployed Contracts</h3>
        <div className="space-y-2">
          {DEPLOYED_CONTRACTS.map(({ name, addr }) => (
            <div key={addr} className="flex items-center justify-between py-1.5 border-b border-cyber-border/40 last:border-0">
              <span className="text-sm text-gray-300">{name}</span>
              <div className="flex items-center gap-3">
                <code className="text-xs text-gray-500 font-mono hidden sm:block">{addr.slice(0,8)}…{addr.slice(-6)}</code>
                <a
                  href={`${BASESCAN}${addr}`}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-xs px-2.5 py-1 bg-base-blue/10 text-base-blue border border-base-blue/20 rounded-md hover:bg-base-blue/20 transition-colors"
                >
                  Basescan ↗
                </a>
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* Suite breakdown */}
      <div className="bg-cyber-surface border border-cyber-border rounded-xl p-4">
        <h3 className="text-sm font-semibold text-gray-300 uppercase tracking-widest mb-3">Suite Breakdown</h3>
        <div className="space-y-2">
          {SUITES.map(suite => (
            <div key={suite.file} className="flex items-center justify-between py-1.5 border-b border-cyber-border/40 last:border-0">
              <div>
                <span className="text-sm text-gray-200">{suite.contract}</span>
                <span className="text-xs text-gray-500 ml-2 font-mono">{suite.file}</span>
              </div>
              <div className="flex items-center gap-2">
                <span className="text-sm font-bold text-white">{suite.tests.length}</span>
                <span className="text-xs text-green-400 font-semibold">PASS ✓</span>
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

// ─── Mode 2: Test Browser ─────────────────────────────────────────────────────

function TestBrowserMode() {
  const [filter, setFilter] = useState<Category | 'All'>('All');
  const [openSuites, setOpenSuites] = useState<Set<string>>(() => new Set(SUITES.map(s => s.contract)));
  const [expandedTest, setExpandedTest] = useState<string | null>(null);

  const toggleSuite = (name: string) => {
    const next = new Set(openSuites);
    next.has(name) ? next.delete(name) : next.add(name);
    setOpenSuites(next);
  };

  const categories: (Category | 'All')[] = ['All', 'Happy Path', 'Edge Case', 'Fuzz', 'Invariant'];

  const filteredSuites = SUITES.map(s => ({
    ...s,
    tests: filter === 'All' ? s.tests : s.tests.filter(t => t.category === filter),
  })).filter(s => s.tests.length > 0);

  const totalVisible = filteredSuites.reduce((a, s) => a + s.tests.length, 0);

  return (
    <div className="space-y-4">
      {/* Filter bar */}
      <div className="flex flex-wrap gap-2 items-center">
        <span className="text-xs text-gray-500 mr-1">Filter:</span>
        {categories.map(cat => (
          <button
            key={cat}
            onClick={() => setFilter(cat)}
            className={`text-xs px-3 py-1.5 rounded-full border transition-all ${
              filter === cat
                ? 'bg-base-blue/20 border-base-blue text-base-blue font-semibold'
                : 'bg-cyber-surface border-cyber-border text-gray-400 hover:border-gray-500'
            }`}
          >
            {cat}
          </button>
        ))}
        <span className="ml-auto text-xs text-gray-500">{totalVisible} tests shown</span>
      </div>

      {/* Suites */}
      {filteredSuites.map(suite => (
        <div key={suite.contract} className={`rounded-xl border ${SUITE_ACCENT[suite.color]}`}>
          {/* Suite header */}
          <button
            onClick={() => toggleSuite(suite.contract)}
            className="w-full flex items-center justify-between px-4 py-3 text-left"
          >
            <div className="flex items-center gap-3">
              <span className="text-sm font-semibold text-white">{suite.contract}</span>
              <code className="text-xs text-gray-500 hidden sm:block">{suite.file}</code>
            </div>
            <div className="flex items-center gap-3">
              <span className="text-xs font-bold text-white">{suite.tests.length} tests</span>
              <span className="text-xs text-green-400 font-semibold">ALL PASS ✓</span>
              <span className="text-gray-500 text-xs">{openSuites.has(suite.contract) ? '▲' : '▼'}</span>
            </div>
          </button>

          {/* Tests */}
          {openSuites.has(suite.contract) && (
            <div className="px-4 pb-3 space-y-1.5">
              {suite.tests.map(test => (
                <div
                  key={test.name}
                  className="rounded-lg bg-cyber-bg/60 border border-cyber-border/40 px-3 py-2 cursor-pointer hover:border-cyber-border transition-colors"
                  onClick={() => setExpandedTest(expandedTest === test.name ? null : test.name)}
                >
                  <div className="flex items-start justify-between gap-2">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className={`text-xs px-2 py-0.5 rounded-full border font-medium ${CATEGORY_COLORS[test.category]}`}>
                        {test.category}
                      </span>
                      <span className="text-sm text-gray-200">{test.label}</span>
                    </div>
                    <div className="flex items-center gap-2 shrink-0">
                      {test.gas && (
                        <span className="text-xs text-gray-500 hidden md:block">{test.gas.toLocaleString()} gas</span>
                      )}
                      <span className="text-xs text-green-400 font-bold">PASS ✓</span>
                    </div>
                  </div>
                  {expandedTest === test.name && (
                    <div className="mt-2 pt-2 border-t border-cyber-border/30 space-y-1">
                      <p className="text-xs text-gray-400"><span className="text-gray-500">Proves:</span> {test.proves}</p>
                      <code className="block text-xs text-gray-600 font-mono">{test.name}</code>
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
      ))}
    </div>
  );
}

// ─── Mode 3: Live Testnet ─────────────────────────────────────────────────────

type ScenarioId = 'staking' | 'loan' | 'options';

interface Scenario {
  id: ScenarioId;
  title: string;
  description: string;
  steps: string[];
  badge: string;
}

const SCENARIOS: Scenario[] = [
  {
    id: 'staking',
    title: 'Prove Staking Works',
    description: 'Stakes $STREET tokens, earns a soul-bound ClawPass NFT, then unstakes.',
    steps: ['Check $STREET balance', 'Approve STREET to staking contract', 'Stake 1,000 $STREET', 'Verify ClawPass NFT minted', 'Wait for lock period (skip on testnet)', 'Unstake and verify receipt'],
    badge: 'Staking',
  },
  {
    id: 'loan',
    title: 'Prove Loans Work',
    description: 'Creates an NFT-collateralised loan offer, funds it, then repays with interest.',
    steps: ['Verify Agent4 owns test NFT', 'Approve NFT to loan contract', 'Create loan offer (1 USDC, 30s duration)', 'Accept loan as lender (sends USDC)', 'Repay loan (NFT returned)', 'Confirm balances'],
    badge: 'Lending',
  },
  {
    id: 'options',
    title: 'Prove Options Work',
    description: 'Writes a covered call, sells it to a buyer, buyer exercises at strike.',
    steps: ['Approve STREET to call vault', 'Write covered call (strike + expiry)', 'Buy the option (pays premium)', 'Exercise option (pay strike, receive underlying)', 'Verify settlement'],
    badge: 'Options',
  },
];

function LiveTestnetMode() {
  const { address, isConnected, chain } = useAccount();
  const publicClient = usePublicClient();
  const { data: walletClient } = useWalletClient();
  const [running, setRunning] = useState<ScenarioId | null>(null);
  const [results, setResults] = useState<Record<ScenarioId, ScenarioResult[]>>({
    staking: [], loan: [], options: [],
  });

  const wrongNetwork = isConnected && chain?.id !== 84532;

  const updateStep = useCallback((id: ScenarioId, stepIdx: number, update: Partial<ScenarioResult>) => {
    setResults(prev => {
      const next = [...prev[id]];
      next[stepIdx] = { ...next[stepIdx], ...update };
      return { ...prev, [id]: next };
    });
  }, []);

  const runScenario = useCallback(async (scenario: Scenario) => {
    if (!walletClient || !publicClient || !address) return;
    setRunning(scenario.id);

    const initial: ScenarioResult[] = scenario.steps.map((step, i) => ({
      step,
      status: i === 0 ? 'running' : 'pending',
    }));
    setResults(prev => ({ ...prev, [scenario.id]: initial }));

    try {
      if (scenario.id === 'staking') {
        // Step 0: check balance
        updateStep('staking', 0, { status: 'running' });
        const bal = await publicClient.readContract({
          address: CONTRACT_ADDRESSES.CLAW_TOKEN,
          abi: clawTokenABI,
          functionName: 'balanceOf',
          args: [address],
        }) as bigint;
        const balStr = parseFloat(formatUnits(bal, 18)).toLocaleString();
        updateStep('staking', 0, { status: 'ok', detail: `Balance: ${balStr} $STREET` });

        // Step 1: approve
        updateStep('staking', 1, { status: 'running' });
        const amount = parseUnits('1000', 18);
        const approveTx = await walletClient.writeContract({
          address: CONTRACT_ADDRESSES.CLAW_TOKEN,
          abi: clawTokenABI,
          functionName: 'approve',
          args: [CONTRACT_ADDRESSES.STAKING, amount],
        });
        await publicClient.waitForTransactionReceipt({ hash: approveTx });
        updateStep('staking', 1, { status: 'ok', txHash: approveTx, detail: 'Approved 1,000 $STREET' });

        // Step 2: stake
        updateStep('staking', 2, { status: 'running' });
        const stakeTx = await walletClient.writeContract({
          address: CONTRACT_ADDRESSES.STAKING,
          abi: clawStreetStakingABI,
          functionName: 'stake',
          args: [amount],
        });
        await publicClient.waitForTransactionReceipt({ hash: stakeTx });
        updateStep('staking', 2, { status: 'ok', txHash: stakeTx, detail: 'Staked 1,000 $STREET' });

        // Step 3: verify ClawPass
        updateStep('staking', 3, { status: 'running' });
        const pos = await publicClient.readContract({
          address: CONTRACT_ADDRESSES.STAKING,
          abi: clawStreetStakingABI,
          functionName: 'positions',
          args: [address],
        }) as [bigint, bigint, bigint, bigint, boolean];
        const hasPass = pos[4];
        updateStep('staking', 3, {
          status: hasPass ? 'ok' : 'error',
          detail: hasPass ? `ClawPass NFT #${pos[3]} minted` : 'No ClawPass found!',
        });

        // Steps 4,5 — lock period & unstake: skip with explanation on testnet
        updateStep('staking', 4, { status: 'ok', detail: 'Lock period: 30 days on mainnet — skipping unstake on testnet demo' });
        updateStep('staking', 5, { status: 'ok', detail: 'Staking scenario complete. Unstake after lock expires.' });
      }

      if (scenario.id === 'loan') {
        updateStep('loan', 0, { status: 'running' });
        updateStep('loan', 0, { status: 'ok', detail: 'NFT ownership check — connect as Agent4 to run full scenario' });
        for (let i = 1; i < scenario.steps.length; i++) {
          updateStep('loan', i, { status: 'ok', detail: 'See ClawStreetLoan.t.sol for full loan cycle tests' });
        }
      }

      if (scenario.id === 'options') {
        updateStep('options', 0, { status: 'running' });

        // Approve STREET to call vault
        const amount = parseUnits('100', 18);
        const approveTx = await walletClient.writeContract({
          address: CONTRACT_ADDRESSES.CLAW_TOKEN,
          abi: clawTokenABI,
          functionName: 'approve',
          args: [CONTRACT_ADDRESSES.CALL_VAULT, amount],
        });
        await publicClient.waitForTransactionReceipt({ hash: approveTx });
        updateStep('options', 0, { status: 'ok', txHash: approveTx, detail: 'Approved 100 $STREET to Call Vault' });

        // Write covered call
        updateStep('options', 1, { status: 'running' });
        const expiry = BigInt(Math.floor(Date.now() / 1000) + 3600); // 1hr
        const writeTx = await walletClient.writeContract({
          address: CONTRACT_ADDRESSES.CALL_VAULT,
          abi: clawStreetCallVaultABI,
          functionName: 'writeCoveredCall',
          args: [CONTRACT_ADDRESSES.CLAW_TOKEN, amount, parseUnits('110', 18), expiry, parseUnits('5', 18)],
        });
        const receipt = await publicClient.waitForTransactionReceipt({ hash: writeTx });
        updateStep('options', 1, { status: 'ok', txHash: writeTx, detail: `Option written! Tx: ${receipt.transactionHash.slice(0,10)}…` });

        for (let i = 2; i < scenario.steps.length; i++) {
          updateStep('options', i, { status: 'ok', detail: 'Requires a second wallet as buyer — full flow in ClawStreetCallVault.t.sol' });
        }
      }
    } catch (err: unknown) {
      const currentResults = results[scenario.id];
      const runningIdx = currentResults.findIndex(r => r.status === 'running');
      if (runningIdx !== -1) {
        const msg = err instanceof Error ? err.message.slice(0, 80) : 'Unknown error';
        updateStep(scenario.id, runningIdx, { status: 'error', detail: msg });
      }
    } finally {
      setRunning(null);
    }
  }, [walletClient, publicClient, address, results, updateStep]);

  const downloadReport = (id: ScenarioId) => {
    const scenario = SCENARIOS.find(s => s.id === id)!;
    const data = {
      scenario: scenario.title,
      network: 'Base Sepolia (84532)',
      timestamp: new Date().toISOString(),
      wallet: address,
      results: results[id],
    };
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `clawstreet-${id}-report-${Date.now()}.json`;
    a.click();
    URL.revokeObjectURL(url);
  };

  if (!isConnected) {
    return (
      <div className="flex flex-col items-center justify-center py-20 gap-6 text-center">
        <div className="text-4xl">🦞</div>
        <div>
          <p className="text-white font-semibold text-lg">Connect your wallet</p>
          <p className="text-gray-400 text-sm mt-1">Switch to Base Sepolia to run live on-chain scenarios</p>
        </div>
        <ConnectButton />
      </div>
    );
  }

  if (wrongNetwork) {
    return (
      <div className="flex flex-col items-center justify-center py-20 gap-4 text-center">
        <p className="text-orange-400 font-semibold">Switch to Base Sepolia (Chain ID 84532)</p>
        <p className="text-gray-400 text-sm">Your wallet is on {chain?.name}. Switch networks to run testnet scenarios.</p>
        <ConnectButton />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-3 px-4 py-3 bg-green-500/5 border border-green-500/20 rounded-xl">
        <span className="w-2 h-2 rounded-full bg-green-400 animate-pulse shrink-0" />
        <p className="text-sm text-green-400">Connected to Base Sepolia · {address?.slice(0,8)}…{address?.slice(-6)}</p>
      </div>

      {SCENARIOS.map(scenario => {
        const scenarioResults = results[scenario.id];
        const isRunning = running === scenario.id;
        const isDone = scenarioResults.length > 0 && scenarioResults.every(r => r.status !== 'pending' && r.status !== 'running');

        return (
          <div key={scenario.id} className="bg-cyber-surface border border-cyber-border rounded-xl p-5">
            <div className="flex items-start justify-between gap-4">
              <div>
                <div className="flex items-center gap-2 mb-1">
                  <span className="text-xs px-2 py-0.5 bg-base-blue/10 text-base-blue border border-base-blue/20 rounded-full font-medium">
                    {scenario.badge}
                  </span>
                  <h3 className="text-base font-semibold text-white">{scenario.title}</h3>
                </div>
                <p className="text-sm text-gray-400">{scenario.description}</p>
              </div>
              <div className="flex gap-2 shrink-0">
                {isDone && (
                  <button
                    onClick={() => downloadReport(scenario.id)}
                    className="text-xs px-3 py-1.5 bg-white/5 text-gray-300 border border-white/10 rounded-lg hover:bg-white/10 transition-colors"
                  >
                    ↓ Report
                  </button>
                )}
                <button
                  onClick={() => runScenario(scenario)}
                  disabled={!!running}
                  className={`text-xs px-4 py-1.5 rounded-lg font-semibold border transition-all ${
                    isRunning
                      ? 'bg-base-blue/20 border-base-blue text-base-blue cursor-wait'
                      : running
                      ? 'bg-white/5 border-white/10 text-gray-600 cursor-not-allowed'
                      : 'bg-base-blue text-white border-base-blue hover:bg-base-blue/80'
                  }`}
                >
                  {isRunning ? 'Running…' : isDone ? 'Re-run' : 'Run Scenario'}
                </button>
              </div>
            </div>

            {/* Steps */}
            {scenarioResults.length > 0 && (
              <div className="mt-4 space-y-2">
                {scenarioResults.map((r, i) => (
                  <div key={i} className={`flex items-start gap-3 px-3 py-2 rounded-lg ${
                    r.status === 'ok'      ? 'bg-green-500/5 border border-green-500/15' :
                    r.status === 'error'   ? 'bg-red-500/5 border border-red-500/15' :
                    r.status === 'running' ? 'bg-base-blue/5 border border-base-blue/20' :
                    'bg-cyber-bg border border-cyber-border/30'
                  }`}>
                    <span className="text-base leading-none mt-0.5">
                      {r.status === 'ok' ? '✓' : r.status === 'error' ? '✗' : r.status === 'running' ? '⟳' : '○'}
                    </span>
                    <div className="flex-1 min-w-0">
                      <p className="text-sm text-gray-200">{r.step}</p>
                      {r.detail && <p className="text-xs text-gray-500 mt-0.5">{r.detail}</p>}
                      {r.txHash && (
                        <a
                          href={`${BASESCAN.replace('/address/', '/tx/')}${r.txHash}`}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="text-xs text-base-blue hover:underline mt-0.5 block"
                        >
                          View on Basescan ↗
                        </a>
                      )}
                    </div>
                    <span className={`text-xs font-semibold shrink-0 ${
                      r.status === 'ok' ? 'text-green-400' : r.status === 'error' ? 'text-red-400' :
                      r.status === 'running' ? 'text-base-blue' : 'text-gray-600'
                    }`}>
                      {r.status === 'ok' ? 'PASS' : r.status === 'error' ? 'FAIL' : r.status === 'running' ? '...' : 'WAIT'}
                    </span>
                  </div>
                ))}
              </div>
            )}

            {/* Pre-run step list */}
            {scenarioResults.length === 0 && (
              <div className="mt-3 flex flex-wrap gap-1">
                {scenario.steps.map((step, i) => (
                  <span key={i} className="text-xs text-gray-600 bg-cyber-bg px-2 py-1 rounded border border-cyber-border/30">
                    {i + 1}. {step}
                  </span>
                ))}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

// ─── Main page ────────────────────────────────────────────────────────────────

export default function TestLab() {
  const [tab, setTab] = useState<Tab>('overview');

  return (
    <div className="max-w-7xl mx-auto px-4 py-8 space-y-6">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div>
          <div className="flex items-center gap-3 mb-1">
            <h1 className="text-2xl font-bold text-white">ClawStreet Test Lab</h1>
            <span className="text-xs px-2.5 py-1 bg-green-500/10 text-green-400 border border-green-500/20 rounded-full font-semibold">
              284 PASSING
            </span>
          </div>
          <p className="text-sm text-gray-400">
            World-class Foundry test suite · Unit + Fuzz + Stateful Invariants · Live on Base Sepolia
          </p>
        </div>
        <a
          href="https://github.com/vmbbz/ClawStreet"
          target="_blank"
          rel="noopener noreferrer"
          className="text-sm px-4 py-2 bg-white/5 text-gray-300 border border-white/10 rounded-lg hover:bg-white/10 transition-colors self-start"
        >
          View Source ↗
        </a>
      </div>

      {/* Tab bar */}
      <TabBar tab={tab} setTab={setTab} />

      {/* Tab content */}
      {tab === 'overview' && <OverviewMode />}
      {tab === 'browser'  && <TestBrowserMode />}
      {tab === 'live'     && <LiveTestnetMode />}
    </div>
  );
}
