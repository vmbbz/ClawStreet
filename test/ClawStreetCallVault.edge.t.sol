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

contract ClawStreetCallVaultEdgeTest is Test {
    ClawStreetCallVault public vault;
    MockToken public underlying;
    MockToken public usdc;

    address public admin  = makeAddr("admin");
    address public writer = makeAddr("writer");
    address public buyer  = makeAddr("buyer");

    uint256 constant AMOUNT        = 1e18;
    uint256 constant STRIKE        = 2_200e6;
    uint256 constant PREMIUM       = 50e6;
    uint256 constant EXPIRY_DELTA  = 7 days;

    function setUp() public {
        underlying = new MockToken();
        usdc       = new MockToken();

        vm.startPrank(admin);
        ClawStreetCallVault impl = new ClawStreetCallVault();
        bytes memory init = abi.encodeCall(ClawStreetCallVault.initialize, (address(usdc)));
        ERC1967Proxy proxy = new ERC1967Proxy(address(impl), init);
        vault = ClawStreetCallVault(address(proxy));
        vm.stopPrank();

        underlying.mint(writer, 100e18);
        usdc.mint(writer, 10_000e6);
        usdc.mint(buyer,  10_000e6);
    }

    // ─── AUDIT FINDING: LOW — zero premium reverts (FIXED) ───────────────────

    /// @notice writeCoveredCall now reverts with "Premium must be > 0" when premium=0.
    function test_zeroPremium_writeAndBuy() public {
        vm.prank(writer);
        underlying.approve(address(vault), AMOUNT);
        vm.prank(writer);
        vm.expectRevert("Premium must be > 0");
        vault.writeCoveredCall(
            address(underlying),
            AMOUNT,
            STRIKE,
            block.timestamp + EXPIRY_DELTA,
            0 /* zero premium */
        );
    }

    // ─── AUDIT FINDING: LOW — zero strike reverts (FIXED) ────────────────────

    /// @notice writeCoveredCall now reverts with "Strike must be > 0" when strike=0.
    function test_zeroStrike_exercise() public {
        vm.prank(writer);
        underlying.approve(address(vault), AMOUNT);
        vm.prank(writer);
        vm.expectRevert("Strike must be > 0");
        vault.writeCoveredCall(
            address(underlying),
            AMOUNT,
            0 /* zero strike */,
            block.timestamp + EXPIRY_DELTA,
            PREMIUM
        );
    }

    // ─── AUDIT FINDING: LOW — exercise at exact expiry now reverts (FIXED) ───

    /// @notice exercise now uses strict `<`, so at block.timestamp == expiry it MUST revert.
    function test_exercise_atExactExpiry() public {
        uint256 expiry = block.timestamp + EXPIRY_DELTA;
        uint256 optId  = _writeWith(AMOUNT, STRIKE, PREMIUM);

        _buy(optId);

        // Warp to exactly the expiry timestamp
        vm.warp(expiry);

        vm.prank(buyer);
        usdc.approve(address(vault), STRIKE);
        vm.prank(buyer);
        vm.expectRevert("Expired");
        vault.exercise(optId); // must REVERT — strict < means expiry timestamp is too late
    }

    // ─── AUDIT FINDING: LOW — buyOption at exact expiry reverts ──────────────

    /// @notice buyOption uses `block.timestamp < option.expiry` (strict),
    ///         so at block.timestamp == expiry the buy MUST revert.
    function test_buyOption_atExactExpiry_reverts() public {
        uint256 expiry = block.timestamp + EXPIRY_DELTA;
        uint256 optId  = _writeWith(AMOUNT, STRIKE, PREMIUM);

        // Warp to exactly the expiry timestamp
        vm.warp(expiry);

        vm.prank(buyer);
        usdc.approve(address(vault), PREMIUM);
        vm.prank(buyer);
        vm.expectRevert("Expired");
        vault.buyOption(optId);
    }

    // ─── AUDIT FINDING: LOW — cancelOption works after expiry (unbought) ──────

    /// @notice cancelOption has no expiry check — only requires buyer == address(0).
    ///         Writer CAN cancel an expired, unbought option (same effect as reclaim).
    function test_cancelOption_afterExpiry_unbought() public {
        uint256 optId = _writeWith(AMOUNT, STRIKE, PREMIUM);

        // Fast-forward past expiry without buying
        vm.warp(block.timestamp + EXPIRY_DELTA + 1);

        uint256 writerBefore = underlying.balanceOf(writer);

        vm.prank(writer);
        vault.cancelOption(optId); // must NOT revert

        assertEq(underlying.balanceOf(writer), writerBefore + AMOUNT);
        (,,,,,,,, bool active) = vault.options(optId);
        assertFalse(active);
    }

    // ─── MISSING TEST — reclaimUnderlying on unbought expired option ──────────

    /// @notice reclaimUnderlying should work when an option was never bought.
    ///         The option is still "active" (buyer == address(0)) and the
    ///         writer reclaims the underlying after expiry.
    function test_reclaimUnderlying_unboughtExpiredOption() public {
        uint256 optId = _writeWith(AMOUNT, STRIKE, PREMIUM);

        // No buyer — option expires unused
        vm.warp(block.timestamp + EXPIRY_DELTA + 1);

        uint256 writerBefore = underlying.balanceOf(writer);

        vm.prank(writer);
        vault.reclaimUnderlying(optId); // must NOT revert

        assertEq(underlying.balanceOf(writer), writerBefore + AMOUNT);
        (,,,,,,,, bool active) = vault.options(optId);
        assertFalse(active);
    }

    // ─── Multiple options from the same writer — independent state ────────────

    function test_multipleOptions_sameWriter() public {
        uint256 opt0 = _writeWith(AMOUNT,      STRIKE,        PREMIUM);
        uint256 opt1 = _writeWith(AMOUNT * 2,  STRIKE + 100e6, PREMIUM * 2);
        uint256 opt2 = _writeWith(AMOUNT / 2,  STRIKE - 100e6, PREMIUM / 2);

        // IDs must be sequential and independent
        assertEq(opt0, 0);
        assertEq(opt1, 1);
        assertEq(opt2, 2);

        // Each option tracks its own parameters
        (,, address u0, uint256 a0, uint256 s0, , uint256 p0,,) = vault.options(opt0);
        (,, address u1, uint256 a1, uint256 s1, , uint256 p1,,) = vault.options(opt1);
        (,, address u2, uint256 a2, uint256 s2, , uint256 p2,,) = vault.options(opt2);

        assertEq(u0, address(underlying));
        assertEq(a0, AMOUNT);       assertEq(s0, STRIKE);        assertEq(p0, PREMIUM);
        assertEq(a1, AMOUNT * 2);   assertEq(s1, STRIKE + 100e6); assertEq(p1, PREMIUM * 2);
        assertEq(a2, AMOUNT / 2);   assertEq(s2, STRIKE - 100e6); assertEq(p2, PREMIUM / 2);
        assertEq(u1, u0);
        assertEq(u2, u0);
    }

    // ─── Exercising twice reverts ─────────────────────────────────────────────

    function test_exercise_afterExercise_reverts() public {
        uint256 optId = _writeWith(AMOUNT, STRIKE, PREMIUM);
        _buy(optId);

        vm.prank(buyer);
        usdc.approve(address(vault), STRIKE * 2);

        vm.prank(buyer);
        vault.exercise(optId); // first exercise — succeeds

        vm.prank(buyer);
        vm.expectRevert("Already exercised");
        vault.exercise(optId); // second attempt — must revert
    }

    // ─── Fuzz: full option lifecycle ─────────────────────────────────────────

    function testFuzz_optionLifecycle(
        uint128 amount,
        uint128 strike,
        uint128 premium,
        uint32  expiryDelta
    ) public {
        vm.assume(amount      > 0);
        vm.assume(expiryDelta > 0);
        vm.assume(strike      > 0);
        vm.assume(premium     > 0);
        vm.assume(amount      <= 10e18);
        vm.assume(strike      <= 100_000e6);
        vm.assume(premium     <= 100_000e6);

        underlying.mint(writer, amount);
        usdc.mint(buyer, uint256(strike) + uint256(premium) + 1);

        uint256 expiry = block.timestamp + expiryDelta;
        uint256 optId  = _writeWith(amount, strike, premium);

        // Buy
        vm.prank(buyer);
        usdc.approve(address(vault), premium);
        vm.prank(buyer);
        vault.buyOption(optId);

        // Exercise
        vm.prank(buyer);
        usdc.approve(address(vault), strike);
        vm.prank(buyer);
        vault.exercise(optId);

        // Verify state
        (,,, uint256 _amount,,,, bool exercised, bool active) = vault.options(optId);
        assertTrue(exercised);
        assertFalse(active);
        assertEq(_amount, amount);
    }

    // ─── Helpers ─────────────────────────────────────────────────────────────

    function _writeWith(
        uint256 amount,
        uint256 strike,
        uint256 premium
    ) internal returns (uint256 optId) {
        vm.prank(writer);
        underlying.approve(address(vault), amount);
        vm.prank(writer);
        optId = vault.writeCoveredCall(
            address(underlying),
            amount,
            strike,
            block.timestamp + EXPIRY_DELTA,
            premium
        );
    }

    function _buy(uint256 optId) internal {
        vm.prank(buyer);
        usdc.approve(address(vault), PREMIUM);
        vm.prank(buyer);
        vault.buyOption(optId);
    }
}
