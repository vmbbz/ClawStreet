// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Test.sol";
import { ClawToken } from "../contracts/ClawToken.sol";

contract ClawTokenTest is Test {
    ClawToken public token;
    address public owner = makeAddr("owner");
    address public alice = makeAddr("alice");
    address public bob   = makeAddr("bob");

    function setUp() public {
        vm.prank(owner);
        token = new ClawToken(owner);
    }

    // ── Supply cap ────────────────────────────────────────────────────────────

    function test_maxSupply() public view {
        assertEq(token.MAX_SUPPLY(), 100_000_000 * 1e18);
    }

    function test_initialSupply_isZero() public view {
        assertEq(token.totalSupply(), 0);
    }

    function test_mint_byOwner() public {
        vm.prank(owner);
        token.mint(alice, 1_000 * 1e18);
        assertEq(token.balanceOf(alice), 1_000 * 1e18);
        assertEq(token.totalSupply(), 1_000 * 1e18);
    }

    function test_mint_revertsWhenCapExceeded() public {
        vm.prank(owner);
        token.mint(alice, 100_000_000 * 1e18); // exactly at cap
        vm.prank(owner);
        vm.expectRevert("CLAW: cap exceeded");
        token.mint(alice, 1); // 1 wei over
    }

    function test_mint_revertsIfNotOwner() public {
        vm.prank(alice);
        vm.expectRevert();
        token.mint(alice, 1e18);
    }

    // ── Burn ──────────────────────────────────────────────────────────────────

    function test_burn_reducesSupply() public {
        vm.prank(owner);
        token.mint(alice, 1_000 * 1e18);

        vm.prank(alice);
        token.burn(500 * 1e18);

        assertEq(token.balanceOf(alice), 500 * 1e18);
        assertEq(token.totalSupply(), 500 * 1e18);
    }

    function test_burn_revertsInsufficientBalance() public {
        vm.prank(owner);
        token.mint(alice, 100 * 1e18);

        vm.prank(alice);
        vm.expectRevert();
        token.burn(101 * 1e18);
    }

    // ── Standard ERC-20 ───────────────────────────────────────────────────────

    function test_transfer() public {
        vm.prank(owner);
        token.mint(alice, 100 * 1e18);

        vm.prank(alice);
        token.transfer(bob, 40 * 1e18);

        assertEq(token.balanceOf(alice), 60 * 1e18);
        assertEq(token.balanceOf(bob), 40 * 1e18);
    }

    function test_approve_and_transferFrom() public {
        vm.prank(owner);
        token.mint(alice, 100 * 1e18);

        vm.prank(alice);
        token.approve(bob, 50 * 1e18);

        vm.prank(bob);
        token.transferFrom(alice, bob, 50 * 1e18);

        assertEq(token.balanceOf(alice), 50 * 1e18);
        assertEq(token.balanceOf(bob), 50 * 1e18);
    }

    // ── Metadata ──────────────────────────────────────────────────────────────

    function test_nameAndSymbol() public view {
        assertEq(token.name(), "ClawStreet");
        assertEq(token.symbol(), "CLAW");
        assertEq(token.decimals(), 18);
    }
}
