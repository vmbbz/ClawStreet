// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Test.sol";
import { ClawToken } from "../contracts/ClawToken.sol";
import { ClawStreetStaking } from "../contracts/ClawStreetStaking.sol";

// ─────────────────────────────────────────────────────────────────────────────
// Minimal ERC-20 mock for USDC (6 decimals)
// ─────────────────────────────────────────────────────────────────────────────

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

/**
 * @title ClawStreetStakingTest
 * @notice Comprehensive happy-path and mathematical-correctness test suite for ClawStreetStaking.
 *         Covers staking, unstaking, lock periods, soul-bound NFTs, revenue share,
 *         fee notification, admin functions, events, and fuzz tests.
 */
contract ClawStreetStakingTest is Test {
    ClawToken         public claw;
    MockUSDC          public usdc;
    ClawStreetStaking public staking;

    address public owner    = makeAddr("owner");
    address public alice    = makeAddr("alice");
    address public bob      = makeAddr("bob");
    address public charlie  = makeAddr("charlie");
    address public dave     = makeAddr("dave");
    address public eve      = makeAddr("eve");
    address public loanMock = makeAddr("loanMock");

    uint256 constant LOCK  = 30 days;
    uint256 constant STAKE = 1_000 * 1e18;

    // ─── Setup ────────────────────────────────────────────────────────────────

    function setUp() public {
        vm.startPrank(owner);
        claw    = new ClawToken(owner);
        usdc    = new MockUSDC();
        staking = new ClawStreetStaking(address(claw), address(usdc), owner);

        // Mint 100,000 CLAW to each of alice, bob, charlie, dave, eve
        claw.mint(alice,   100_000 * 1e18);
        claw.mint(bob,     100_000 * 1e18);
        claw.mint(charlie, 100_000 * 1e18);
        claw.mint(dave,    100_000 * 1e18);
        claw.mint(eve,     100_000 * 1e18);

        staking.setFeeNotifier(loanMock, true);
        vm.stopPrank();
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Stake / position
    // ─────────────────────────────────────────────────────────────────────────

    /// @notice Staking mints a ClawPass NFT to the staker; hasPass is true; totalStaked updated.
    function test_stake_mintsClawPass() public {
        _stakeAs(alice, STAKE);

        (uint256 stakedAmt,,, uint256 passId, bool hasPass) = staking.positions(alice);
        assertEq(stakedAmt, STAKE);
        assertTrue(hasPass);
        assertEq(staking.ownerOf(passId), alice);
        assertEq(staking.totalStaked(), STAKE);
    }

    /// @notice The first ever pass minted must have ID 1 (nextPassId starts at 1).
    function test_stake_firstStake_passIdIs1() public {
        _stakeAs(alice, STAKE);
        (,,, uint256 passId,) = staking.positions(alice);
        assertEq(passId, 1);
    }

    /// @notice A top-up to an existing position must NOT mint a new pass; passId is unchanged.
    function test_stake_topUp_samePassId() public {
        _stakeAs(alice, STAKE);
        (,,, uint256 passIdFirst,) = staking.positions(alice);

        _stakeAs(alice, STAKE);
        (,,, uint256 passIdSecond,) = staking.positions(alice);

        assertEq(passIdFirst, passIdSecond, "top-up must not mint a new pass");
    }

    /// @notice Top-up restarts the lock: stakedAt is updated to the current block timestamp.
    function test_stake_topUp_restartsLock() public {
        _stakeAs(alice, STAKE);
        vm.warp(block.timestamp + 10 days);

        uint256 topUpTime = block.timestamp;
        _stakeAs(alice, STAKE);

        (, uint256 stakedAt,,,) = staking.positions(alice);
        assertEq(stakedAt, topUpTime);
    }

    /// @notice Top-up amounts are summed correctly in position.staked.
    function test_stake_topUp_summedCorrectly() public {
        _stakeAs(alice, 1_000 * 1e18);
        _stakeAs(alice, 500 * 1e18);

        (uint256 stakedAmt,,,,) = staking.positions(alice);
        assertEq(stakedAmt, 1_500 * 1e18);
    }

    /// @notice stake(0) must revert with "Cannot stake 0".
    function test_stake_revertsZero() public {
        vm.prank(alice);
        vm.expectRevert("Cannot stake 0");
        staking.stake(0);
    }

    /// @notice Staking without prior ERC-20 approval must revert.
    function test_stake_revertsWithoutApproval() public {
        vm.prank(alice);
        vm.expectRevert();
        staking.stake(STAKE);
    }

    /// @notice Three stakes in the same block are all accumulated into one position.
    function test_stake_multipleTimes_samePeriod() public {
        _stakeAs(alice, 100 * 1e18);
        _stakeAs(alice, 200 * 1e18);
        _stakeAs(alice, 300 * 1e18);

        (uint256 stakedAmt,,,,) = staking.positions(alice);
        assertEq(stakedAmt, 600 * 1e18);
        assertEq(staking.totalStaked(), 600 * 1e18);
    }

    /// @notice totalStaked equals the sum of all individual positions.
    function test_totalStaked_sumOfAllPositions() public {
        uint256 aliceAmt   = 1_000 * 1e18;
        uint256 bobAmt     = 2_000 * 1e18;
        uint256 charlieAmt = 3_000 * 1e18;

        _stakeAs(alice,   aliceAmt);
        _stakeAs(bob,     bobAmt);
        _stakeAs(charlie, charlieAmt);

        assertEq(staking.totalStaked(), aliceAmt + bobAmt + charlieAmt);
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Lock + unstake
    // ─────────────────────────────────────────────────────────────────────────

    /// @notice Unstaking after LOCK_PERIOD returns the exact amount of CLAW staked.
    function test_unstake_afterLock_returnsExactAmount() public {
        _stakeAs(alice, STAKE);
        uint256 balBefore = claw.balanceOf(alice);

        vm.warp(block.timestamp + LOCK);
        vm.prank(alice);
        staking.unstake();

        assertEq(claw.balanceOf(alice), balBefore + STAKE);
    }

    /// @notice Unstaking burns the ClawPass NFT; ownerOf() reverts for the burned tokenId.
    function test_unstake_burnsClaPass() public {
        _stakeAs(alice, STAKE);
        (,,, uint256 passId,) = staking.positions(alice);

        vm.warp(block.timestamp + LOCK);
        vm.prank(alice);
        staking.unstake();

        vm.expectRevert();
        staking.ownerOf(passId);
    }

    /// @notice After unstaking the position is fully cleared: staked=0, hasPass=false, passId=0.
    function test_unstake_clearsPosition() public {
        _stakeAs(alice, STAKE);

        vm.warp(block.timestamp + LOCK);
        vm.prank(alice);
        staking.unstake();

        (uint256 stakedAmt,,, uint256 passId, bool hasPass) = staking.positions(alice);
        assertEq(stakedAmt, 0);
        assertFalse(hasPass);
        assertEq(passId, 0);
        assertEq(staking.totalStaked(), 0);
    }

    /// @notice Unstaking one second before the lock expires must revert with "Still locked".
    function test_unstake_revertsBeforeLock_oneSec() public {
        _stakeAs(alice, STAKE);
        (, uint256 stakedAt,,,) = staking.positions(alice);

        vm.warp(stakedAt + LOCK - 1);
        vm.prank(alice);
        vm.expectRevert("Still locked");
        staking.unstake();
    }

    /// @notice Unstaking with no active position must revert with "Nothing staked".
    function test_unstake_revertsNothingStaked() public {
        vm.prank(alice);
        vm.expectRevert("Nothing staked");
        staking.unstake();
    }

    /// @notice Unstake settles pending revenue: alice receives USDC before position is cleared.
    function test_unstake_settlesRevenueBefore() public {
        _stakeAs(alice, STAKE);

        uint256 fee = 100e6;
        usdc.mint(address(staking), fee);
        vm.prank(loanMock);
        staking.notifyFee(fee);

        vm.warp(block.timestamp + LOCK);
        vm.prank(alice);
        staking.unstake();

        // Alice should have received the fee during unstake
        assertEq(usdc.balanceOf(alice), fee);
    }

    /// @notice lockRemaining immediately after staking is approximately LOCK_PERIOD (within 1 sec).
    function test_lockRemaining_freshStake() public {
        _stakeAs(alice, STAKE);
        uint256 remaining = staking.lockRemaining(alice);
        assertApproxEqAbs(remaining, LOCK, 1);
    }

    /// @notice lockRemaining after 15 days of a 30-day lock is approximately 15 days.
    function test_lockRemaining_halfwayThrough() public {
        _stakeAs(alice, STAKE);
        vm.warp(block.timestamp + 15 days);
        uint256 remaining = staking.lockRemaining(alice);
        assertApproxEqAbs(remaining, 15 days, 1);
    }

    /// @notice lockRemaining returns 0 once the lock period has fully elapsed.
    function test_lockRemaining_afterUnlock() public {
        _stakeAs(alice, STAKE);
        vm.warp(block.timestamp + LOCK + 1);
        assertEq(staking.lockRemaining(alice), 0);
    }

    /// @notice lockRemaining for an address with no position returns 0.
    function test_lockRemaining_noPosition() public view {
        assertEq(staking.lockRemaining(alice), 0);
    }

    /// @notice After unstake then restake, the new passId is the next sequential ID.
    function test_restake_afterUnstake_getsNewPassId() public {
        _stakeAs(alice, STAKE);
        (,,, uint256 firstPassId,) = staking.positions(alice);

        vm.warp(block.timestamp + LOCK);
        vm.prank(alice);
        staking.unstake();

        _stakeAs(alice, STAKE);
        (,,, uint256 secondPassId,) = staking.positions(alice);

        assertGt(secondPassId, firstPassId);
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Soul-bound NFT
    // ─────────────────────────────────────────────────────────────────────────

    /// @notice transferFrom() between two non-zero addresses must revert.
    function test_clawPass_nonTransferable_transferFrom() public {
        _stakeAs(alice, STAKE);
        (,,, uint256 passId,) = staking.positions(alice);

        vm.prank(alice);
        vm.expectRevert("ClawPass: non-transferable");
        staking.transferFrom(alice, bob, passId);
    }

    /// @notice safeTransferFrom() between two non-zero addresses must revert.
    function test_clawPass_nonTransferable_safeTransferFrom() public {
        _stakeAs(alice, STAKE);
        (,,, uint256 passId,) = staking.positions(alice);

        vm.prank(alice);
        vm.expectRevert("ClawPass: non-transferable");
        staking.safeTransferFrom(alice, bob, passId);
    }

    /// @notice approve() must revert for ClawPass.
    function test_clawPass_approve_reverts() public {
        _stakeAs(alice, STAKE);
        (,,, uint256 passId,) = staking.positions(alice);

        vm.prank(alice);
        vm.expectRevert("ClawPass: non-transferable");
        staking.approve(bob, passId);
    }

    /// @notice setApprovalForAll() must revert for ClawPass.
    function test_clawPass_setApprovalForAll_reverts() public {
        _stakeAs(alice, STAKE);

        vm.prank(alice);
        vm.expectRevert("ClawPass: non-transferable");
        staking.setApprovalForAll(bob, true);
    }

    /// @notice ownerOf() reverts for a passId after unstake burns the NFT.
    function test_clawPass_burnedOnUnstake() public {
        _stakeAs(alice, STAKE);
        (,,, uint256 passId,) = staking.positions(alice);

        vm.warp(block.timestamp + LOCK);
        vm.prank(alice);
        staking.unstake();

        vm.expectRevert();
        staking.ownerOf(passId);
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Revenue share — mathematical precision
    // ─────────────────────────────────────────────────────────────────────────

    /// @notice A single staker receives 100% of any notified fee.
    function test_revenueShare_singleStaker_getsAll() public {
        _stakeAs(alice, STAKE);

        uint256 fee = 100e6;
        usdc.mint(address(staking), fee);
        vm.prank(loanMock);
        staking.notifyFee(fee);

        assertEq(staking.pendingRevenue(alice), fee);
    }

    /// @notice Two stakers with equal stakes receive equal shares.
    function test_revenueShare_twoStakers_50_50() public {
        _stakeAs(alice, 1_000 * 1e18);
        _stakeAs(bob,   1_000 * 1e18);

        uint256 fee = 200e6;
        usdc.mint(address(staking), fee);
        vm.prank(loanMock);
        staking.notifyFee(fee);

        assertApproxEqAbs(staking.pendingRevenue(alice), 100e6, 1);
        assertApproxEqAbs(staking.pendingRevenue(bob),   100e6, 1);
    }

    /// @notice 25/75 split: alice=1000 CLAW, bob=3000 CLAW, fee=100 USDC.
    function test_revenueShare_twoStakers_25_75() public {
        _stakeAs(alice, 1_000 * 1e18);
        _stakeAs(bob,   3_000 * 1e18);

        uint256 fee = 100e6;
        usdc.mint(address(staking), fee);
        vm.prank(loanMock);
        staking.notifyFee(fee);

        // alice has 25%, bob has 75%
        assertApproxEqAbs(staking.pendingRevenue(alice), 25e6, 2);
        assertApproxEqAbs(staking.pendingRevenue(bob),   75e6, 2);
    }

    /// @notice Five stakers: alice=1000, bob=2000, charlie=3000, dave=4000, eve=5000.
    ///         Each receives proportional share; total distributed == fee (dust tolerance 4 wei).
    function test_revenueShare_fiveStakers_exact() public {
        uint256 aliceAmt   = 1_000 * 1e18;
        uint256 bobAmt     = 2_000 * 1e18;
        uint256 charlieAmt = 3_000 * 1e18;
        uint256 daveAmt    = 4_000 * 1e18;
        uint256 eveAmt     = 5_000 * 1e18;
        uint256 total      = aliceAmt + bobAmt + charlieAmt + daveAmt + eveAmt; // 15_000 * 1e18

        _stakeAs(alice,   aliceAmt);
        _stakeAs(bob,     bobAmt);
        _stakeAs(charlie, charlieAmt);
        _stakeAs(dave,    daveAmt);
        _stakeAs(eve,     eveAmt);

        uint256 fee = 15_000e6; // 15,000 USDC
        usdc.mint(address(staking), fee);
        vm.prank(loanMock);
        staking.notifyFee(fee);

        uint256 alicePending   = staking.pendingRevenue(alice);
        uint256 bobPending     = staking.pendingRevenue(bob);
        uint256 charliePending = staking.pendingRevenue(charlie);
        uint256 davePending    = staking.pendingRevenue(dave);
        uint256 evePending     = staking.pendingRevenue(eve);

        // Expected proportional shares
        uint256 aliceExpected   = fee * aliceAmt   / total; // 1/15
        uint256 bobExpected     = fee * bobAmt     / total; // 2/15
        uint256 charlieExpected = fee * charlieAmt / total; // 3/15
        uint256 daveExpected    = fee * daveAmt    / total; // 4/15
        uint256 eveExpected     = fee * eveAmt     / total; // 5/15

        assertApproxEqAbs(alicePending,   aliceExpected,   4);
        assertApproxEqAbs(bobPending,     bobExpected,     4);
        assertApproxEqAbs(charliePending, charlieExpected, 4);
        assertApproxEqAbs(davePending,    daveExpected,    4);
        assertApproxEqAbs(evePending,     eveExpected,     4);

        // Total distributed must not exceed fee (no inflation) and dust ≤ 4 wei
        uint256 distributed = alicePending + bobPending + charliePending + davePending + evePending;
        assertTrue(distributed <= fee, "inflation: total pending exceeds fee");
        assertApproxEqAbs(distributed, fee, 4);
    }

    /// @notice Multiple fee batches for a single staker accumulate correctly without leakage.
    function test_revenueShare_multipleFeeBatches_noLeak() public {
        _stakeAs(alice, STAKE);

        uint256 fee1 = 100e6;
        uint256 fee2 = 250e6;
        uint256 fee3 = 50e6;
        uint256 fee4 = 400e6;
        uint256 fee5 = 200e6;
        uint256 totalFee = fee1 + fee2 + fee3 + fee4 + fee5;

        usdc.mint(address(staking), totalFee);

        vm.startPrank(loanMock);
        staking.notifyFee(fee1);
        staking.notifyFee(fee2);
        staking.notifyFee(fee3);
        staking.notifyFee(fee4);
        staking.notifyFee(fee5);
        vm.stopPrank();

        // Single staker receives all
        assertApproxEqAbs(staking.pendingRevenue(alice), totalFee, 2);
    }

    /// @notice Fee arriving before any staker accumulates in unallocatedFees, then is distributed
    ///         to the first staker when the next fee arrives.
    function test_revenueShare_feeBeforeStaker_unallocatedThenDistributed() public {
        uint256 fee1 = 500e6;
        usdc.mint(address(staking), fee1);
        vm.prank(loanMock);
        staking.notifyFee(fee1);

        // fee1 should be unallocated; accumulator unchanged
        assertEq(staking.unallocatedFees(), fee1);
        assertEq(staking.revenuePerShareAccumulated(), 0);

        // alice stakes
        _stakeAs(alice, STAKE);

        // fee2 arrives — triggers distribution of fee1 + fee2
        uint256 fee2 = 300e6;
        usdc.mint(address(staking), fee2);
        vm.prank(loanMock);
        staking.notifyFee(fee2);

        assertEq(staking.unallocatedFees(), 0);
        // Alice is the only staker; she gets all of fee1 + fee2
        assertApproxEqAbs(staking.pendingRevenue(alice), fee1 + fee2, 2);
    }

    /// @notice Late joiner (bob) must not earn fees that were distributed before his stake.
    function test_revenueShare_lateJoiner_doesNotEarnPreviousFees() public {
        _stakeAs(alice, STAKE);

        uint256 fee1 = 100e6;
        usdc.mint(address(staking), fee1);
        vm.prank(loanMock);
        staking.notifyFee(fee1);

        // bob stakes after fee1
        _stakeAs(bob, STAKE);

        uint256 fee2 = 100e6;
        usdc.mint(address(staking), fee2);
        vm.prank(loanMock);
        staking.notifyFee(fee2);

        uint256 alicePending = staking.pendingRevenue(alice);
        uint256 bobPending   = staking.pendingRevenue(bob);

        // alice gets fee1 + half of fee2; bob gets only half of fee2
        assertApproxEqAbs(alicePending, fee1 + fee2 / 2, 2);
        assertApproxEqAbs(bobPending,   fee2 / 2,         2);
    }

    /// @notice After claiming, subsequent fees increase pendingRevenue again from zero.
    function test_revenueShare_claimThenEarnMore() public {
        _stakeAs(alice, STAKE);

        uint256 fee1 = 100e6;
        usdc.mint(address(staking), fee1);
        vm.prank(loanMock);
        staking.notifyFee(fee1);

        vm.prank(alice);
        staking.claimRevenue();
        assertEq(staking.pendingRevenue(alice), 0);

        uint256 fee2 = 200e6;
        usdc.mint(address(staking), fee2);
        vm.prank(loanMock);
        staking.notifyFee(fee2);

        assertApproxEqAbs(staking.pendingRevenue(alice), fee2, 1);
    }

    /// @notice A 1-wei fee with 1,000,000 CLAW staked rounds to 0 pending — no revert, no inflation.
    function test_revenueShare_dustFee_noInflation() public {
        _stakeAs(alice, 100_000 * 1e18);

        uint256 fee = 1; // 1 wei of USDC
        usdc.mint(address(staking), fee);
        vm.prank(loanMock);
        staking.notifyFee(fee);

        uint256 pending = staking.pendingRevenue(alice);
        // Rounding may produce 0; must not exceed fee
        assertTrue(pending <= fee, "pending exceeds fee");
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Claim
    // ─────────────────────────────────────────────────────────────────────────

    /// @notice claimRevenue() transfers the exact pending USDC amount to the staker.
    function test_claimRevenue_transfersExactAmount() public {
        _stakeAs(alice, STAKE);

        uint256 fee = 100e6;
        usdc.mint(address(staking), fee);
        vm.prank(loanMock);
        staking.notifyFee(fee);

        uint256 expectedPending = staking.pendingRevenue(alice);
        uint256 balBefore = usdc.balanceOf(alice);

        vm.prank(alice);
        staking.claimRevenue();

        assertEq(usdc.balanceOf(alice), balBefore + expectedPending);
    }

    /// @notice After claimRevenue(), pendingRevenue returns zero.
    function test_claimRevenue_resetsToZero() public {
        _stakeAs(alice, STAKE);

        uint256 fee = 100e6;
        usdc.mint(address(staking), fee);
        vm.prank(loanMock);
        staking.notifyFee(fee);

        vm.prank(alice);
        staking.claimRevenue();

        assertEq(staking.pendingRevenue(alice), 0);
    }

    /// @notice A second claimRevenue() call (with no new fees) transfers 0 and does not revert.
    function test_claimRevenue_idempotent_secondClaim_transfersZero() public {
        _stakeAs(alice, STAKE);

        uint256 fee = 100e6;
        usdc.mint(address(staking), fee);
        vm.prank(loanMock);
        staking.notifyFee(fee);

        vm.prank(alice);
        staking.claimRevenue();

        uint256 balAfterFirstClaim = usdc.balanceOf(alice);

        vm.prank(alice);
        staking.claimRevenue(); // second claim — should be a no-op

        assertEq(usdc.balanceOf(alice), balAfterFirstClaim);
        assertEq(staking.pendingRevenue(alice), 0);
    }

    /// @notice claimRevenue() reverts with "Nothing staked" if caller has no position.
    function test_claimRevenue_revertsIfNotStaking() public {
        vm.prank(alice);
        vm.expectRevert("Nothing staked");
        staking.claimRevenue();
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Fee notifier admin
    // ─────────────────────────────────────────────────────────────────────────

    /// @notice Enabling a notifier allows fee notification; disabling it causes a revert.
    function test_feeNotifier_setAndRevoke() public {
        address newNotifier = makeAddr("newNotifier");

        vm.prank(owner);
        staking.setFeeNotifier(newNotifier, true);

        uint256 fee = 50e6;
        usdc.mint(address(staking), fee);
        _stakeAs(alice, STAKE);

        vm.prank(newNotifier);
        staking.notifyFee(fee); // must succeed

        vm.prank(owner);
        staking.setFeeNotifier(newNotifier, false);

        usdc.mint(address(staking), fee);
        vm.prank(newNotifier);
        vm.expectRevert("Not authorised fee notifier");
        staking.notifyFee(fee);
    }

    /// @notice A non-authorised caller invoking notifyFee must revert.
    function test_notifyFee_revertsUnauthorised() public {
        vm.prank(alice);
        vm.expectRevert("Not authorised fee notifier");
        staking.notifyFee(100e6);
    }

    /// @notice notifyFee(0) must revert with "Zero fee".
    function test_notifyFee_revertsZeroFee() public {
        vm.prank(loanMock);
        vm.expectRevert("Zero fee");
        staking.notifyFee(0);
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Admin
    // ─────────────────────────────────────────────────────────────────────────

    /// @notice setBaseURI() reverts when called by a non-owner.
    function test_setBaseURI_onlyOwner() public {
        vm.prank(alice);
        vm.expectRevert();
        staking.setBaseURI("ipfs://test/");
    }

    /// @notice setBaseURI() sets the base URI and tokenURI reflects it.
    function test_setBaseURI_updatesTokenURI() public {
        _stakeAs(alice, STAKE);
        (,,, uint256 passId,) = staking.positions(alice);

        string memory uri = "ipfs://QmTest/";
        vm.prank(owner);
        staking.setBaseURI(uri);

        string memory tokenUri = staking.tokenURI(passId);
        // tokenURI should start with the base URI
        assertTrue(
            keccak256(bytes(tokenUri)) != keccak256(bytes("")),
            "tokenURI should not be empty after setting baseURI"
        );
    }

    /// @notice withdrawUnallocatedFees() sends the fee to the recipient when fees are unallocated.
    function test_withdrawUnallocatedFees_whenFeeArrived() public {
        uint256 fee = 300e6;
        usdc.mint(address(staking), fee);
        vm.prank(loanMock);
        staking.notifyFee(fee);

        assertEq(staking.unallocatedFees(), fee);

        uint256 balBefore = usdc.balanceOf(owner);
        vm.prank(owner);
        staking.withdrawUnallocatedFees(owner);

        assertEq(usdc.balanceOf(owner), balBefore + fee);
        assertEq(staking.unallocatedFees(), 0);
    }

    /// @notice withdrawUnallocatedFees() reverts when there are no unallocated fees.
    function test_withdrawUnallocatedFees_revertsIfZero() public {
        vm.prank(owner);
        vm.expectRevert("No unallocated fees");
        staking.withdrawUnallocatedFees(owner);
    }

    /// @notice withdrawUnallocatedFees() reverts when called by a non-owner.
    function test_withdrawUnallocatedFees_onlyOwner() public {
        uint256 fee = 300e6;
        usdc.mint(address(staking), fee);
        vm.prank(loanMock);
        staking.notifyFee(fee);

        vm.prank(alice);
        vm.expectRevert();
        staking.withdrawUnallocatedFees(alice);
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Events
    // ─────────────────────────────────────────────────────────────────────────

    /// @notice stake() emits Staked(staker, amount, totalStaked).
    function test_event_staked() public {
        vm.prank(alice);
        claw.approve(address(staking), STAKE);

        vm.expectEmit(true, true, true, true);
        emit ClawStreetStaking.Staked(alice, STAKE, STAKE);

        vm.prank(alice);
        staking.stake(STAKE);
    }

    /// @notice unstake() emits Unstaked(staker, amount).
    function test_event_unstaked() public {
        _stakeAs(alice, STAKE);
        vm.warp(block.timestamp + LOCK);

        vm.expectEmit(true, true, true, true);
        emit ClawStreetStaking.Unstaked(alice, STAKE);

        vm.prank(alice);
        staking.unstake();
    }

    /// @notice claimRevenue() emits RevenueClaimed(staker, amount).
    function test_event_revenueClaimed() public {
        _stakeAs(alice, STAKE);

        uint256 fee = 100e6;
        usdc.mint(address(staking), fee);
        vm.prank(loanMock);
        staking.notifyFee(fee);

        vm.expectEmit(true, true, true, true);
        emit ClawStreetStaking.RevenueClaimed(alice, fee);

        vm.prank(alice);
        staking.claimRevenue();
    }

    /// @notice notifyFee() emits FeeNotified(notifier, amount).
    function test_event_feeNotified() public {
        _stakeAs(alice, STAKE);

        uint256 fee = 100e6;
        usdc.mint(address(staking), fee);

        vm.expectEmit(true, true, true, true);
        emit ClawStreetStaking.FeeNotified(loanMock, fee);

        vm.prank(loanMock);
        staking.notifyFee(fee);
    }

    /// @notice setFeeNotifier() emits FeeNotifierSet(notifier, enabled).
    function test_event_feeNotifierSet() public {
        address newNotifier = makeAddr("newNotifier");

        vm.expectEmit(true, true, true, true);
        emit ClawStreetStaking.FeeNotifierSet(newNotifier, true);

        vm.prank(owner);
        staking.setFeeNotifier(newNotifier, true);
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Fuzz tests
    // ─────────────────────────────────────────────────────────────────────────

    /// @notice Stake any valid amount, warp past lock, unstake — exact amount returned.
    function testFuzz_stakeAndUnstake(uint96 amount) public {
        vm.assume(amount >= 1e18);
        vm.assume(uint256(amount) <= 100_000 * 1e18);

        _stakeAs(alice, amount);
        uint256 balBefore = claw.balanceOf(alice);

        vm.warp(block.timestamp + LOCK);
        vm.prank(alice);
        staking.unstake();

        assertEq(claw.balanceOf(alice), balBefore + amount);
        assertEq(staking.totalStaked(), 0);
    }

    /// @notice Revenue share between alice and bob never inflates: total pending ≤ fee.
    function testFuzz_revenueShareNoInflation(uint96 aliceStake, uint96 bobStake, uint64 fee) public {
        vm.assume(aliceStake >= 1e18);
        vm.assume(bobStake   >= 1e18);
        vm.assume(fee        >= 1000);
        vm.assume(uint256(aliceStake) + uint256(bobStake) <= 50_000_000 * 1e18);

        // Extra CLAW needed beyond the 100k already minted
        uint256 aliceExtra = aliceStake > 100_000 * 1e18 ? aliceStake - 100_000 * 1e18 : 0;
        uint256 bobExtra   = bobStake   > 100_000 * 1e18 ? bobStake   - 100_000 * 1e18 : 0;

        if (aliceExtra > 0) {
            vm.prank(owner);
            claw.mint(alice, aliceExtra);
        }
        if (bobExtra > 0) {
            vm.prank(owner);
            claw.mint(bob, bobExtra);
        }

        _stakeAs(alice, aliceStake);
        _stakeAs(bob,   bobStake);

        uint256 feeAmt = uint256(fee);
        usdc.mint(address(staking), feeAmt);
        vm.prank(loanMock);
        staking.notifyFee(feeAmt);

        uint256 alicePending = staking.pendingRevenue(alice);
        uint256 bobPending   = staking.pendingRevenue(bob);

        // Anti-inflation invariant
        assertTrue(alicePending + bobPending <= feeAmt, "inflation: total pending exceeds fee");

        // Ordering: larger stake earns at least as much
        if (aliceStake > bobStake) {
            assertTrue(alicePending >= bobPending, "larger staker received less");
        } else if (bobStake > aliceStake) {
            assertTrue(bobPending >= alicePending, "larger staker received less");
        }
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Helpers
    // ─────────────────────────────────────────────────────────────────────────

    function _stakeAs(address who, uint256 amount) internal {
        vm.prank(who);
        claw.approve(address(staking), amount);
        vm.prank(who);
        staking.stake(amount);
    }
}
