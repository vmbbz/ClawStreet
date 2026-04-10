// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Test.sol";
import { ClawToken } from "../contracts/ClawToken.sol";
import { ClawStreetStaking } from "../contracts/ClawStreetStaking.sol";

/// @dev Minimal ERC-20 mock for USDC (6 decimals)
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

contract ClawStreetStakingTest is Test {
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

        // Mint CLAW to test users
        claw.mint(alice, 10_000 * 1e18);
        claw.mint(bob,   10_000 * 1e18);

        // Authorise loanMock to notify fees
        staking.setFeeNotifier(loanMock, true);

        vm.stopPrank();
    }

    // ── Stake ─────────────────────────────────────────────────────────────────

    function test_stake_mintsClawPass() public {
        _stakeAs(alice, STAKE);

        (uint256 stakedAmt,,, uint256 passId, bool hasPass) = staking.positions(alice);
        assertEq(stakedAmt, STAKE);
        assertTrue(hasPass);
        assertEq(staking.ownerOf(passId), alice);
        assertEq(staking.totalStaked(), STAKE);
    }

    function test_stake_topUp_restartsLock() public {
        _stakeAs(alice, STAKE);
        vm.warp(block.timestamp + 10 days);

        // Top-up
        vm.prank(alice);
        claw.approve(address(staking), STAKE);
        vm.prank(alice);
        staking.stake(STAKE);

        (, uint256 stakedAt,,,) = staking.positions(alice);
        assertEq(stakedAt, block.timestamp); // lock restarted

        assertEq(staking.totalStaked(), STAKE * 2);
    }

    function test_stake_onlyOneCLawPass() public {
        _stakeAs(alice, STAKE);
        (, , , uint256 passIdFirst,) = staking.positions(alice);

        _stakeAs(alice, STAKE); // top-up

        (, , , uint256 passIdSecond,) = staking.positions(alice);
        assertEq(passIdFirst, passIdSecond, "Should not mint a second pass");
    }

    function test_stake_revertsZero() public {
        vm.prank(alice);
        vm.expectRevert("Cannot stake 0");
        staking.stake(0);
    }

    // ── Unstake ───────────────────────────────────────────────────────────────

    function test_unstake_afterLock() public {
        _stakeAs(alice, STAKE);
        vm.warp(block.timestamp + LOCK);

        uint256 before = claw.balanceOf(alice);
        vm.prank(alice);
        staking.unstake();

        assertEq(claw.balanceOf(alice), before + STAKE);
        assertEq(staking.totalStaked(), 0);
        (uint256 stakedAmt,,, , bool hasPass) = staking.positions(alice);
        assertEq(stakedAmt, 0);
        assertFalse(hasPass);
    }

    function test_unstake_revertsBeforeLock() public {
        _stakeAs(alice, STAKE);
        vm.warp(block.timestamp + LOCK - 1); // 1 second early

        vm.prank(alice);
        vm.expectRevert("Still locked");
        staking.unstake();
    }

    function test_unstake_revertsNothingStaked() public {
        vm.prank(alice);
        vm.expectRevert("Nothing staked");
        staking.unstake();
    }

    // ── Revenue share ─────────────────────────────────────────────────────────

    function test_notifyFee_revertsUnauthorised() public {
        vm.prank(alice); // not authorised
        vm.expectRevert("Not authorised fee notifier");
        staking.notifyFee(100e6);
    }

    function test_revenueShare_singleStaker() public {
        _stakeAs(alice, STAKE);

        // Loan sends 100 USDC fee to staking contract
        uint256 fee = 100e6;
        usdc.mint(address(staking), fee);
        vm.prank(loanMock);
        staking.notifyFee(fee);

        assertEq(staking.pendingRevenue(alice), fee);
    }

    function test_revenueShare_twoStakers_proportional() public {
        // Alice stakes 1000, Bob stakes 3000 → 25% / 75%
        _stakeAs(alice, 1_000 * 1e18);
        _stakeAs(bob,   3_000 * 1e18);

        uint256 fee = 100e6; // 100 USDC
        usdc.mint(address(staking), fee);
        vm.prank(loanMock);
        staking.notifyFee(fee);

        uint256 alicePending = staking.pendingRevenue(alice);
        uint256 bobPending   = staking.pendingRevenue(bob);

        assertApproxEqAbs(alicePending, 25e6, 1); // 25 USDC ± 1 wei
        assertApproxEqAbs(bobPending,   75e6, 1); // 75 USDC ± 1 wei
    }

    function test_claimRevenue_transfersUSDC() public {
        _stakeAs(alice, STAKE);

        uint256 fee = 100e6;
        usdc.mint(address(staking), fee);
        vm.prank(loanMock);
        staking.notifyFee(fee);

        uint256 before = usdc.balanceOf(alice);
        vm.prank(alice);
        staking.claimRevenue();

        assertEq(usdc.balanceOf(alice), before + fee);
        assertEq(staking.pendingRevenue(alice), 0);
    }

    // ── Soul-bound ────────────────────────────────────────────────────────────

    function test_clawPass_nonTransferable() public {
        _stakeAs(alice, STAKE);
        (,,, uint256 passId,) = staking.positions(alice);

        vm.prank(alice);
        vm.expectRevert("ClawPass: non-transferable");
        staking.transferFrom(alice, bob, passId);
    }

    // ── Helpers ───────────────────────────────────────────────────────────────

    function _stakeAs(address who, uint256 amount) internal {
        vm.prank(who);
        claw.approve(address(staking), amount);
        vm.prank(who);
        staking.stake(amount);
    }
}
