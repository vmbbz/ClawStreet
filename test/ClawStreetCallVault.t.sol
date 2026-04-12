// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Test.sol";
import { ERC1967Proxy } from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";
import { ClawStreetCallVault } from "../contracts/ClawStreetCallVault.sol";

// ─── Shared mock ERC-20 (underlying and premium) ─────────────────────────────

contract MockToken {
    string public name;
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    constructor(string memory _name) { name = _name; }

    function mint(address to, uint256 amount) external { balanceOf[to] += amount; }

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

// ─── Test suite ───────────────────────────────────────────────────────────────

contract ClawStreetCallVaultTest is Test {
    ClawStreetCallVault public vault;
    MockToken public underlying; // e.g. WETH
    MockToken public usdc;       // premium / strike token

    address public admin  = makeAddr("admin");
    address public writer = makeAddr("writer");
    address public buyer  = makeAddr("buyer");

    uint256 constant AMOUNT        = 1e18;      // 1 WETH
    uint256 constant STRIKE        = 2_200e6;   // $2200 USDC
    uint256 constant PREMIUM       = 50e6;      // $50 USDC
    uint256 constant EXPIRY_DELTA  = 7 days;

    // ─── Setup ────────────────────────────────────────────────────────────────

    function setUp() public {
        underlying = new MockToken("WETH");
        usdc       = new MockToken("USDC");

        vm.startPrank(admin);
        ClawStreetCallVault impl = new ClawStreetCallVault();
        bytes memory init = abi.encodeCall(ClawStreetCallVault.initialize, (address(usdc)));
        ERC1967Proxy proxy = new ERC1967Proxy(address(impl), init);
        vault = ClawStreetCallVault(address(proxy));
        vm.stopPrank();

        underlying.mint(writer, 100e18);
        usdc.mint(buyer, 1_000_000e6);
        usdc.mint(writer, 1_000_000e6); // needed for self-dealing tests
    }

    // ─── writeCoveredCall ─────────────────────────────────────────────────────

    function test_write_locksUnderlying() public {
        uint256 writerBefore = underlying.balanceOf(writer);
        uint256 optId = _write();

        assertEq(underlying.balanceOf(address(vault)), AMOUNT, "vault should hold AMOUNT");
        assertEq(underlying.balanceOf(writer), writerBefore - AMOUNT, "writer lost AMOUNT");
        // Verify option.active and option.amount
        (,,,uint256 amt,,,,, bool active) = vault.options(optId);
        assertEq(amt, AMOUNT);
        assertTrue(active);
    }

    function test_write_allFieldsCorrect() public {
        uint256 expiry = block.timestamp + EXPIRY_DELTA;
        vm.prank(writer);
        underlying.approve(address(vault), AMOUNT);
        vm.prank(writer);
        uint256 optId = vault.writeCoveredCall(address(underlying), AMOUNT, STRIKE, expiry, PREMIUM);

        (
            address w,
            address b,
            address uAddr,
            uint256 amt,
            uint256 strike,
            uint256 exp,
            uint256 prem,
            bool exercised,
            bool active
        ) = vault.options(optId);

        assertEq(w, writer,              "writer field");
        assertEq(b, address(0),          "buyer should be address(0)");
        assertEq(uAddr, address(underlying), "underlying field");
        assertEq(amt, AMOUNT,            "amount field");
        assertEq(strike, STRIKE,         "strike field");
        assertEq(exp, expiry,            "expiry field");
        assertEq(prem, PREMIUM,          "premium field");
        assertFalse(exercised,           "exercised should be false");
        assertTrue(active,               "active should be true");
    }

    function test_write_returnsOptionId() public {
        uint256 optId = _write();
        assertEq(optId, 0, "first option ID must be 0");
    }

    function test_write_incrementsOptionCounter() public {
        assertEq(vault.optionCounter(), 0);
        _write();
        assertEq(vault.optionCounter(), 1);
        _write();
        assertEq(vault.optionCounter(), 2);
    }

    function test_write_revertsExpiredExpiry() public {
        vm.prank(writer);
        underlying.approve(address(vault), AMOUNT);
        vm.prank(writer);
        vm.expectRevert("Expiry must be in future");
        vault.writeCoveredCall(address(underlying), AMOUNT, STRIKE, block.timestamp - 1, PREMIUM);
    }

    function test_write_revertsExpiryExactlyNow() public {
        vm.prank(writer);
        underlying.approve(address(vault), AMOUNT);
        vm.prank(writer);
        vm.expectRevert("Expiry must be in future");
        vault.writeCoveredCall(address(underlying), AMOUNT, STRIKE, block.timestamp, PREMIUM);
    }

    function test_write_revertsZeroAmount() public {
        vm.prank(writer);
        underlying.approve(address(vault), AMOUNT);
        vm.prank(writer);
        vm.expectRevert("Amount must be > 0");
        vault.writeCoveredCall(address(underlying), 0, STRIKE, block.timestamp + EXPIRY_DELTA, PREMIUM);
    }

    function test_write_revertsZeroStrike() public {
        vm.prank(writer);
        underlying.approve(address(vault), AMOUNT);
        vm.prank(writer);
        vm.expectRevert("Strike must be > 0");
        vault.writeCoveredCall(address(underlying), AMOUNT, 0, block.timestamp + EXPIRY_DELTA, PREMIUM);
    }

    function test_write_revertsZeroPremium() public {
        vm.prank(writer);
        underlying.approve(address(vault), AMOUNT);
        vm.prank(writer);
        vm.expectRevert("Premium must be > 0");
        vault.writeCoveredCall(address(underlying), AMOUNT, STRIKE, block.timestamp + EXPIRY_DELTA, 0);
    }

    function test_write_multipleOptions_differentUnderlyings() public {
        MockToken tokenA = new MockToken("TKA");
        MockToken tokenB = new MockToken("TKB");
        MockToken tokenC = new MockToken("TKC");

        tokenA.mint(writer, 10e18);
        tokenB.mint(writer, 10e18);
        tokenC.mint(writer, 10e18);

        // Write 3 options with 3 different underlyings
        vm.prank(writer);
        tokenA.approve(address(vault), AMOUNT);
        vm.prank(writer);
        uint256 id0 = vault.writeCoveredCall(address(tokenA), AMOUNT, STRIKE, block.timestamp + EXPIRY_DELTA, PREMIUM);

        vm.prank(writer);
        tokenB.approve(address(vault), AMOUNT * 2);
        vm.prank(writer);
        uint256 id1 = vault.writeCoveredCall(address(tokenB), AMOUNT * 2, STRIKE + 100e6, block.timestamp + EXPIRY_DELTA, PREMIUM * 2);

        vm.prank(writer);
        tokenC.approve(address(vault), AMOUNT / 2);
        vm.prank(writer);
        uint256 id2 = vault.writeCoveredCall(address(tokenC), AMOUNT / 2, STRIKE - 100e6, block.timestamp + EXPIRY_DELTA, PREMIUM / 2);

        assertEq(id0, 0);
        assertEq(id1, 1);
        assertEq(id2, 2);

        (,, address u0, uint256 a0, uint256 s0,, uint256 p0,,) = vault.options(id0);
        (,, address u1, uint256 a1, uint256 s1,, uint256 p1,,) = vault.options(id1);
        (,, address u2, uint256 a2, uint256 s2,, uint256 p2,,) = vault.options(id2);

        assertEq(u0, address(tokenA));
        assertEq(u1, address(tokenB));
        assertEq(u2, address(tokenC));

        assertEq(a0, AMOUNT);        assertEq(s0, STRIKE);         assertEq(p0, PREMIUM);
        assertEq(a1, AMOUNT * 2);    assertEq(s1, STRIKE + 100e6); assertEq(p1, PREMIUM * 2);
        assertEq(a2, AMOUNT / 2);    assertEq(s2, STRIKE - 100e6); assertEq(p2, PREMIUM / 2);

        assertEq(tokenA.balanceOf(address(vault)), AMOUNT);
        assertEq(tokenB.balanceOf(address(vault)), AMOUNT * 2);
        assertEq(tokenC.balanceOf(address(vault)), AMOUNT / 2);
    }

    function test_write_emitsOptionWrittenEvent() public {
        vm.prank(writer);
        underlying.approve(address(vault), AMOUNT);

        vm.expectEmit(true, true, true, true);
        emit ClawStreetCallVault.OptionWritten(0, writer, AMOUNT, STRIKE, PREMIUM);

        vm.prank(writer);
        vault.writeCoveredCall(address(underlying), AMOUNT, STRIKE, block.timestamp + EXPIRY_DELTA, PREMIUM);
    }

    // ─── cancelOption ─────────────────────────────────────────────────────────

    function test_cancel_returnsUnderlying_exactly() public {
        uint256 writerBefore = underlying.balanceOf(writer);
        uint256 optId = _write();
        // writer locked AMOUNT
        assertEq(underlying.balanceOf(writer), writerBefore - AMOUNT);

        vm.prank(writer);
        vault.cancelOption(optId);

        assertEq(underlying.balanceOf(writer), writerBefore, "underlying must be fully returned");
        assertEq(underlying.balanceOf(address(vault)), 0, "vault must be empty");
    }

    function test_cancel_setsInactive() public {
        uint256 optId = _write();
        vm.prank(writer);
        vault.cancelOption(optId);

        (,,,,,,,, bool active) = vault.options(optId);
        assertFalse(active, "option must be inactive after cancel");
    }

    function test_cancel_revertsIfBought() public {
        uint256 optId = _write();
        _buy(optId);

        vm.prank(writer);
        vm.expectRevert("Cannot cancel");
        vault.cancelOption(optId);
    }

    function test_cancel_revertsIfNotWriter() public {
        uint256 optId = _write();
        vm.prank(buyer);
        vm.expectRevert("Not writer");
        vault.cancelOption(optId);
    }

    function test_cancel_revertsIfAlreadyCancelled() public {
        uint256 optId = _write();
        vm.prank(writer);
        vault.cancelOption(optId);

        // Second cancel: option.active == false, buyer == address(0), so "Cannot cancel"
        vm.prank(writer);
        vm.expectRevert("Cannot cancel");
        vault.cancelOption(optId);
    }

    function test_cancel_revertsIfExercised() public {
        uint256 optId = _write();
        _buy(optId);
        _exercise(optId);

        // active is false, buyer != 0 → "Cannot cancel" (active check fails first)
        vm.prank(writer);
        vm.expectRevert("Cannot cancel");
        vault.cancelOption(optId);
    }

    function test_cancel_afterExpiry_unbought() public {
        uint256 optId = _write();

        // Fast-forward past expiry without buying
        vm.warp(block.timestamp + EXPIRY_DELTA + 1);

        uint256 writerBefore = underlying.balanceOf(writer);
        // cancelOption has no expiry check — only requires active && buyer == 0
        vm.prank(writer);
        vault.cancelOption(optId); // must not revert

        assertEq(underlying.balanceOf(writer), writerBefore + AMOUNT, "underlying returned after expiry cancel");
        (,,,,,,,, bool active) = vault.options(optId);
        assertFalse(active);
    }

    function test_cancel_emitsOptionCancelledEvent() public {
        uint256 optId = _write();

        vm.expectEmit(true, true, true, true);
        emit ClawStreetCallVault.OptionCancelled(optId);

        vm.prank(writer);
        vault.cancelOption(optId);
    }

    // ─── buyOption ────────────────────────────────────────────────────────────

    function test_buy_transfersPremiumToWriter_exactly() public {
        uint256 optId = _write();
        uint256 writerBefore = usdc.balanceOf(writer);

        _buy(optId);

        assertEq(usdc.balanceOf(writer), writerBefore + PREMIUM, "writer must receive exact premium");
        assertEq(usdc.balanceOf(buyer), 1_000_000e6 - PREMIUM, "buyer paid exact premium");
    }

    function test_buy_setsBuyer() public {
        uint256 optId = _write();
        _buy(optId);

        (, address b,,,,,,,) = vault.options(optId);
        assertEq(b, buyer, "option.buyer must be set to buyer");
    }

    function test_buy_doesNotTransferUnderlying() public {
        uint256 optId = _write();
        uint256 vaultUnderlyingBefore = underlying.balanceOf(address(vault));

        _buy(optId);

        assertEq(underlying.balanceOf(address(vault)), vaultUnderlyingBefore, "underlying must stay in vault after buy");
        assertEq(underlying.balanceOf(buyer), 0, "buyer should not receive underlying on buy");
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

    function test_buy_revertsIfCancelled() public {
        uint256 optId = _write();
        vm.prank(writer);
        vault.cancelOption(optId);

        vm.prank(buyer);
        usdc.approve(address(vault), PREMIUM);
        vm.prank(buyer);
        vm.expectRevert("Not available");
        vault.buyOption(optId);
    }

    function test_buy_revertsIfNotActive() public {
        // After exercise: active=false
        uint256 optId = _write();
        _buy(optId);
        _exercise(optId);

        address charlie = makeAddr("charlie");
        usdc.mint(charlie, 10_000e6);
        vm.prank(charlie);
        usdc.approve(address(vault), PREMIUM);
        vm.prank(charlie);
        vm.expectRevert("Not available");
        vault.buyOption(optId);
    }

    function test_buy_atExactExpiry_reverts() public {
        uint256 expiry = block.timestamp + EXPIRY_DELTA;
        vm.prank(writer);
        underlying.approve(address(vault), AMOUNT);
        vm.prank(writer);
        uint256 optId = vault.writeCoveredCall(address(underlying), AMOUNT, STRIKE, expiry, PREMIUM);

        // block.timestamp == expiry: strict < fails
        vm.warp(expiry);

        vm.prank(buyer);
        usdc.approve(address(vault), PREMIUM);
        vm.prank(buyer);
        vm.expectRevert("Expired");
        vault.buyOption(optId);
    }

    function test_buy_oneSec_beforeExpiry_succeeds() public {
        uint256 expiry = block.timestamp + EXPIRY_DELTA;
        vm.prank(writer);
        underlying.approve(address(vault), AMOUNT);
        vm.prank(writer);
        uint256 optId = vault.writeCoveredCall(address(underlying), AMOUNT, STRIKE, expiry, PREMIUM);

        vm.warp(expiry - 1);

        vm.prank(buyer);
        usdc.approve(address(vault), PREMIUM);
        vm.prank(buyer);
        vault.buyOption(optId); // must not revert

        (, address b,,,,,,,) = vault.options(optId);
        assertEq(b, buyer);
    }

    function test_buy_emitsOptionBoughtEvent() public {
        uint256 optId = _write();

        vm.prank(buyer);
        usdc.approve(address(vault), PREMIUM);

        vm.expectEmit(true, true, true, true);
        emit ClawStreetCallVault.OptionBought(optId, buyer);

        vm.prank(buyer);
        vault.buyOption(optId);
    }

    // ─── exercise ─────────────────────────────────────────────────────────────

    function test_exercise_buyerReceivesUnderlying_exactly() public {
        uint256 buyerUnderlyingBefore = underlying.balanceOf(buyer);
        uint256 optId = _write();
        _buy(optId);
        _exercise(optId);

        assertEq(underlying.balanceOf(buyer), buyerUnderlyingBefore + AMOUNT, "buyer must receive exact underlying amount");
        assertEq(underlying.balanceOf(address(vault)), 0, "vault underlying must be zero after exercise");
    }

    function test_exercise_writerReceivesStrike_exactly() public {
        uint256 writerUsdcBefore = usdc.balanceOf(writer);
        uint256 optId = _write();
        _buy(optId);
        // writer received PREMIUM at buy time
        uint256 writerAfterBuy = usdc.balanceOf(writer);
        assertEq(writerAfterBuy, writerUsdcBefore + PREMIUM);

        _exercise(optId);

        assertEq(usdc.balanceOf(writer), writerAfterBuy + STRIKE, "writer must receive exact strike");
    }

    function test_exercise_setsExercisedAndInactive() public {
        uint256 optId = _write();
        _buy(optId);
        _exercise(optId);

        (,,,,,,, bool exercised, bool active) = vault.options(optId);
        assertTrue(exercised, "exercised must be true");
        assertFalse(active,   "active must be false");
    }

    function test_exercise_revertsIfNotBuyer() public {
        uint256 optId = _write();
        _buy(optId);

        // writer is not the buyer
        vm.prank(writer);
        usdc.approve(address(vault), STRIKE);
        vm.prank(writer);
        vm.expectRevert("Not buyer");
        vault.exercise(optId);
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

    function test_exercise_revertsIfAlreadyExercised() public {
        uint256 optId = _write();
        _buy(optId);

        vm.prank(buyer);
        usdc.approve(address(vault), STRIKE * 2);
        vm.prank(buyer);
        vault.exercise(optId);

        vm.prank(buyer);
        vm.expectRevert("Already exercised");
        vault.exercise(optId);
    }

    function test_exercise_revertsIfNoBuyer() public {
        // Exercise before any buy: buyer == address(0), so "Not buyer"
        uint256 optId = _write();

        vm.prank(buyer);
        usdc.approve(address(vault), STRIKE);
        vm.prank(buyer);
        vm.expectRevert("Not buyer");
        vault.exercise(optId);
    }

    function test_exercise_atExactExpiry_reverts() public {
        uint256 expiry = block.timestamp + EXPIRY_DELTA;
        vm.prank(writer);
        underlying.approve(address(vault), AMOUNT);
        vm.prank(writer);
        uint256 optId = vault.writeCoveredCall(address(underlying), AMOUNT, STRIKE, expiry, PREMIUM);

        _buy(optId);

        // block.timestamp == expiry: strict < fails
        vm.warp(expiry);

        vm.prank(buyer);
        usdc.approve(address(vault), STRIKE);
        vm.prank(buyer);
        vm.expectRevert("Expired");
        vault.exercise(optId);
    }

    function test_exercise_oneSec_beforeExpiry_succeeds() public {
        uint256 expiry = block.timestamp + EXPIRY_DELTA;
        vm.prank(writer);
        underlying.approve(address(vault), AMOUNT);
        vm.prank(writer);
        uint256 optId = vault.writeCoveredCall(address(underlying), AMOUNT, STRIKE, expiry, PREMIUM);

        _buy(optId);

        vm.warp(expiry - 1);

        vm.prank(buyer);
        usdc.approve(address(vault), STRIKE);
        vm.prank(buyer);
        vault.exercise(optId); // must not revert

        (,,,,,,, bool exercised,) = vault.options(optId);
        assertTrue(exercised);
    }

    function test_exercise_emitsOptionExercisedEvent() public {
        uint256 optId = _write();
        _buy(optId);

        vm.prank(buyer);
        usdc.approve(address(vault), STRIKE);

        vm.expectEmit(true, true, true, true);
        emit ClawStreetCallVault.OptionExercised(optId, buyer);

        vm.prank(buyer);
        vault.exercise(optId);
    }

    // ─── reclaimUnderlying ────────────────────────────────────────────────────

    function test_reclaim_afterExpiry_bought_notExercised() public {
        uint256 optId = _write();
        _buy(optId);

        // Buyer holds option but does not exercise — writer reclaims after expiry
        vm.warp(block.timestamp + EXPIRY_DELTA + 1);

        uint256 writerBefore = underlying.balanceOf(writer);
        vm.prank(writer);
        vault.reclaimUnderlying(optId);

        assertEq(underlying.balanceOf(writer), writerBefore + AMOUNT, "writer reclaims exact underlying");
    }

    function test_reclaim_afterExpiry_noBuyer() public {
        // Option never bought
        uint256 optId = _write();
        vm.warp(block.timestamp + EXPIRY_DELTA + 1);

        uint256 writerBefore = underlying.balanceOf(writer);
        vm.prank(writer);
        vault.reclaimUnderlying(optId);

        assertEq(underlying.balanceOf(writer), writerBefore + AMOUNT, "writer reclaims from unbought option");
    }

    function test_reclaim_returnsUnderlying_exactly() public {
        uint256 writerStart = underlying.balanceOf(writer);
        uint256 optId = _write();
        assertEq(underlying.balanceOf(writer), writerStart - AMOUNT);

        vm.warp(block.timestamp + EXPIRY_DELTA + 1);
        vm.prank(writer);
        vault.reclaimUnderlying(optId);

        assertEq(underlying.balanceOf(writer), writerStart, "full underlying returned");
        assertEq(underlying.balanceOf(address(vault)), 0, "vault empty");
    }

    function test_reclaim_setsInactive() public {
        uint256 optId = _write();
        vm.warp(block.timestamp + EXPIRY_DELTA + 1);

        vm.prank(writer);
        vault.reclaimUnderlying(optId);

        (,,,,,,,, bool active) = vault.options(optId);
        assertFalse(active, "option must be inactive after reclaim");
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
        _exercise(optId);

        vm.warp(block.timestamp + EXPIRY_DELTA + 1);
        vm.prank(writer);
        vm.expectRevert("Already exercised");
        vault.reclaimUnderlying(optId);
    }

    function test_reclaim_revertsIfAlreadyReclaimed() public {
        uint256 optId = _write();
        vm.warp(block.timestamp + EXPIRY_DELTA + 1);

        vm.prank(writer);
        vault.reclaimUnderlying(optId);

        // Second reclaim: option.active == false → "Not active"
        vm.prank(writer);
        vm.expectRevert("Not active");
        vault.reclaimUnderlying(optId);
    }

    function test_reclaim_revertsIfNotWriter() public {
        uint256 optId = _write();
        vm.warp(block.timestamp + EXPIRY_DELTA + 1);

        vm.prank(buyer);
        vm.expectRevert("Not writer");
        vault.reclaimUnderlying(optId);
    }

    function test_reclaim_revertsIfCancelled() public {
        uint256 optId = _write();
        vm.prank(writer);
        vault.cancelOption(optId);

        vm.warp(block.timestamp + EXPIRY_DELTA + 1);
        vm.prank(writer);
        vm.expectRevert("Not active");
        vault.reclaimUnderlying(optId);
    }

    function test_reclaim_emitsUnderlyingReclaimedEvent() public {
        uint256 optId = _write();
        vm.warp(block.timestamp + EXPIRY_DELTA + 1);

        vm.expectEmit(true, true, true, true);
        emit ClawStreetCallVault.UnderlyingReclaimed(optId);

        vm.prank(writer);
        vault.reclaimUnderlying(optId);
    }

    // ─── State machine completeness ───────────────────────────────────────────

    function test_stateMachine_writeCancel() public {
        uint256 optId = _write();
        vm.prank(writer);
        vault.cancelOption(optId);

        (address w,,,,,,, bool exercised, bool active) = vault.options(optId);
        assertEq(w, writer);
        assertFalse(exercised);
        assertFalse(active);
        assertEq(underlying.balanceOf(address(vault)), 0);
    }

    function test_stateMachine_writeBuyExercise() public {
        uint256 optId = _write();
        _buy(optId);
        _exercise(optId);

        (,,,,,,, bool exercised, bool active) = vault.options(optId);
        assertTrue(exercised);
        assertFalse(active);
        assertEq(underlying.balanceOf(buyer), AMOUNT);
    }

    function test_stateMachine_writeBuyReclaim() public {
        uint256 optId = _write();
        _buy(optId);

        vm.warp(block.timestamp + EXPIRY_DELTA + 1);
        vm.prank(writer);
        vault.reclaimUnderlying(optId);

        (,,,,,,, bool exercised, bool active) = vault.options(optId);
        assertFalse(exercised);
        assertFalse(active);
        assertEq(underlying.balanceOf(writer), 100e18); // all returned
    }

    function test_stateMachine_writeReclaim() public {
        uint256 optId = _write();
        // No buy
        vm.warp(block.timestamp + EXPIRY_DELTA + 1);
        vm.prank(writer);
        vault.reclaimUnderlying(optId);

        (,,,,,,, bool exercised, bool active) = vault.options(optId);
        assertFalse(exercised);
        assertFalse(active);
    }

    function test_stateMachine_writeBuyCancel_reverts() public {
        uint256 optId = _write();
        _buy(optId);

        vm.prank(writer);
        vm.expectRevert("Cannot cancel");
        vault.cancelOption(optId);
    }

    function test_stateMachine_writeExerciseWithoutBuy_reverts() public {
        uint256 optId = _write();

        // buyer is not the actual buyer (option.buyer == address(0))
        vm.prank(buyer);
        usdc.approve(address(vault), STRIKE);
        vm.prank(buyer);
        vm.expectRevert("Not buyer");
        vault.exercise(optId);
    }

    // ─── Independence of options ──────────────────────────────────────────────

    function test_multipleOptions_independentLifecycles() public {
        address buyer1 = makeAddr("buyer1");
        address buyer2 = makeAddr("buyer2");
        usdc.mint(buyer1, 1_000_000e6);
        usdc.mint(buyer2, 1_000_000e6);

        // Write 3 options (same underlying for simplicity, 3 separate amounts locked)
        vm.prank(writer);
        underlying.approve(address(vault), AMOUNT * 3);

        vm.prank(writer);
        uint256 opt0 = vault.writeCoveredCall(address(underlying), AMOUNT, STRIKE, block.timestamp + EXPIRY_DELTA, PREMIUM);
        vm.prank(writer);
        uint256 opt1 = vault.writeCoveredCall(address(underlying), AMOUNT, STRIKE, block.timestamp + EXPIRY_DELTA, PREMIUM);
        vm.prank(writer);
        uint256 opt2 = vault.writeCoveredCall(address(underlying), AMOUNT, STRIKE, block.timestamp + EXPIRY_DELTA, PREMIUM);

        // buyer1 buys opt0
        vm.prank(buyer1);
        usdc.approve(address(vault), PREMIUM);
        vm.prank(buyer1);
        vault.buyOption(opt0);

        // buyer2 buys opt2
        vm.prank(buyer2);
        usdc.approve(address(vault), PREMIUM);
        vm.prank(buyer2);
        vault.buyOption(opt2);

        // buyer1 exercises opt0
        vm.prank(buyer1);
        usdc.approve(address(vault), STRIKE);
        vm.prank(buyer1);
        vault.exercise(opt0);

        // writer reclaims opt1 (expired, no buyer)
        vm.warp(block.timestamp + EXPIRY_DELTA + 1);
        vm.prank(writer);
        vault.reclaimUnderlying(opt1);

        // buyer2 tries to exercise opt2 — but it's expired now
        vm.prank(buyer2);
        usdc.approve(address(vault), STRIKE);
        vm.prank(buyer2);
        vm.expectRevert("Expired");
        vault.exercise(opt2);

        // writer reclaims opt2 (bought but unexercised)
        vm.prank(writer);
        vault.reclaimUnderlying(opt2);

        // Verify independent state
        (,,,,,,, bool ex0, bool a0) = vault.options(opt0);
        (,,,,,,, bool ex1, bool a1) = vault.options(opt1);
        (,,,,,,, bool ex2, bool a2) = vault.options(opt2);

        assertTrue(ex0);  assertFalse(a0); // exercised
        assertFalse(ex1); assertFalse(a1); // reclaimed
        assertFalse(ex2); assertFalse(a2); // reclaimed (bought but not exercised)

        assertEq(underlying.balanceOf(buyer1), AMOUNT, "buyer1 got underlying from opt0");
        assertEq(underlying.balanceOf(buyer2), 0,      "buyer2 got nothing (expired)");
    }

    // ─── Self-dealing ─────────────────────────────────────────────────────────

    function test_writerBuysOwnOption() public {
        // Writer buys their own option: premium pays writer→writer (net zero on usdc)
        // Then writer exercises: pays strike to self, receives underlying (net zero on usdc, recovers underlying)
        uint256 writerUnderlyingStart = underlying.balanceOf(writer);
        uint256 writerUsdcStart       = usdc.balanceOf(writer);

        uint256 optId = _write();

        // Writer has lost AMOUNT of underlying to vault
        assertEq(underlying.balanceOf(writer), writerUnderlyingStart - AMOUNT);

        // Writer buys own option (pays premium to self)
        vm.prank(writer);
        usdc.approve(address(vault), PREMIUM);
        vm.prank(writer);
        vault.buyOption(optId);

        // USDC net change: paid PREMIUM, received PREMIUM → net 0
        assertEq(usdc.balanceOf(writer), writerUsdcStart, "usdc net 0 after self-buy");

        (, address b,,,,,,,) = vault.options(optId);
        assertEq(b, writer, "buyer is writer");

        // Writer exercises own option (pays strike to self, receives underlying)
        vm.prank(writer);
        usdc.approve(address(vault), STRIKE);
        vm.prank(writer);
        vault.exercise(optId);

        // USDC net: paid strike, received strike → net 0
        assertEq(usdc.balanceOf(writer), writerUsdcStart, "usdc net 0 after self-exercise");

        // Underlying: writer wrote (lost AMOUNT), exercised (gained AMOUNT) → net 0
        assertEq(underlying.balanceOf(writer), writerUnderlyingStart, "underlying net 0 after self-dealing");
    }

    // ─── Upgrade / access control ─────────────────────────────────────────────

    function test_upgrade_onlyUpgraderRole() public {
        // Deploy a new implementation
        ClawStreetCallVault newImpl = new ClawStreetCallVault();

        // Non-upgrader calling upgrade must revert
        address nonUpgrader = makeAddr("nonUpgrader");
        vm.prank(nonUpgrader);
        vm.expectRevert();
        vault.upgradeToAndCall(address(newImpl), "");
    }

    function test_initialize_cannotCallTwice() public {
        vm.expectRevert();
        vault.initialize(address(usdc));
    }

    // ─── Helpers ─────────────────────────────────────────────────────────────

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

    function _exercise(uint256 optId) internal {
        vm.prank(buyer);
        usdc.approve(address(vault), STRIKE);
        vm.prank(buyer);
        vault.exercise(optId);
    }
}
