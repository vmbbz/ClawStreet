// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Test.sol";
import { ERC1967Proxy } from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";
import { ClawStreetCallVault } from "../contracts/ClawStreetCallVault.sol";

contract MockToken {
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    function mint(address to, uint256 amount) external { balanceOf[to] += amount; }

    function transfer(address to, uint256 amount) external returns (bool) {
        require(balanceOf[msg.sender] >= amount);
        balanceOf[msg.sender] -= amount;
        balanceOf[to] += amount;
        return true;
    }

    function transferFrom(address from, address to, uint256 amount) external returns (bool) {
        require(balanceOf[from] >= amount);
        require(allowance[from][msg.sender] >= amount);
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

contract ClawStreetCallVaultTest is Test {
    ClawStreetCallVault public vault;
    MockToken public underlying;  // e.g. WETH
    MockToken public usdc;         // premium / strike token

    address public admin  = makeAddr("admin");
    address public writer = makeAddr("writer");
    address public buyer  = makeAddr("buyer");

    uint256 constant AMOUNT  = 1 * 1e18;    // 1 WETH
    uint256 constant STRIKE  = 2_200e6;     // $2200 USDC
    uint256 constant PREMIUM = 50e6;        // $50 USDC
    uint256 constant EXPIRY_DELTA = 7 days;

    function setUp() public {
        underlying = new MockToken();
        usdc       = new MockToken();

        vm.startPrank(admin);
        ClawStreetCallVault impl = new ClawStreetCallVault();
        bytes memory init = abi.encodeCall(ClawStreetCallVault.initialize, (address(usdc)));
        ERC1967Proxy proxy = new ERC1967Proxy(address(impl), init);
        vault = ClawStreetCallVault(address(proxy));
        vm.stopPrank();

        underlying.mint(writer, 10e18);
        usdc.mint(buyer,        10_000e6);
    }

    // ── writeCoveredCall ──────────────────────────────────────────────────────

    function test_write_locksUnderlying() public {
        uint256 optId = _write();

        assertEq(underlying.balanceOf(address(vault)), AMOUNT);
        (address w, address b, address uAddr, uint256 amt, uint256 strike, uint256 expiry, uint256 prem, bool exercised, bool active) = vault.options(optId);
        assertEq(w, writer);
        assertEq(b, address(0));
        assertEq(uAddr, address(underlying));
        assertEq(amt, AMOUNT);
        assertEq(strike, STRIKE);
        assertTrue(expiry > block.timestamp);
        assertEq(prem, PREMIUM);
        assertFalse(exercised);
        assertTrue(active);
    }

    function test_write_revertsExpiredExpiry() public {
        vm.prank(writer);
        underlying.approve(address(vault), AMOUNT);
        vm.prank(writer);
        vm.expectRevert("Expiry must be in future");
        vault.writeCoveredCall(address(underlying), AMOUNT, STRIKE, block.timestamp - 1, PREMIUM);
    }

    function test_write_revertsZeroAmount() public {
        vm.prank(writer);
        underlying.approve(address(vault), AMOUNT);
        vm.prank(writer);
        vm.expectRevert("Amount must be > 0");
        vault.writeCoveredCall(address(underlying), 0, STRIKE, block.timestamp + EXPIRY_DELTA, PREMIUM);
    }

    // ── cancelOption ──────────────────────────────────────────────────────────

    function test_cancel_returnsUnderlying() public {
        uint256 optId = _write();

        vm.prank(writer);
        vault.cancelOption(optId);

        assertEq(underlying.balanceOf(writer), 10e18); // all back
        (,,,,,,,, bool active) = vault.options(optId);
        assertFalse(active);
    }

    function test_cancel_revertsIfNotWriter() public {
        uint256 optId = _write();
        vm.prank(buyer);
        vm.expectRevert("Not writer");
        vault.cancelOption(optId);
    }

    function test_cancel_revertsIfBought() public {
        uint256 optId = _write();
        _buy(optId);

        vm.prank(writer);
        vm.expectRevert("Cannot cancel");
        vault.cancelOption(optId);
    }

    // ── buyOption ─────────────────────────────────────────────────────────────

    function test_buy_transfersPremiumToWriter() public {
        uint256 optId = _write();
        uint256 writerBefore = usdc.balanceOf(writer);

        _buy(optId);

        assertEq(usdc.balanceOf(writer), writerBefore + PREMIUM);
        (,address b,,,,,,,) = vault.options(optId);
        assertEq(b, buyer);
    }

    function test_buy_revertsIfAlreadyBought() public {
        uint256 optId = _write();
        _buy(optId);

        address charlie = makeAddr("charlie");
        usdc.mint(charlie, 10_000e6);
        vm.prank(charlie);
        usdc.approve(address(vault), PREMIUM);
        vm.prank(charlie);
        vm.expectRevert("Not available");
        vault.buyOption(optId);
    }

    function test_buy_revertsIfExpired() public {
        uint256 optId = _write();
        vm.warp(block.timestamp + EXPIRY_DELTA + 1);

        vm.prank(buyer);
        usdc.approve(address(vault), PREMIUM);
        vm.prank(buyer);
        vm.expectRevert("Expired");
        vault.buyOption(optId);
    }

    // ── exercise ──────────────────────────────────────────────────────────────

    function test_exercise_buyerReceivesUnderlying() public {
        uint256 optId = _write();
        _buy(optId);

        vm.prank(buyer);
        usdc.approve(address(vault), STRIKE);
        vm.prank(buyer);
        vault.exercise(optId);

        assertEq(underlying.balanceOf(buyer), AMOUNT);
        (,,,,,,, bool exercised, bool active) = vault.options(optId);
        assertTrue(exercised);
        assertFalse(active);
    }

    function test_exercise_writerReceivesStrike() public {
        uint256 optId = _write();
        _buy(optId);

        uint256 writerBefore = usdc.balanceOf(writer);
        vm.prank(buyer);
        usdc.approve(address(vault), STRIKE);
        vm.prank(buyer);
        vault.exercise(optId);

        assertEq(usdc.balanceOf(writer), writerBefore + STRIKE);
    }

    function test_exercise_revertsIfExpired() public {
        uint256 optId = _write();
        _buy(optId);
        vm.warp(block.timestamp + EXPIRY_DELTA + 1);

        vm.prank(buyer);
        usdc.approve(address(vault), STRIKE);
        vm.prank(buyer);
        vm.expectRevert("Expired");
        vault.exercise(optId);
    }

    function test_exercise_revertsIfNotBuyer() public {
        uint256 optId = _write();
        _buy(optId);

        vm.prank(writer);
        vm.expectRevert("Not buyer");
        vault.exercise(optId);
    }

    // ── reclaimUnderlying ─────────────────────────────────────────────────────

    function test_reclaim_afterExpiry() public {
        uint256 optId = _write();
        _buy(optId);
        vm.warp(block.timestamp + EXPIRY_DELTA + 1);

        vm.prank(writer);
        vault.reclaimUnderlying(optId);

        assertEq(underlying.balanceOf(writer), 10e18);
        (,,,,,,,, bool active) = vault.options(optId);
        assertFalse(active);
    }

    function test_reclaim_revertsBeforeExpiry() public {
        uint256 optId = _write();
        _buy(optId);

        vm.prank(writer);
        vm.expectRevert("Not expired");
        vault.reclaimUnderlying(optId);
    }

    function test_reclaim_revertsIfExercised() public {
        uint256 optId = _write();
        _buy(optId);

        vm.prank(buyer);
        usdc.approve(address(vault), STRIKE);
        vm.prank(buyer);
        vault.exercise(optId);

        vm.warp(block.timestamp + EXPIRY_DELTA + 1);
        vm.prank(writer);
        vm.expectRevert("Already exercised");
        vault.reclaimUnderlying(optId);
    }

    // ── Helpers ───────────────────────────────────────────────────────────────

    function _write() internal returns (uint256 optId) {
        vm.prank(writer);
        underlying.approve(address(vault), AMOUNT);
        vm.prank(writer);
        optId = vault.writeCoveredCall(
            address(underlying),
            AMOUNT,
            STRIKE,
            block.timestamp + EXPIRY_DELTA,
            PREMIUM
        );
    }

    function _buy(uint256 optId) internal {
        vm.prank(buyer);
        usdc.approve(address(vault), PREMIUM);
        vm.prank(buyer);
        vault.buyOption(optId);
    }
}
