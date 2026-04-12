# ClawStreet — Testing Guide

**Protocol:** ClawStreet DeFi Infrastructure
**Network:** Base Sepolia (testnet)
**Framework:** Foundry (forge)
**Test suite:** 284 tests across 10 files (271 unit/fuzz + 13 stateful invariants)
**Coverage:** ClawToken, Staking, Loan Engine, Call Vault, Bundle Vault

---

## Test Suite Summary

| File | Tests | Type |
|------|-------|------|
| `test/ClawToken.t.sol` | 39 | Unit + fuzz |
| `test/ClawStreetStaking.t.sol` | 53 | Unit + fuzz |
| `test/ClawStreetStaking.edge.t.sol` | 8 | Edge + fuzz |
| `test/ClawStreetLoan.t.sol` | 78 | Unit + fuzz |
| `test/ClawStreetLoan.edge.t.sol` | 12 | Edge + integration + fuzz |
| `test/ClawStreetCallVault.t.sol` | 59 | Unit |
| `test/ClawStreetCallVault.edge.t.sol` | 9 | Edge + fuzz |
| `test/ClawStreetBundleVault.t.sol` | 13 | Unit |
| `test/invariants/StakingInvariant.t.sol` | 7 | Stateful invariant (128k calls each) |
| `test/invariants/CallVaultInvariant.t.sol` | 6 | Stateful invariant (128k calls each) |
| **Total** | **284** | |

---

## Table of Contents

1. [Prerequisites](#1-prerequisites)
2. [Project Structure](#2-project-structure)
3. [Running Tests](#3-running-tests)
4. [Test File Reference](#4-test-file-reference)
5. [Audit Findings & Coverage](#5-audit-findings--coverage)
6. [Fuzz Testing](#6-fuzz-testing)
7. [Invariant Testing](#7-invariant-testing)
8. [Automated Run Script](#8-automated-run-script)
9. [Testnet Setup](#9-testnet-setup)
10. [Agent Wallet Setup](#10-agent-wallet-setup)
11. [Admin Dashboard](#11-admin-dashboard)
12. [Troubleshooting](#12-troubleshooting)

---

## 1. Prerequisites

### Required tools

| Tool | Version | Install |
|------|---------|---------|
| Foundry | latest | `curl -L https://foundry.paradigm.xyz \| bash && foundryup` |
| Git | any | system |
| Bash | any | system (WSL on Windows) |

### Verify installation

```bash
forge --version
# forge 0.2.0 (or newer)

cast --version
# cast 0.2.0 (or newer)
```

### Install dependencies

```bash
git clone <repo>
cd ClawStreet
forge install
```

---

## 2. Project Structure

```
ClawStreet/
├── contracts/                    # Production contracts
│   ├── ClawToken.sol             # $CLAW ERC-20, 100M cap
│   ├── ClawStreetStaking.sol     # Stake CLAW → ClawPass NFT + USDC revenue
│   ├── ClawStreetLoan.sol        # NFT-collateralised loans, Pyth oracle
│   ├── ClawStreetCallVault.sol   # Covered call options on ERC-20s
│   └── ClawStreetBundleVault.sol # Bundle ERC-20s + ERC-721s into one NFT
│
├── test/                         # Test files
│   ├── ClawToken.t.sol           # Core token tests (happy path)
│   ├── ClawStreetStaking.t.sol   # Staking happy path
│   ├── ClawStreetLoan.t.sol      # Loan happy path
│   ├── ClawStreetCallVault.t.sol # Call vault happy path
│   ├── ClawStreetStaking.edge.t.sol   # Staking edge cases + fuzz
│   ├── ClawStreetLoan.edge.t.sol      # Loan edge cases + fuzz + integration
│   ├── ClawStreetCallVault.edge.t.sol # Call vault edge cases + fuzz
│   └── ClawStreetBundleVault.t.sol    # Bundle vault full suite (new)
│
├── script/
│   ├── DeployClawStreet.s.sol    # Full protocol deploy
│   └── DeployMockNFT.s.sol       # Deploy test NFT for Base Sepolia
│
├── config/
│   └── base-sepolia.json         # Testnet addresses (tokens, oracles, agents)
│
├── scripts/
│   ├── run-tests.sh              # Automated test runner with logging
│   └── setup-agent-wallets.sh    # Generate 5 agent wallets for Base Sepolia
│
├── logs/                         # Auto-created by run-tests.sh
│   └── test-run-<timestamp>.log  # Timestamped test output
│
└── docs/
    └── TESTING.md                # This file
```

---

## 3. Running Tests

### Basic run — all tests, summary output

```bash
forge test
```

**Output:**
```
Ran 10 test suites in 292.67s: 284 tests passed, 0 failed, 0 skipped (284 total tests)
```

---

### Verbose modes

Each `-v` flag adds one level of detail:

```bash
# -v : show each test name
forge test -v

# -vv : + revert reasons and assertion failures
forge test -vv

# -vvv : + full call traces on failures
forge test -vvv

# -vvvv : + every internal call, storage read/write (very noisy — use on one test)
forge test -vvvv
```

**Recommendation:** use `-vv` for day-to-day runs, `-vvvv` only when debugging a specific failure.

---

### Filter by test name

Run a single test by name (partial match works):

```bash
forge test --match-test test_feeForwarding_toStakingContract -vvvv
```

Run all tests in one file:

```bash
forge test --match-path test/ClawStreetLoan.edge.t.sol -vv
```

Run all tests in one contract:

```bash
forge test --match-contract ClawStreetLoanEdgeTest -vv
```

---

### Gas report

Shows gas cost for every function called during tests:

```bash
forge test --gas-report
```

**Example output:**
```
╭─────────────────────────────────┬─────────────────┬───────┬────────┬───────┬─────────╮
│ ClawStreetLoan contract          │ Deployment Cost │ Min   │ Mean   │ Max   │ # Calls │
├─────────────────────────────────┼─────────────────┼───────┼────────┼───────┼─────────┤
│ acceptLoan                       │                 │ 85341 │ 95210  │ 99842 │ 18      │
│ createLoanOffer                  │                 │ 61200 │ 70412  │ 75930 │ 22      │
│ repayLoan                        │                 │ 42100 │ 55000  │ 60100 │ 10      │
╰─────────────────────────────────┴─────────────────┴───────┴────────┴───────┴─────────╯
```

---

### JSON output (for tooling / CI)

```bash
forge test --json | jq '.[] | {name: .name, status: .status}'
```

---

## 4. Test File Reference

### `test/ClawToken.t.sol`

Tests the `$CLAW` ERC-20 token.

| Test | What it checks |
|------|---------------|
| `test_maxSupply` | MAX_SUPPLY == 100,000,000 CLAW |
| `test_initialSupply_isZero` | starts at 0 |
| `test_mint_byOwner` | owner can mint, balance updates |
| `test_mint_revertsWhenCapExceeded` | revert on mint past cap |
| `test_mint_revertsIfNotOwner` | non-owner cannot mint |
| `test_burn_reducesSupply` | burn decreases supply |
| `test_burn_revertsInsufficientBalance` | revert if balance too low |
| `test_transfer` | standard ERC-20 transfer |
| `test_approve_and_transferFrom` | approval + delegated transfer |
| `test_nameAndSymbol` | name="ClawStreet", symbol="CLAW", decimals=18 |

```bash
forge test --match-contract ClawTokenTest -vv
```

---

### `test/ClawStreetStaking.t.sol`

Happy-path staking flows.

| Test | What it checks |
|------|---------------|
| `test_stake_mintsClawPass` | staking mints a ClawPass NFT |
| `test_stake_topUp_restartsLock` | top-up resets the 30-day lock |
| `test_stake_onlyOneCLawPass` | one NFT per staker (no duplicates) |
| `test_stake_revertsZero` | cannot stake 0 |
| `test_unstake_afterLock` | CLAW returned after 30 days |
| `test_unstake_revertsBeforeLock` | reverts 1 second early |
| `test_unstake_revertsNothingStaked` | reverts if no position |
| `test_notifyFee_revertsUnauthorised` | only whitelisted callers |
| `test_revenueShare_singleStaker` | single staker gets 100% of fee |
| `test_revenueShare_twoStakers_proportional` | 25%/75% split on 1000/3000 stakes |
| `test_claimRevenue_transfersUSDC` | claim transfers USDC to staker |
| `test_clawPass_nonTransferable` | soul-bound — transferFrom reverts |

```bash
forge test --match-contract ClawStreetStakingTest -vv
```

---

### `test/ClawStreetStaking.edge.t.sol`

Edge cases and audit findings for staking.

| Test | What it checks |
|------|---------------|
| `test_noStakers_feesGoToUnallocated_distributedOnNextNotify` | fees before first staker are held and distributed when stakers arrive |
| `test_lateJoiner_doesNotEarnPreviousFees` | Bob stakes after fee1 — only earns his share of fee2 |
| `test_multipleFeeBatches` | 3 sequential fee notifications accumulate correctly |
| `test_claimRevenue_idempotent` | claiming twice — second call sends 0 USDC |
| `test_unstake_exactlyAtLockBoundary` | unstake at exactly `stakedAt + 30 days` succeeds |
| `test_rewardDebt_resetOnTopUp` | top-up settles pending first, then resets debt |
| `test_clawPass_approve_reverts` | `approve()` and `setApprovalForAll()` both revert |
| `testFuzz_revenueShare_proportional` | fuzz: no inflation, ordering invariant holds |

```bash
forge test --match-contract ClawStreetStakingEdgeTest -vv
```

---

### `test/ClawStreetLoan.t.sol`

Happy-path loan lifecycle.

| Test | What it checks |
|------|---------------|
| `test_createLoanOffer_escrowsNFT` | NFT transferred to contract on offer |
| `test_createLoanOffer_revertsZeroPrincipal` | principal must be > 0 |
| `test_cancelLoanOffer_returnsNFT` | cancel returns NFT to borrower |
| `test_cancelLoanOffer_revertsIfNotBorrower` | only borrower can cancel |
| `test_acceptLoan_transfersPrincipal` | lender funds, borrower receives net principal |
| `test_acceptLoan_setsLender` | lender address recorded on loan |
| `test_acceptLoan_revertsIfFunded` | cannot fund an already-funded loan |
| `test_repayLoan_returnsNFT` | repayment returns NFT to borrower |
| `test_repayLoan_transfersToLender` | lender receives principal + interest |
| `test_claimDefault_lenderGetsNFT` | lender claims NFT after expiry |
| `test_claimDefault_revertsBeforeExpiry` | cannot default before duration |
| `test_withdrawFees_adminSweepsFees` | admin can sweep stuck fees |
| `test_withdrawFees_revertsIfNotAdmin` | only admin role |
| `test_pause_blocksOffers` | paused state blocks createLoanOffer |

```bash
forge test --match-contract ClawStreetLoanTest -vv
```

---

### `test/ClawStreetLoan.edge.t.sol`

Edge cases, security scenarios, and full integration test.

| Test | What it checks |
|------|---------------|
| `test_repayLoan_lenderTriggersRepayment` | lender calling repayLoan now reverts (fixed) |
| `test_claimDefault_onUnfundedLoan_reverts` | claimDefault with no lender reverts |
| `test_healthScore_exactlyAt50pctLTV` | LTV at 5000 bps → score = 100 (no penalty) |
| `test_healthScore_slightlyOver50pct` | LTV at 5100 bps → score = 98 (penalty = 2) |
| `test_healthScore_reputationBoostHighScore` | reputation > 800 → 1.10× multiplier |
| `test_healthScore_reputationPenaltyLowScore` | reputation < 500 → 0.90× multiplier |
| `test_feeForwarding_toStakingContract` | **integration:** full borrow/lend flow, fee flows to staking, staker claims USDC |
| `test_shortDuration_oneSec` | 1-second duration reverts (MIN_DURATION = 1 hour) |
| `test_shortDuration_oneHour_succeeds` | exactly 1-hour duration succeeds |
| `test_multipleLoans_sameNFT_contract` | same NFT reusable after cancel |
| `test_acceptLoan_refundsExcessEth` | excess ETH sent for Pyth update is refunded |
| `testFuzz_loanLifecycle` | fuzz: full create → accept → repay lifecycle |

```bash
forge test --match-contract ClawStreetLoanEdgeTest -vv
```

**The integration test** (`test_feeForwarding_toStakingContract`) is the most important end-to-end test. It:
1. Deploys `ClawToken` + `ClawStreetStaking` + `ClawStreetLoan`
2. Wires them together (`setStakingContract`, `setFeeNotifier`)
3. Alice stakes CLAW
4. Bob provides an NFT and creates a loan offer
5. Charlie accepts the loan (triggers 1% broker fee)
6. Verifies the fee flows from Loan → Staking
7. Verifies Alice can claim the USDC revenue

---

### `test/ClawStreetCallVault.t.sol` + `test/ClawStreetCallVault.edge.t.sol`

Options vault tests.

**Happy path:**

| Test | What it checks |
|------|---------------|
| `test_write_locksUnderlying` | writer deposits underlying, option created |
| `test_write_revertsExpiredExpiry` | past expiry rejected |
| `test_write_revertsZeroAmount` | zero amount rejected |
| `test_cancel_returnsUnderlying` | cancel before purchase returns asset |
| `test_cancel_revertsIfNotWriter` | only writer can cancel |
| `test_cancel_revertsIfBought` | cannot cancel purchased option |
| `test_buy_transfersPremiumToWriter` | premium paid to writer on buy |
| `test_buy_revertsIfAlreadyBought` | cannot buy twice |
| `test_buy_revertsIfExpired` | cannot buy expired option |
| `test_exercise_buyerReceivesUnderlying` | exercise delivers underlying to buyer |
| `test_exercise_writerReceivesStrike` | exercise pays strike to writer |
| `test_exercise_revertsIfExpired` | cannot exercise after expiry |
| `test_exercise_revertsIfNotBuyer` | only buyer can exercise |
| `test_reclaim_afterExpiry` | writer reclaims if not exercised |
| `test_reclaim_revertsBeforeExpiry` | cannot reclaim early |
| `test_reclaim_revertsIfExercised` | cannot reclaim already-exercised option |

**Edge cases (post-audit):**

| Test | What it checks |
|------|---------------|
| `test_zeroPremium_writeAndBuy` | `writeCoveredCall` now reverts on zero premium |
| `test_zeroStrike_exercise` | `writeCoveredCall` now reverts on zero strike |
| `test_exercise_atExactExpiry` | exercise at exactly expiry timestamp now reverts |
| `test_buyOption_atExactExpiry_reverts` | buy at exactly expiry reverts |
| `test_cancelOption_afterExpiry_unbought` | writer cancels unbought expired option |
| `test_reclaimUnderlying_unboughtExpiredOption` | reclaim on option that was never bought |
| `test_multipleOptions_sameWriter` | 3 independent options from same writer |
| `test_exercise_afterExercise_reverts` | double-exercise reverts |
| `testFuzz_optionLifecycle` | fuzz: full write → buy → exercise lifecycle |

```bash
forge test --match-contract ClawStreetCallVault -vv
```

---

### `test/ClawStreetBundleVault.t.sol`

Full test suite for Bundle Vault (no prior tests existed).

| Test | What it checks |
|------|---------------|
| `test_depositBundle_erc20Only` | deposit 2 ERC-20s, NFT minted |
| `test_depositBundle_erc721Only` | deposit 2 ERC-721s, NFT minted |
| `test_depositBundle_mixed` | mixed ERC-20s and ERC-721s |
| `test_depositBundle_empty` | empty bundle now reverts ("Bundle cannot be empty") |
| `test_depositBundle_lengthMismatch_erc20_reverts` | array length mismatch reverts |
| `test_depositBundle_lengthMismatch_erc721_reverts` | array length mismatch reverts |
| `test_withdrawBundle_returnsAllAssets` | all assets returned on withdrawal |
| `test_withdrawBundle_burnsNFT` | bundle NFT burned after withdrawal |
| `test_withdrawBundle_nonOwner_reverts` | only NFT owner can withdraw |
| `test_bundleNFT_isTransferable` | bundle NFT can be transferred (unlike ClawPass) |
| `test_getBundleContent` | view returns correct asset arrays |
| `test_multipleDeposits_independentTokenIds` | token IDs 0 and 1 are independent |
| `test_withdrawBundle_clearsContent` | content deleted after withdrawal |

```bash
forge test --match-contract ClawStreetBundleVaultTest -vv
```

---

## 5. Audit Findings & Coverage

All 12 audit findings from the internal security review are covered by tests. Each finding was fixed in the contract and the test was updated to verify the correct (fixed) behaviour.

### Critical / High

| ID | Contract | Finding | Status | Test |
|----|----------|---------|--------|------|
| H-1 | BundleVault | `withdrawBundle` has no reentrancy guard | **Fixed** — `nonReentrant` added | `test_withdrawBundle_returnsAllAssets` |

### Medium

| ID | Contract | Finding | Status | Test |
|----|----------|---------|--------|------|
| M-1 | Staking | `notifyFee` when `totalStaked == 0` — USDC permanently stuck | **Fixed** — `unallocatedFees` accumulator + owner escape-hatch | `test_noStakers_feesGoToUnallocated_distributedOnNextNotify` |
| M-2 | Loan | `repayLoan` pulled from `loan.borrower` even when called by lender | **Fixed** — restricted to `msg.sender == loan.borrower` | `test_repayLoan_lenderTriggersRepayment` (now tests revert) |
| M-3 | Loan | `claimDefault` on unfunded loan sends NFT to `address(0)` | **Fixed** — `require(loan.lender != address(0))` added | `test_claimDefault_onUnfundedLoan_reverts` |
| M-4 | BundleVault | `depositBundle` has no reentrancy guard | **Fixed** — `nonReentrant` added | `test_depositBundle_mixed` |

### Low

| ID | Contract | Finding | Status | Test |
|----|----------|---------|--------|------|
| L-1 | Staking | `approve()` / `setApprovalForAll()` not blocked on soul-bound NFT | **Fixed** — both override to revert | `test_clawPass_approve_reverts` |
| L-2 | Loan | No minimum loan duration (1-second loans accepted) | **Fixed** — `MIN_DURATION = 1 hours` | `test_shortDuration_oneSec` / `test_shortDuration_oneHour_succeeds` |
| L-3 | CallVault | Zero-strike options allowed (buyer exercises for free) | **Fixed** — `require(strike > 0)` | `test_zeroStrike_exercise` |
| L-4 | CallVault | Zero-premium options allowed (writer earns nothing) | **Fixed** — `require(premium > 0)` | `test_zeroPremium_writeAndBuy` |
| L-5 | CallVault | `exercise` expiry check was `<=` (inclusive), `buyOption` was `<` | **Fixed** — both now strict `<` | `test_exercise_atExactExpiry` |
| L-6 | BundleVault | ERC-20 `transfer` return value unchecked in `withdrawBundle` | **Fixed** — `SafeERC20.safeTransfer` | `test_withdrawBundle_returnsAllAssets` |
| L-7 | BundleVault | Empty bundle deposit mints NFT representing nothing | **Fixed** — `require(length > 0)` | `test_depositBundle_empty` |

---

## 6. Fuzz Testing

Fuzz tests run your functions with automatically generated random inputs to find edge cases that unit tests miss.

### Run fuzz tests (default 256 runs)

```bash
forge test --match-test "^testFuzz_" -vv
```

### Run with more iterations (higher confidence)

```bash
# 1000 runs — recommended before any deployment
forge test --match-test "^testFuzz_" --fuzz-runs 1000 -vv

# 10,000 runs — thorough pre-audit sweep (slower)
forge test --match-test "^testFuzz_" --fuzz-runs 10000 -v
```

### Available fuzz tests

| Test | Contract | What it fuzzes | Key invariants |
|------|----------|----------------|----------------|
| `testFuzz_revenueShare_proportional` | Staking | `aliceStake`, `bobStake`, `fee` (all random) | No inflation: `alicePending + bobPending ≤ fee`. Larger stake → larger or equal share. |
| `testFuzz_loanLifecycle` | Loan | `principal`, `interest`, `duration` | Full create → accept → repay lifecycle never breaks with valid inputs |
| `testFuzz_optionLifecycle` | CallVault | `amount`, `strike`, `premium`, `expiryDelta` | Full write → buy → exercise lifecycle with random parameters |

### Reading fuzz output

A passing fuzz run looks like:

```
[PASS] testFuzz_loanLifecycle(uint128,uint128,uint32)
  (runs: 1000, μ: 434092, ~: 438587)
```

- `runs: 1000` — number of random inputs tested
- `μ` — mean gas used
- `~` — median gas used

A failure shows the **counterexample** — the exact inputs that broke the invariant:

```
[FAIL] testFuzz_revenueShare_proportional
  counterexample: args=[1926448792... , 59871225..., 10791676...]
```

You can reproduce any counterexample deterministically:

```bash
forge test --match-test testFuzz_revenueShare_proportional \
  --fuzz-seed 0xDEADBEEF -vvvv
```

---

## 7. Invariant Testing

Invariant (stateful property-based) tests use a **Handler** pattern: Foundry calls random sequences of contract functions and after every call checks that core protocol invariants still hold. Each invariant ran **128,000 calls** (256 runs × 500 calls each) with 0 reverts and 0 failures.

### Run invariant tests

```bash
forge test --match-path "test/invariants/**" -v
```

### Staking Invariants (`StakingInvariant.t.sol`)

| Invariant | What it proves |
|-----------|---------------|
| `invariant_totalStaked_equalsPositionSum` | `totalStaked` always equals the sum of every actor's `position.staked` — no hidden minting or burning |
| `invariant_ghostTotalStaked_matchesOnChain` | Internal ghost tracker agrees with on-chain state |
| `invariant_noInflation_usdcGeqPending` | USDC held by contract ≥ sum of all pending claims — the contract can never over-promise |
| `invariant_hasPass_iff_staked` | A ClawPass NFT exists if and only if the staker has a non-zero position |
| `invariant_nftOwner_matchesStaker` | On-chain NFT ownership always matches the staker's address |
| `invariant_rewardDebt_leq_accumulator` | A staker's reward debt can never exceed the global accumulator (no earning from the future) |
| `invariant_unallocatedFees_leq_usdcBalance` | Unallocated fees never exceed the contract's USDC balance |

### Call Vault Invariants (`CallVaultInvariant.t.sol`)

| Invariant | What it proves |
|-----------|---------------|
| `invariant_vaultUnderlyingGeqActiveLocked` | Vault's underlying balance ≥ sum of all active option collateral |
| `invariant_ghostLocked_matchesVaultBalance` | Ghost tracker exactly matches actual vault balance (no leaks) |
| `invariant_exercised_implies_notActive` | An exercised option is always marked inactive |
| `invariant_activeOption_hasExpiry` | Every active option has a non-zero expiry |
| `invariant_optionCounter_monotonic` | Option IDs only ever increase — no counter resets |
| `invariant_cancelOnlyBeforeBuy` | `isCancelled` and `isBought` are mutually exclusive |

---

## 8. Automated Run Script

The run script executes the full suite, runs fuzz tests at 1000 iterations, prints the audit summary, and saves a timestamped log.

### Usage

```bash
# Foreground — watch it run
bash scripts/run-tests.sh

# Background — come back to results later
bash scripts/run-tests.sh &

# Monitor background job
tail -f logs/test-run-<timestamp>.log
```

### What it does

1. Creates `logs/` directory if it doesn't exist
2. Runs `forge test -vv` — all 94 tests
3. Runs `forge test --fuzz-runs 1000 --match-test "^testFuzz_"` — fuzz suite
4. Prints pass/fail counts for each run
5. Prints the full audit summary (findings + test mapping)
6. Exits with code `0` if all pass, `1` if any fail

### Example output

```
=================================================================
  ClawStreet Test Runner — Fri Apr 11 00:28:42 2026
  Log: /path/to/logs/test-run-20260411_002842.log
=================================================================

--- [1/2] Standard test suite (forge test -vv) ---
...
Ran 8 test suites: 94 tests passed, 0 failed, 0 skipped
Standard suite result: PASS

--- [2/2] Fuzz tests (forge test --fuzz-runs 1000 -vv) ---
...
Ran 3 test suites: 3 tests passed, 0 failed, 0 skipped
Fuzz suite result: PASS

=================================================================
  RESULT: ALL TESTS PASSED
  Standard: PASS  |  Fuzz: PASS
  Full log: /path/to/logs/test-run-20260411_002842.log
=================================================================
```

### Schedule it (run every hour unattended)

On Linux/Mac (cron):
```bash
# Edit crontab
crontab -e

# Add line — runs every hour, appends to a master log
0 * * * * cd /path/to/ClawStreet && bash scripts/run-tests.sh >> logs/scheduled.log 2>&1
```

On Windows (Task Scheduler via WSL):
```bash
# From WSL terminal
(crontab -l 2>/dev/null; echo "0 * * * * cd /mnt/c/Users/cosyc/ClawStreet && bash scripts/run-tests.sh >> logs/scheduled.log 2>&1") | crontab -
```

---

## 8. Testnet Setup

All Base Sepolia addresses are in [`config/base-sepolia.json`](../config/base-sepolia.json).

### Pre-filled addresses

| Asset | Address | Source |
|-------|---------|--------|
| USDC (Base Sepolia) | `0x036CbD53842c5426634e7929541eC2318f3dCF7e` | Circle official |
| WETH | `0x4200000000000000000000000000000000000006` | Base canonical |
| Pyth Oracle | `0xA2aa501b19aff244D90cc15a4Cf739D2725B5729` | Pyth official |
| ETH/USD feed | `0xff61491a931112ddf1bd8147cd1b641375f79f5825126d665480874634fd0ace` | Pyth |

### Deploy contracts to Base Sepolia

```bash
# Set your deployer key
export PRIVATE_KEY=0x<your-private-key>
export RPC_URL=https://sepolia.base.org

# Deploy full protocol
forge script script/DeployClawStreet.s.sol \
  --rpc-url $RPC_URL \
  --broadcast \
  --verify

# Deploy test NFT (for loan collateral testing)
forge script script/DeployMockNFT.s.sol \
  --rpc-url $RPC_URL \
  --broadcast
```

After deployment, paste the output addresses into:
- `config/base-sepolia.json` → `deployedContracts`
- `src/config/contracts.ts` → `CONTRACT_ADDRESSES` (activates the frontend)

### Faucets

| Asset | Faucet |
|-------|--------|
| Base Sepolia ETH | https://www.coinbase.com/faucets/base-ethereum-goerli-faucet |
| Testnet USDC | https://faucet.circle.com (select "Base Sepolia") |

### Interact via `cast` (CLI)

```bash
export RPC=https://sepolia.base.org
export LOAN=<deployed-loan-address>
export KEY=0x<your-private-key>

# Read loan count
cast call $LOAN "loanCounter()" --rpc-url $RPC

# Read health score
cast call $LOAN \
  "getHealthScore(address,uint256,uint256,address)(uint256)" \
  <nft-contract> <nft-id> <principal-in-usdc-units> <borrower> \
  --rpc-url $RPC

# Pause the loan contract (admin only)
cast send $LOAN "pause()" --private-key $KEY --rpc-url $RPC

# Unpause
cast send $LOAN "unpause()" --private-key $KEY --rpc-url $RPC
```

---

## 9. Agent Wallet Setup

For testnet simulation with multiple AI agents, each needs its own funded wallet.

### Generate 5 agent wallets

```bash
bash scripts/setup-agent-wallets.sh
```

This creates `.env.agents` containing:

```
AGENT1_NAME=LiquidityAgent_Alpha
AGENT1_ADDRESS=0x...
AGENT1_PRIVATE_KEY=0x...

AGENT2_NAME=ArbitrageAgent_Beta
AGENT2_ADDRESS=0x...
AGENT2_PRIVATE_KEY=0x...
# ... etc
```

> **Security:** `.env.agents` is automatically added to `.gitignore`. Never commit it.

### Fund each agent

1. Copy each `AGENT_ADDRESS` from `.env.agents`
2. Get ETH from the faucet: https://www.coinbase.com/faucets/base-ethereum-goerli-faucet
3. Get USDC from the faucet: https://faucet.circle.com
4. Paste addresses into `config/base-sepolia.json` → `agents`

### Verify balances

```bash
export RPC=https://sepolia.base.org
source .env.agents

# Check ETH balance of Agent 1
cast balance $AGENT1_ADDRESS --rpc-url $RPC

# Check USDC balance
cast call 0x036CbD53842c5426634e7929541eC2318f3dCF7e \
  "balanceOf(address)(uint256)" $AGENT1_ADDRESS \
  --rpc-url $RPC
```

### Mint test NFTs to agents

```bash
# After deploying ClawStreetTestNFT
export NFT=<deployed-nft-address>

cast send $NFT "mint(address)(uint256)" $AGENT4_ADDRESS \
  --private-key $PRIVATE_KEY \
  --rpc-url $RPC
```

---

## 10. Admin Dashboard

A live admin dashboard is available at `/admin` in the React frontend. It reads from deployed contracts in real-time via wagmi.

### Start the frontend

```bash
npm run dev
# Open http://localhost:5173/admin
```

### Dashboard panels

| Panel | What it shows |
|-------|--------------|
| **Contract Addresses** | Each contract address with a deployed/placeholder status badge |
| **Protocol Stats** | Live: total loans, options written, CLAW staked, revenue accumulator, pause state |
| **Your Position** | Connected wallet's CLAW balance, staked amount, ClawPass ID, pending USDC revenue, lock time remaining |
| **Demo Agent Wallets** | Editable registry of your 5 test agents — saved to browser localStorage |
| **Quick Commands** | One-click copy for every common forge/cast command |
| **Testnet Resources** | Direct links to explorer, faucets, Pyth, Tenderly |

### Activate live data

Once contracts are deployed, update `src/config/contracts.ts`:

```ts
export const CONTRACT_ADDRESSES = {
  LOAN_ENGINE:  '0x<real-address>' as const,
  CALL_VAULT:   '0x<real-address>' as const,
  BUNDLE_VAULT: '0x<real-address>' as const,
  CLAW_TOKEN:   '0x<real-address>' as const,
  STAKING:      '0x<real-address>' as const,
};
```

All dashboard panels will populate automatically on the next page load.

---

## 11. Troubleshooting

### `forge test` fails with "file not found"

```bash
# Re-install dependencies
forge install

# Check remappings
cat remappings.txt
```

### `forge test` fails to compile

```bash
# Verbose compiler output
forge build --force
```

Check `foundry.toml` — the project uses `via_ir = true` for stack-depth reasons in upgradeable contracts. Ensure this is present.

### Tests pass locally but a specific test fails

Run with max verbosity to see the exact revert:

```bash
forge test --match-test <failing-test-name> -vvvv 2>&1 | head -100
```

### Fuzz test finds a counterexample

The failure output includes `counterexample: args=[...]`. To reproduce:

```bash
# Use --fuzz-seed to replay the same random sequence
forge test --match-test <fuzz-test-name> --fuzz-seed <seed-from-output> -vvvv
```

### `cast` commands return hex instead of decoded values

Add the return type signature:

```bash
# Wrong — returns raw hex
cast call $LOAN "loanCounter()" --rpc-url $RPC

# Correct — decoded
cast call $LOAN "loanCounter()(uint256)" --rpc-url $RPC
```

### Agent wallet script fails

Ensure `cast` is installed (part of Foundry):

```bash
foundryup   # updates cast, forge, anvil
cast --version
```

---

## Quick Reference

```bash
# All tests, pass/fail
forge test

# All tests, verbose
forge test -vv

# One test, max detail
forge test --match-test <name> -vvvv

# One contract
forge test --match-contract <ContractName> -vv

# Gas report
forge test --gas-report

# Fuzz (1000 runs)
forge test --match-test "^testFuzz_" --fuzz-runs 1000 -vv

# Full automated run (logged)
bash scripts/run-tests.sh

# Full automated run (background)
bash scripts/run-tests.sh &

# Watch logs in real time
tail -f logs/test-run-<timestamp>.log

# Generate agent wallets
bash scripts/setup-agent-wallets.sh

# Deploy test NFT to Base Sepolia
forge script script/DeployMockNFT.s.sol --rpc-url https://sepolia.base.org --broadcast

# Deploy full protocol to Base Sepolia
forge script script/DeployClawStreet.s.sol --rpc-url https://sepolia.base.org --broadcast
```

---

*Last updated: April 2026 — ClawStreet v1 internal audit complete, 94 tests passing.*
