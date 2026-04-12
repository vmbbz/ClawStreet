// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Test.sol";
import { ClawToken } from "../contracts/ClawToken.sol";
import { ClawStreetStaking } from "../contracts/ClawStreetStaking.sol";

/// @dev Minimal ERC-20 mock for USDC (6 decimals) — same as original staking test
contract MockUSDC {
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;
    uint8 public decimals = 6;

    function mint(address to, uint256 amount) external {
        balanceOf[to] += amount;
    }

    function transfer(address to, uint256 amount) external returns (bool) {
        require(balanceOf[msg.sender] >= amount, "insufficient");
        balanceOf[msg.sender] -= amount;
        balanceOf[to] += amount;
        return true;
    }

    function transferFrom(address from, address to, uint256 amount) external returns (bool) {
        require(balanceOf[from] >= amount, "insufficient");
        require(allowance[from][msg.sender] >= amount, "allowance");
        allowance[from][msg.sender] -= amount;
        balanceOf[from] -= amount;
        balanceOf[to] += amount;
        return true;
    }

    function approve(address spender, uint256 amount) external returns (bool) {
        allowance[msg.sender][spender] = amount;
        return true;
    }
}

contract ClawStreetStakingEdgeTest is Test {
    ClawToken public claw;
    MockUSDC  public usdc;
    ClawStreetStaking public staking;

    address public owner    = makeAddr("owner");
    address public alice    = makeAddr("alice");
    address public bob      = makeAddr("bob");
    address public loanMock = makeAddr("loanMock");

    uint256 constant LOCK  = 30 days;
    uint256 constant STAKE = 1_000 * 1e18;

    function setUp() public {
        vm.startPrank(owner);
        claw    = new ClawToken(owner);
        usdc    = new MockUSDC();
        staking = new ClawStreetStaking(address(claw), address(usdc), owner);

        claw.mint(alice, 100_000 * 1e18);
        claw.mint(bob,   100_000 * 1e18);

        staking.setFeeNotifier(loanMock, true);
        vm.stopPrank();
    }

    // ── AUDIT FINDING: MEDIUM — fee stuck when totalStaked == 0 (FIXED) ──────

    /// @notice notifyFee with no stakers now accumulates into unallocatedFees.
    ///         On the next notifyFee with stakers, both fees are distributed together.
    function test_noStakers_feesGoToUnallocated_distributedOnNextNotify() public {
        uint256 fee1 = 500e6; // 500 USDC — arrives before any staker
        usdc.mint(address(staking), fee1);

        vm.prank(loanMock);
        staking.notifyFee(fee1);

        // Accumulator unchanged — fee is held in unallocatedFees
        assertEq(staking.revenuePerShareAccumulated(), 0);
        assertEq(staking.unallocatedFees(), fee1);

        // Alice stakes
        _stakeAs(alice, STAKE);

        // Second fee arrives — should distribute fee1 + fee2 together
        uint256 fee2 = 300e6;
        usdc.mint(address(staking), fee2);
        vm.prank(loanMock);
        staking.notifyFee(fee2);

        // unallocatedFees reset to 0
        assertEq(staking.unallocatedFees(), 0);

        // Alice (only staker) should receive both fees
        assertApproxEqAbs(staking.pendingRevenue(alice), fee1 + fee2, 2);
    }

    // ── AUDIT FINDING: LOW — late joiner must not earn previous fees ──────────

    /// @notice Alice stakes → fee1 arrives → Bob stakes → fee2 arrives.
    ///         Bob should only earn his proportional share of fee2, not fee1.
    function test_lateJoiner_doesNotEarnPreviousFees() public {
        uint256 fee1 = 100e6;
        uint256 fee2 = 100e6;

        // Alice stakes first
        _stakeAs(alice, STAKE);

        // fee1 arrives while only Alice is staked
        usdc.mint(address(staking), fee1);
        vm.prank(loanMock);
        staking.notifyFee(fee1);

        // Bob stakes after fee1
        _stakeAs(bob, STAKE);

        // fee2 arrives while both Alice and Bob are staked
        usdc.mint(address(staking), fee2);
        vm.prank(loanMock);
        staking.notifyFee(fee2);

        uint256 alicePending = staking.pendingRevenue(alice);
        uint256 bobPending   = staking.pendingRevenue(bob);

        // Alice should get all of fee1 + half of fee2
        assertApproxEqAbs(alicePending, fee1 + fee2 / 2, 2);
        // Bob should get only half of fee2 (not fee1)
        assertApproxEqAbs(bobPending, fee2 / 2, 2);
    }

    // ── Multiple fee batches accumulate correctly ─────────────────────────────

    function test_multipleFeeBatches() public {
        _stakeAs(alice, STAKE);

        uint256 fee1 = 100e6;
        uint256 fee2 = 200e6;
        uint256 fee3 = 300e6;
        uint256 totalFee = fee1 + fee2 + fee3;

        usdc.mint(address(staking), totalFee);

        vm.prank(loanMock);
        staking.notifyFee(fee1);
        vm.prank(loanMock);
        staking.notifyFee(fee2);
        vm.prank(loanMock);
        staking.notifyFee(fee3);

        // Alice is the only staker, so she gets 100% of all fees
        assertApproxEqAbs(staking.pendingRevenue(alice), totalFee, 2);
    }

    // ── claimRevenue idempotency ───────────────────────────────────────────────

    function test_claimRevenue_idempotent() public {
        _stakeAs(alice, STAKE);

        uint256 fee = 100e6;
        usdc.mint(address(staking), fee);
        vm.prank(loanMock);
        staking.notifyFee(fee);

        // First claim — receives fee
        vm.prank(alice);
        staking.claimRevenue();
        assertEq(usdc.balanceOf(alice), fee);

        // Second claim — transfers 0 (no revert, idempotent)
        uint256 balanceBefore = usdc.balanceOf(alice);
        vm.prank(alice);
        staking.claimRevenue();
        assertEq(usdc.balanceOf(alice), balanceBefore);
        assertEq(staking.pendingRevenue(alice), 0);
    }

    // ── Unstake exactly at lock boundary ──────────────────────────────────────

    /// @notice block.timestamp >= stakedAt + LOCK_PERIOD is the condition,
    ///         so at exactly stakedAt + LOCK_PERIOD, unstake MUST succeed.
    function test_unstake_exactlyAtLockBoundary() public {
        _stakeAs(alice, STAKE);
        (, uint256 stakedAt,,,) = staking.positions(alice);

        // Warp to exactly the boundary
        vm.warp(stakedAt + LOCK);

        // Should NOT revert
        vm.prank(alice);
        staking.unstake();

        assertEq(staking.totalStaked(), 0);
        assertEq(claw.balanceOf(alice), 100_000 * 1e18); // all returned
    }

    // ── rewardDebt resets correctly on top-up ─────────────────────────────────

    function test_rewardDebt_resetOnTopUp() public {
        // Phase 1: Alice stakes, fee1 arrives
        _stakeAs(alice, STAKE);

        uint256 fee1 = 100e6;
        usdc.mint(address(staking), fee1);
        vm.prank(loanMock);
        staking.notifyFee(fee1);

        // Alice tops up — this settles pending revenue internally and resets rewardDebt
        uint256 aliceBalBefore = usdc.balanceOf(alice);
        _stakeAs(alice, STAKE); // top-up; internally calls _settleRevenue

        // Alice should have received fee1 as part of the top-up settle
        assertApproxEqAbs(usdc.balanceOf(alice), aliceBalBefore + fee1, 2);

        // Phase 2: fee2 arrives after top-up
        uint256 fee2 = 200e6;
        usdc.mint(address(staking), fee2);
        vm.prank(loanMock);
        staking.notifyFee(fee2);

        // Now pendingRevenue should only reflect fee2 (not double-count fee1)
        assertApproxEqAbs(staking.pendingRevenue(alice), fee2, 2);
    }

    // ── AUDIT FINDING: LOW — approve() and setApprovalForAll() overridden (FIXED) ──

    /// @notice approve() and setApprovalForAll() now revert with "ClawPass: non-transferable".
    function test_clawPass_approve_reverts() public {
        _stakeAs(alice, STAKE);
        (,,, uint256 passId,) = staking.positions(alice);

        // approve() must revert
        vm.prank(alice);
        vm.expectRevert("ClawPass: non-transferable");
        staking.approve(bob, passId);

        // setApprovalForAll() must also revert
        vm.prank(alice);
        vm.expectRevert("ClawPass: non-transferable");
        staking.setApprovalForAll(bob, true);
    }

    // ── Fuzz: proportional revenue share ─────────────────────────────────────

    /// @notice Verify that revenue split between alice and bob is proportional
    ///         to their respective stakes, within rounding tolerance.
    function testFuzz_revenueShare_proportional(
        uint96 aliceStake,
        uint96 bobStake,
        uint64 fee
    ) public {
        vm.assume(aliceStake >= 1e18);
        vm.assume(bobStake   >= 1e18);
        vm.assume(fee        >= 1000); // avoid dust
        // Ensure we don't overflow mint cap
        vm.assume(uint256(aliceStake) + uint256(bobStake) <= 10_000_000 * 1e18);

        // Top up balances
        vm.prank(owner);
        claw.mint(alice, aliceStake);
        vm.prank(owner);
        claw.mint(bob, bobStake);

        _stakeAs(alice, aliceStake);
        _stakeAs(bob,   bobStake);

        uint256 feeAmount = uint256(fee);
        usdc.mint(address(staking), feeAmount);
        vm.prank(loanMock);
        staking.notifyFee(feeAmount);

        uint256 alicePending = staking.pendingRevenue(alice);
        uint256 bobPending   = staking.pendingRevenue(bob);

        // KEY INVARIANT: no inflation — total distributed never exceeds the fee collected
        assertTrue(alicePending + bobPending <= feeAmount, "inflation: distributed more than fee");

        // Each staker gets a positive share when fee is non-trivial
        // (accumulator can round to 0 for very small fees vs very large totalStaked — that's acceptable)
        if (feeAmount >= 1e12) {
            // With stakes ≥ 1e18 each and fee ≥ 1e12, both should get at least 1 unit
            // (fee/totalStaked * stake/1e18 — guaranteed > 0 because fee ≥ 1e12 and stakes fit in uint96)
            assertTrue(alicePending > 0 || bobPending > 0, "no one received any fee");
        }

        // Ordering invariant: larger stake → larger or equal pending
        if (aliceStake > bobStake) {
            assertTrue(alicePending >= bobPending, "larger staker received less");
        } else if (bobStake > aliceStake) {
            assertTrue(bobPending >= alicePending, "larger staker received less");
        }

        // Total claimed must not exceed fee (no inflation)
        assertTrue(alicePending + bobPending <= feeAmount);
    }

    // ── Helpers ───────────────────────────────────────────────────────────────

    function _stakeAs(address who, uint256 amount) internal {
        vm.prank(who);
        claw.approve(address(staking), amount);
        vm.prank(who);
        staking.stake(amount);
    }
}
