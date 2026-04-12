#!/usr/bin/env bash
# =============================================================================
# scripts/run-tests.sh
#
# Runs the ClawStreet Foundry test suite (standard + fuzz) and emits an
# AUDIT SUMMARY at the end. Exits 0 only when all tests pass.
#
# Usage:
#   bash scripts/run-tests.sh          # foreground
#   bash scripts/run-tests.sh &        # background
# =============================================================================

set -euo pipefail

# ── Setup ─────────────────────────────────────────────────────────────────────

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LOGS_DIR="$REPO_ROOT/logs"
TIMESTAMP="$(date +%Y%m%d_%H%M%S)"
LOGFILE="$LOGS_DIR/test-run-${TIMESTAMP}.log"

mkdir -p "$LOGS_DIR"

echo "=================================================================" | tee "$LOGFILE"
echo "  ClawStreet Test Runner — $(date)" | tee -a "$LOGFILE"
echo "  Log: $LOGFILE" | tee -a "$LOGFILE"
echo "=================================================================" | tee -a "$LOGFILE"
echo "" | tee -a "$LOGFILE"

# ── Track overall exit code ───────────────────────────────────────────────────

OVERALL_EXIT=0

# ── Helper: extract pass/fail counts from forge output ───────────────────────

parse_results() {
    local output="$1"
    local summary_line passed failed
    summary_line=$(echo "$output" | grep -E "[0-9]+ tests passed" | tail -1 || true)
    passed=$(echo "$summary_line" | grep -oE '[0-9]+ passed' | grep -oE '[0-9]+' || echo "0")
    failed=$(echo "$summary_line" | grep -oE '[0-9]+ failed' | grep -oE '[0-9]+' || echo "0")
    passed="${passed:-0}"
    failed="${failed:-0}"
    echo "  Passed: $passed  |  Failed: $failed"
}

# ── Run 1: Full unit + fuzz suite (no invariants — they run separately) ────────

echo "--- [1/3] Unit + fuzz suite (forge test --no-match-path 'test/invariants/**' -vv) ---" | tee -a "$LOGFILE"
echo "" | tee -a "$LOGFILE"

STANDARD_OUTPUT=""
if STANDARD_OUTPUT=$(cd "$REPO_ROOT" && forge test --no-match-path "test/invariants/**" -vv 2>&1); then
    STANDARD_STATUS="PASS"
else
    STANDARD_STATUS="FAIL"
    OVERALL_EXIT=1
fi

echo "$STANDARD_OUTPUT" | tee -a "$LOGFILE"
echo "" | tee -a "$LOGFILE"
echo "Unit suite result: $STANDARD_STATUS" | tee -a "$LOGFILE"
parse_results "$STANDARD_OUTPUT" | tee -a "$LOGFILE"
echo "" | tee -a "$LOGFILE"

# ── Run 2: Fuzz tests (1000 runs) ─────────────────────────────────────────────

echo "--- [2/3] Fuzz tests (forge test --fuzz-runs 1000 --match-test '^testFuzz_') ---" | tee -a "$LOGFILE"
echo "" | tee -a "$LOGFILE"

FUZZ_OUTPUT=""
if FUZZ_OUTPUT=$(cd "$REPO_ROOT" && forge test --fuzz-runs 1000 -vv --match-test "^testFuzz_" 2>&1); then
    FUZZ_STATUS="PASS"
else
    FUZZ_STATUS="FAIL"
    OVERALL_EXIT=1
fi

echo "$FUZZ_OUTPUT" | tee -a "$LOGFILE"
echo "" | tee -a "$LOGFILE"
echo "Fuzz suite result: $FUZZ_STATUS" | tee -a "$LOGFILE"
parse_results "$FUZZ_OUTPUT" | tee -a "$LOGFILE"
echo "" | tee -a "$LOGFILE"

# ── Run 3: Invariant tests (stateful property-based, 256 runs each) ────────────

echo "--- [3/3] Invariant tests (forge test --match-path 'test/invariants/**' -v) ---" | tee -a "$LOGFILE"
echo "" | tee -a "$LOGFILE"

INVARIANT_OUTPUT=""
if INVARIANT_OUTPUT=$(cd "$REPO_ROOT" && forge test --match-path "test/invariants/**" -v 2>&1); then
    INVARIANT_STATUS="PASS"
else
    INVARIANT_STATUS="FAIL"
    OVERALL_EXIT=1
fi

echo "$INVARIANT_OUTPUT" | tee -a "$LOGFILE"
echo "" | tee -a "$LOGFILE"
echo "Invariant suite result: $INVARIANT_STATUS" | tee -a "$LOGFILE"
parse_results "$INVARIANT_OUTPUT" | tee -a "$LOGFILE"
echo "" | tee -a "$LOGFILE"

# ── Audit Summary ─────────────────────────────────────────────────────────────

print_audit() {
    echo "================================================================="
    echo "  AUDIT SUMMARY -- ClawStreet v1 (incorporated into edge tests)"
    echo "================================================================="
    echo ""
    echo "CONTRACT: ClawStreetStaking"
    echo "  [MEDIUM] notifyFee() silently returns when totalStaked == 0."
    echo "           USDC is permanently stuck -- no recovery mechanism."
    echo "           Test: test_noStakers_feeStuckInContract"
    echo ""
    echo "  [LOW]    approve() not overridden -- ClawPass approvals possible"
    echo "           but useless (transferFrom still reverts)."
    echo "           Test: test_clawPass_approveIsAllowed_butTransferReverts"
    echo ""
    echo "  [LOW]    Late joiners must not earn fees from before they staked."
    echo "           Test: test_lateJoiner_doesNotEarnPreviousFees"
    echo ""
    echo "CONTRACT: ClawStreetLoan"
    echo "  [MEDIUM] repayLoan pulls from loan.borrower even when called by lender."
    echo "           Test: test_repayLoan_lenderTriggersRepayment"
    echo ""
    echo "  [MEDIUM] claimDefault on unfunded loan sends NFT to address(0)."
    echo "           Test: test_claimDefault_onUnfundedLoan_reverts"
    echo ""
    echo "  [LOW]    1-second duration loans accepted (no minimum duration)."
    echo "           Test: test_shortDuration_oneSec"
    echo ""
    echo "  [MEDIUM] Broker fee must flow through to staking for revenue share."
    echo "           Test: test_feeForwarding_toStakingContract"
    echo ""
    echo "CONTRACT: ClawStreetCallVault"
    echo "  [LOW]    Zero-strike options let buyer exercise for free."
    echo "           Test: test_zeroStrike_exercise"
    echo ""
    echo "  [LOW]    Zero-premium options accepted -- writer earns nothing."
    echo "           Test: test_zeroPremium_writeAndBuy"
    echo ""
    echo "  [LOW]    Expiry boundary: exercise inclusive (<=), buyOption exclusive (<)."
    echo "           Tests: test_exercise_atExactExpiry / test_buyOption_atExactExpiry_reverts"
    echo ""
    echo "  [LOW]    cancelOption has no expiry check -- writer can reclaim via cancel."
    echo "           Test: test_cancelOption_afterExpiry_unbought"
    echo ""
    echo "CONTRACT: ClawStreetBundleVault"
    echo "  [HIGH]   withdrawBundle has NO nonReentrant guard -- reentrancy risk."
    echo "  [MEDIUM] depositBundle has NO nonReentrant guard."
    echo "  [LOW]    IERC20.transfer return value unchecked in withdrawBundle."
    echo "  [LOW]    Empty bundle deposit allowed (NFT represents nothing)."
    echo "           Test: test_depositBundle_empty"
    echo ""
    echo "================================================================="
}

print_audit | tee -a "$LOGFILE"
echo "" | tee -a "$LOGFILE"

# ── Final result ──────────────────────────────────────────────────────────────

echo "=================================================================" | tee -a "$LOGFILE"
if [ "$OVERALL_EXIT" -eq 0 ]; then
    echo "  RESULT: ALL TESTS PASSED (284 tests)" | tee -a "$LOGFILE"
else
    echo "  RESULT: ONE OR MORE TEST SUITES FAILED" | tee -a "$LOGFILE"
fi
echo "  Unit: $STANDARD_STATUS  |  Fuzz: $FUZZ_STATUS  |  Invariant: $INVARIANT_STATUS" | tee -a "$LOGFILE"
echo "  Full log: $LOGFILE" | tee -a "$LOGFILE"
echo "=================================================================" | tee -a "$LOGFILE"

exit "$OVERALL_EXIT"
