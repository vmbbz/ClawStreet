// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Test.sol";
import { ClawToken } from "../contracts/ClawToken.sol";

/**
 * @title ClawTokenTest
 * @notice Comprehensive ERC-20 test suite for the ClawToken contract.
 *         Covers supply mechanics, burn, transfers, allowances, ownership, metadata, and fuzz.
 *         Intended for third-party security audit review.
 */
contract ClawTokenTest is Test {
    ClawToken public token;

    address public owner   = makeAddr("owner");
    address public alice   = makeAddr("alice");
    address public bob     = makeAddr("bob");
    address public charlie = makeAddr("charlie");

    uint256 constant MAX_SUPPLY = 100_000_000 * 1e18;

    function setUp() public {
        vm.prank(owner);
        token = new ClawToken(owner);
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Supply mechanics
    // ─────────────────────────────────────────────────────────────────────────

    /// @notice MAX_SUPPLY constant must equal exactly 100,000,000 * 1e18.
    function test_maxSupply_constant() public view {
        assertEq(token.MAX_SUPPLY(), MAX_SUPPLY);
        assertEq(token.MAX_SUPPLY(), 100_000_000 * 1e18);
    }

    /// @notice Total supply is zero immediately after deployment.
    function test_initialSupply_isZero() public view {
        assertEq(token.totalSupply(), 0);
    }

    /// @notice Owner can mint tokens; recipient balance and totalSupply both increase.
    function test_mint_byOwner_updatesBalance() public {
        uint256 amount = 1_000 * 1e18;
        vm.prank(owner);
        token.mint(alice, amount);
        assertEq(token.balanceOf(alice), amount);
        assertEq(token.totalSupply(), amount);
    }

    /// @notice Owner may mint directly to themselves.
    function test_mint_toSelf_byOwner() public {
        uint256 amount = 500 * 1e18;
        vm.prank(owner);
        token.mint(owner, amount);
        assertEq(token.balanceOf(owner), amount);
        assertEq(token.totalSupply(), amount);
    }

    /// @notice Multiple separate mint calls accumulate correctly in both balance and totalSupply.
    function test_mint_accumulatesAcrossMultipleCalls() public {
        uint256 a = 100 * 1e18;
        uint256 b = 200 * 1e18;
        uint256 c = 300 * 1e18;

        vm.startPrank(owner);
        token.mint(alice, a);
        token.mint(alice, b);
        token.mint(alice, c);
        vm.stopPrank();

        assertEq(token.balanceOf(alice), a + b + c);
        assertEq(token.totalSupply(), a + b + c);
    }

    /// @notice Minting exactly the cap in one call succeeds; totalSupply equals MAX_SUPPLY.
    function test_mint_exactlyCap_succeeds() public {
        vm.prank(owner);
        token.mint(alice, MAX_SUPPLY);
        assertEq(token.totalSupply(), MAX_SUPPLY);
        assertEq(token.balanceOf(alice), MAX_SUPPLY);
    }

    /// @notice Minting one wei beyond the cap after reaching it must revert.
    function test_mint_revertsWhenCapExceeded() public {
        vm.prank(owner);
        token.mint(alice, MAX_SUPPLY);

        vm.prank(owner);
        vm.expectRevert("CLAW: cap exceeded");
        token.mint(alice, 1);
    }

    /// @notice Two sequential mints whose sum exceeds the cap must revert on the second.
    function test_mint_revertsWhenCapExceeded_multipleMintsAddUp() public {
        uint256 first  = MAX_SUPPLY - 1e18;
        uint256 second = 2e18; // first + second > MAX_SUPPLY

        vm.prank(owner);
        token.mint(alice, first);

        vm.prank(owner);
        vm.expectRevert("CLAW: cap exceeded");
        token.mint(alice, second);
    }

    /// @notice Non-owner address attempting to mint must revert (OZ Ownable).
    function test_mint_revertsIfNotOwner() public {
        vm.prank(alice);
        vm.expectRevert();
        token.mint(alice, 1e18);
    }

    /// @notice mint() must emit Minted(to, amount).
    function test_mint_emitsMintedEvent() public {
        uint256 amount = 42 * 1e18;
        vm.expectEmit(true, true, true, true);
        emit ClawToken.Minted(alice, amount);

        vm.prank(owner);
        token.mint(alice, amount);
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Burn
    // ─────────────────────────────────────────────────────────────────────────

    /// @notice Burning a portion reduces balance and totalSupply by that exact amount.
    function test_burn_reducesSupply() public {
        vm.prank(owner);
        token.mint(alice, 1_000 * 1e18);

        vm.prank(alice);
        token.burn(500 * 1e18);

        assertEq(token.balanceOf(alice), 500 * 1e18);
        assertEq(token.totalSupply(), 500 * 1e18);
    }

    /// @notice Burning the entire balance leaves both balance and totalSupply at zero.
    function test_burn_exactBalance_leavesZero() public {
        uint256 amount = 999 * 1e18;
        vm.prank(owner);
        token.mint(alice, amount);

        vm.prank(alice);
        token.burn(amount);

        assertEq(token.balanceOf(alice), 0);
        assertEq(token.totalSupply(), 0);
    }

    /// @notice Burning more than the holder's balance must revert.
    function test_burn_revertsInsufficientBalance() public {
        vm.prank(owner);
        token.mint(alice, 100 * 1e18);

        vm.prank(alice);
        vm.expectRevert();
        token.burn(100 * 1e18 + 1);
    }

    /// @notice Burning from a zero balance must revert.
    function test_burn_revertsZeroBalance() public {
        vm.prank(alice);
        vm.expectRevert();
        token.burn(1);
    }

    /// @notice burn() emits Transfer(alice, address(0), amount) per ERC-20 spec.
    function test_burn_emitsTransferEvent() public {
        uint256 amount = 1_000 * 1e18;
        vm.prank(owner);
        token.mint(alice, amount);

        vm.expectEmit(true, true, true, true);
        emit Transfer(alice, address(0), amount);

        vm.prank(alice);
        token.burn(amount);
    }

    /// @notice burnFrom() succeeds when the caller has sufficient allowance.
    function test_burnFrom_withApproval() public {
        uint256 amount = 100 * 1e18;
        vm.prank(owner);
        token.mint(alice, amount);

        vm.prank(alice);
        token.approve(bob, amount);

        vm.prank(bob);
        token.burnFrom(alice, amount);

        assertEq(token.balanceOf(alice), 0);
        assertEq(token.totalSupply(), 0);
        assertEq(token.allowance(alice, bob), 0);
    }

    /// @notice burnFrom() without approval must revert.
    function test_burnFrom_revertsWithoutApproval() public {
        uint256 amount = 100 * 1e18;
        vm.prank(owner);
        token.mint(alice, amount);

        vm.prank(bob);
        vm.expectRevert();
        token.burnFrom(alice, amount);
    }

    // ─────────────────────────────────────────────────────────────────────────
    // ERC-20 Transfers
    // ─────────────────────────────────────────────────────────────────────────

    /// @notice transfer() moves tokens between two accounts correctly.
    function test_transfer_basic() public {
        vm.prank(owner);
        token.mint(alice, 100 * 1e18);

        vm.prank(alice);
        token.transfer(bob, 40 * 1e18);

        assertEq(token.balanceOf(alice), 60 * 1e18);
        assertEq(token.balanceOf(bob), 40 * 1e18);
    }

    /// @notice Transferring the entire balance leaves the sender at zero.
    function test_transfer_fullBalance() public {
        uint256 amount = 100 * 1e18;
        vm.prank(owner);
        token.mint(alice, amount);

        vm.prank(alice);
        token.transfer(bob, amount);

        assertEq(token.balanceOf(alice), 0);
        assertEq(token.balanceOf(bob), amount);
    }

    /// @notice Transferring more than the sender's balance must revert.
    function test_transfer_revertsInsufficientBalance() public {
        vm.prank(owner);
        token.mint(alice, 100 * 1e18);

        vm.prank(alice);
        vm.expectRevert();
        token.transfer(bob, 100 * 1e18 + 1);
    }

    /// @notice Transferring to address(0) must revert (OZ ERC-20 guard).
    function test_transfer_revertsToZeroAddress() public {
        vm.prank(owner);
        token.mint(alice, 100 * 1e18);

        vm.prank(alice);
        vm.expectRevert();
        token.transfer(address(0), 1);
    }

    /// @notice transfer() emits Transfer(from, to, amount).
    function test_transfer_emitsTransferEvent() public {
        uint256 amount = 50 * 1e18;
        vm.prank(owner);
        token.mint(alice, amount);

        vm.expectEmit(true, true, true, true);
        emit Transfer(alice, bob, amount);

        vm.prank(alice);
        token.transfer(bob, amount);
    }

    /// @notice Transferring 0 tokens is a valid no-op; balances unchanged, event emitted.
    function test_transfer_zeroAmount_succeeds() public {
        vm.prank(owner);
        token.mint(alice, 100 * 1e18);

        vm.expectEmit(true, true, true, true);
        emit Transfer(alice, bob, 0);

        vm.prank(alice);
        token.transfer(bob, 0);

        assertEq(token.balanceOf(alice), 100 * 1e18);
        assertEq(token.balanceOf(bob), 0);
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Allowance
    // ─────────────────────────────────────────────────────────────────────────

    /// @notice approve() sets the allowance from alice to bob.
    function test_approve_setsAllowance() public {
        uint256 amount = 50 * 1e18;
        vm.prank(alice);
        token.approve(bob, amount);
        assertEq(token.allowance(alice, bob), amount);
    }

    /// @notice A second approve() overwrites the previous allowance.
    function test_approve_overwritesPreviousAllowance() public {
        vm.prank(alice);
        token.approve(bob, 100 * 1e18);

        vm.prank(alice);
        token.approve(bob, 25 * 1e18);

        assertEq(token.allowance(alice, bob), 25 * 1e18);
    }

    /// @notice approve() emits Approval(owner, spender, value).
    function test_approve_emitsApprovalEvent() public {
        uint256 amount = 77 * 1e18;
        vm.expectEmit(true, true, true, true);
        emit Approval(alice, bob, amount);

        vm.prank(alice);
        token.approve(bob, amount);
    }

    /// @notice transferFrom() moves exactly the approved amount; allowance drops to zero.
    function test_transferFrom_standard() public {
        vm.prank(owner);
        token.mint(alice, 100 * 1e18);

        vm.prank(alice);
        token.approve(bob, 50 * 1e18);

        vm.prank(bob);
        token.transferFrom(alice, bob, 50 * 1e18);

        assertEq(token.balanceOf(alice), 50 * 1e18);
        assertEq(token.balanceOf(bob), 50 * 1e18);
        assertEq(token.allowance(alice, bob), 0);
    }

    /// @notice transferFrom() with a partial spend leaves the remaining allowance correct.
    function test_transferFrom_partialAllowance() public {
        vm.prank(owner);
        token.mint(alice, 200 * 1e18);

        vm.prank(alice);
        token.approve(bob, 100 * 1e18);

        vm.prank(bob);
        token.transferFrom(alice, bob, 60 * 1e18);

        assertEq(token.balanceOf(alice), 140 * 1e18);
        assertEq(token.balanceOf(bob), 60 * 1e18);
        assertEq(token.allowance(alice, bob), 40 * 1e18);
    }

    /// @notice Spending exactly the allowance leaves allowance at zero.
    function test_transferFrom_exactAllowance_leaves0() public {
        uint256 amount = 333 * 1e18;
        vm.prank(owner);
        token.mint(alice, amount);

        vm.prank(alice);
        token.approve(bob, amount);

        vm.prank(bob);
        token.transferFrom(alice, bob, amount);

        assertEq(token.allowance(alice, bob), 0);
        assertEq(token.balanceOf(bob), amount);
    }

    /// @notice transferFrom() with amount exceeding allowance must revert.
    function test_transferFrom_revertsExceedingAllowance() public {
        vm.prank(owner);
        token.mint(alice, 200 * 1e18);

        vm.prank(alice);
        token.approve(bob, 100 * 1e18);

        vm.prank(bob);
        vm.expectRevert();
        token.transferFrom(alice, bob, 100 * 1e18 + 1);
    }

    /// @notice transferFrom() when allowance is sufficient but balance is not must revert.
    function test_transferFrom_revertsInsufficientBalance() public {
        vm.prank(owner);
        token.mint(alice, 100 * 1e18);

        // approve more than alice actually holds
        vm.prank(alice);
        token.approve(bob, 200 * 1e18);

        vm.prank(bob);
        vm.expectRevert();
        token.transferFrom(alice, bob, 200 * 1e18);
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Ownership (Ownable)
    // ─────────────────────────────────────────────────────────────────────────

    /// @notice The deployer address is the initial owner.
    function test_ownerIsInitialOwner() public view {
        assertEq(token.owner(), owner);
    }

    /// @notice After ownership transfer the new owner can mint; old owner cannot.
    function test_transferOwnership_newOwnerCanMint() public {
        vm.prank(owner);
        token.transferOwnership(alice);

        // New owner can mint
        vm.prank(alice);
        token.mint(bob, 1e18);
        assertEq(token.balanceOf(bob), 1e18);
    }

    /// @notice Old owner cannot mint after transferring ownership.
    function test_transferOwnership_oldOwnerCannotMint() public {
        vm.prank(owner);
        token.transferOwnership(alice);

        vm.prank(owner);
        vm.expectRevert();
        token.mint(bob, 1e18);
    }

    /// @notice After renouncing ownership, all minting must revert.
    function test_renounceOwnership_blocksAllMinting() public {
        vm.prank(owner);
        token.renounceOwnership();

        vm.prank(owner);
        vm.expectRevert();
        token.mint(alice, 1e18);

        vm.prank(alice);
        vm.expectRevert();
        token.mint(alice, 1e18);
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Metadata
    // ─────────────────────────────────────────────────────────────────────────

    /// @notice Token metadata must match the constructor arguments.
    function test_nameAndSymbol() public view {
        assertEq(token.name(), "ClawStreet");
        assertEq(token.symbol(), "STREET");
        assertEq(token.decimals(), 18);
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Fuzz tests
    // ─────────────────────────────────────────────────────────────────────────

    /// @notice Two mints whose sum is within the cap never revert and totalSupply is exact.
    function testFuzz_mint_withinCap(uint128 a, uint128 b) public {
        vm.assume(uint256(a) + uint256(b) <= MAX_SUPPLY);

        vm.startPrank(owner);
        token.mint(alice, a);
        token.mint(bob, b);
        vm.stopPrank();

        assertEq(token.totalSupply(), uint256(a) + uint256(b));
        assertEq(token.balanceOf(alice), a);
        assertEq(token.balanceOf(bob), b);
    }

    /// @notice Transferring any amount between accounts does not change totalSupply.
    function testFuzz_transfer_conservesSupply(uint128 amount) public {
        uint256 mintAmt = uint256(amount) > 0 ? uint256(amount) : 1;
        vm.assume(mintAmt <= MAX_SUPPLY);

        vm.prank(owner);
        token.mint(alice, mintAmt);

        uint256 supplyBefore = token.totalSupply();

        vm.prank(alice);
        token.transfer(bob, mintAmt);

        assertEq(token.totalSupply(), supplyBefore);
        assertEq(token.balanceOf(alice), 0);
        assertEq(token.balanceOf(bob), mintAmt);
    }

    /// @notice Burning up to the minted amount always leaves totalSupply at mintAmt - burnAmt.
    function testFuzz_burnReducesSupply(uint128 mintAmt, uint128 burnAmt) public {
        vm.assume(mintAmt > 0);
        vm.assume(uint256(mintAmt) <= MAX_SUPPLY);
        vm.assume(uint256(burnAmt) <= uint256(mintAmt));

        vm.prank(owner);
        token.mint(alice, mintAmt);

        vm.prank(alice);
        token.burn(burnAmt);

        assertEq(token.totalSupply(), uint256(mintAmt) - uint256(burnAmt));
        assertEq(token.balanceOf(alice), uint256(mintAmt) - uint256(burnAmt));
    }

    // ─────────────────────────────────────────────────────────────────────────
    // ERC-20 event declarations (for vm.expectEmit)
    // ─────────────────────────────────────────────────────────────────────────

    event Transfer(address indexed from, address indexed to, uint256 value);
    event Approval(address indexed owner_, address indexed spender, uint256 value);
}
