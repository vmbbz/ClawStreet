// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Test.sol";
import { ERC1967Proxy } from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";
import { ClawStreetBundleVault } from "../contracts/ClawStreetBundleVault.sol";
import { ClawStreetCallVault } from "../contracts/ClawStreetCallVault.sol";

// ─── Minimal mocks ────────────────────────────────────────────────────────────

contract MockUSDC_BCV {
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;
    uint8 public decimals = 6;

    function mint(address to, uint256 amount) external { balanceOf[to] += amount; }

    function transfer(address to, uint256 amount) external returns (bool) {
        require(balanceOf[msg.sender] >= amount, "insufficient");
        balanceOf[msg.sender] -= amount; balanceOf[to] += amount; return true;
    }

    function transferFrom(address from, address to, uint256 amount) external returns (bool) {
        require(balanceOf[from] >= amount, "insufficient");
        require(allowance[from][msg.sender] >= amount, "allowance");
        allowance[from][msg.sender] -= amount; balanceOf[from] -= amount; balanceOf[to] += amount;
        return true;
    }

    function approve(address spender, uint256 amount) external returns (bool) {
        allowance[msg.sender][spender] = amount; return true;
    }
}

contract MockWETH_BCV {
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;
    uint8 public decimals = 18;

    function mint(address to, uint256 amount) external { balanceOf[to] += amount; }

    function transfer(address to, uint256 amount) external returns (bool) {
        require(balanceOf[msg.sender] >= amount, "insufficient");
        balanceOf[msg.sender] -= amount; balanceOf[to] += amount; return true;
    }

    function transferFrom(address from, address to, uint256 amount) external returns (bool) {
        require(balanceOf[from] >= amount, "insufficient");
        require(allowance[from][msg.sender] >= amount, "allowance");
        allowance[from][msg.sender] -= amount; balanceOf[from] -= amount; balanceOf[to] += amount;
        return true;
    }

    function approve(address spender, uint256 amount) external returns (bool) {
        allowance[msg.sender][spender] = amount; return true;
    }
}

// ─── Bundle Call Vault integration tests ─────────────────────────────────────

/**
 * @title ClawStreetBundleCallVaultTest
 * @notice Tests covering the full bundle covered-call lifecycle:
 *   1. Writer deposits tWETH → Bundle NFT → writes bundle call
 *   2. Buyer purchases the bundle option (pays premium)
 *   3. Buyer exercises (approve strike USDC → exercise → receives Bundle NFT)
 *   4. Cancel before buyer — writer reclaims Bundle NFT
 *   5. Reclaim after expiry — writer reclaims Bundle NFT
 */
contract ClawStreetBundleCallVaultTest is Test {
    ClawStreetBundleVault public bundleVault;
    ClawStreetCallVault   public callVault;
    MockUSDC_BCV          public usdc;
    MockWETH_BCV          public weth;

    address admin  = makeAddr("admin");
    address writer = makeAddr("writer");
    address buyer  = makeAddr("buyer");

    uint256 constant WETH_AMT = 0.5e18;   // 0.5 tWETH per bundle
    uint256 constant STRIKE   = 1500e6;   // 1500 USDC to exercise
    uint256 constant PREMIUM  = 50e6;     // 50 USDC to buy the option
    uint256 constant EXPIRY_OFFSET = 7 days;

    function setUp() public {
        usdc = new MockUSDC_BCV();
        weth = new MockWETH_BCV();

        vm.startPrank(admin);

        // Deploy BundleVault via UUPS proxy
        ClawStreetBundleVault vaultImpl = new ClawStreetBundleVault();
        bytes memory vaultInit = abi.encodeCall(ClawStreetBundleVault.initialize, ("ClawStreet Bundle", "BUNDLE"));
        bundleVault = ClawStreetBundleVault(address(new ERC1967Proxy(address(vaultImpl), vaultInit)));

        // Deploy CallVault via UUPS proxy
        ClawStreetCallVault callImpl = new ClawStreetCallVault();
        bytes memory callInit = abi.encodeCall(ClawStreetCallVault.initialize, (address(usdc)));
        callVault = ClawStreetCallVault(address(new ERC1967Proxy(address(callImpl), callInit)));

        vm.stopPrank();

        // Fund actors
        weth.mint(writer, 10e18);
        usdc.mint(buyer, 10_000e6);
        usdc.mint(writer, 1_000e6); // writer may need USDC for other ops
    }

    // ── Helper: writer deposits tWETH → Bundle NFT ────────────────────────────

    function _mintBundle() internal returns (uint256 bundleId) {
        address[] memory erc20s  = new address[](1); erc20s[0]  = address(weth);
        uint256[] memory amts    = new uint256[](1); amts[0]    = WETH_AMT;
        address[] memory erc721s = new address[](0);
        uint256[] memory ids     = new uint256[](0);

        vm.startPrank(writer);
        weth.approve(address(bundleVault), WETH_AMT);
        bundleId = bundleVault.depositBundle(erc20s, amts, erc721s, ids, "");
        vm.stopPrank();
    }

    // ── Tests ──────────────────────────────────────────────────────────────────

    function test_writeBundleCall_locksNFT() public {
        uint256 bundleId = _mintBundle();
        uint256 expiry   = block.timestamp + EXPIRY_OFFSET;

        vm.startPrank(writer);
        bundleVault.approve(address(callVault), bundleId);
        uint256 optId = callVault.writeBundleCall(address(bundleVault), bundleId, STRIKE, expiry, PREMIUM);
        vm.stopPrank();

        // Bundle NFT transferred to callVault
        assertEq(bundleVault.ownerOf(bundleId), address(callVault), "callVault holds bundle NFT");

        (address w,,,,,,,, bool active) = callVault.bundleOptions(optId);
        assertEq(w, writer);
        assertTrue(active);
    }

    function test_buyBundleOption_paysPremium() public {
        uint256 bundleId = _mintBundle();
        uint256 expiry   = block.timestamp + EXPIRY_OFFSET;

        vm.startPrank(writer);
        bundleVault.approve(address(callVault), bundleId);
        uint256 optId = callVault.writeBundleCall(address(bundleVault), bundleId, STRIKE, expiry, PREMIUM);
        vm.stopPrank();

        uint256 writerUsdcBefore = usdc.balanceOf(writer);

        vm.startPrank(buyer);
        usdc.approve(address(callVault), PREMIUM);
        callVault.buyBundleOption(optId);
        vm.stopPrank();

        assertEq(usdc.balanceOf(writer), writerUsdcBefore + PREMIUM, "writer receives premium");

        (, address b,,,,,,, ) = callVault.bundleOptions(optId);
        assertEq(b, buyer, "buyer recorded");
    }

    function test_exerciseBundleOption_twoStep() public {
        uint256 bundleId = _mintBundle();
        uint256 expiry   = block.timestamp + EXPIRY_OFFSET;

        vm.startPrank(writer);
        bundleVault.approve(address(callVault), bundleId);
        uint256 optId = callVault.writeBundleCall(address(bundleVault), bundleId, STRIKE, expiry, PREMIUM);
        vm.stopPrank();

        vm.startPrank(buyer);
        usdc.approve(address(callVault), PREMIUM);
        callVault.buyBundleOption(optId);
        vm.stopPrank();

        uint256 writerUsdcBefore = usdc.balanceOf(writer);

        // Step 1: buyer approves strike USDC
        vm.prank(buyer);
        usdc.approve(address(callVault), STRIKE);

        // Step 2: buyer exercises → pays strike USDC, receives Bundle NFT
        vm.prank(buyer);
        callVault.exerciseBundleOption(optId);

        assertEq(bundleVault.ownerOf(bundleId), buyer, "buyer receives bundle NFT");
        assertEq(usdc.balanceOf(writer), writerUsdcBefore + STRIKE, "writer receives strike payment");

        (,,,,, , bool exercised, bool active) = _bundleOpt(optId);
        assertTrue(exercised, "exercised flag set");
        assertFalse(active, "active flag cleared");
    }

    function test_exerciseBundleOption_buyerCanUnwrap() public {
        uint256 bundleId = _mintBundle();
        uint256 expiry   = block.timestamp + EXPIRY_OFFSET;

        vm.startPrank(writer);
        bundleVault.approve(address(callVault), bundleId);
        uint256 optId = callVault.writeBundleCall(address(bundleVault), bundleId, STRIKE, expiry, PREMIUM);
        vm.stopPrank();

        vm.startPrank(buyer);
        usdc.approve(address(callVault), PREMIUM);
        callVault.buyBundleOption(optId);
        usdc.approve(address(callVault), STRIKE);
        callVault.exerciseBundleOption(optId);

        // Buyer now owns the bundle NFT; they can withdraw underlying assets
        assertEq(bundleVault.ownerOf(bundleId), buyer);
        bundleVault.withdrawBundle(bundleId); // unwrap → receive tWETH
        vm.stopPrank();

        assertEq(weth.balanceOf(buyer), WETH_AMT, "buyer receives tWETH after unwrapping bundle");
    }

    function test_cancelBundleOption_returnsNFT() public {
        uint256 bundleId = _mintBundle();
        uint256 expiry   = block.timestamp + EXPIRY_OFFSET;

        vm.startPrank(writer);
        bundleVault.approve(address(callVault), bundleId);
        uint256 optId = callVault.writeBundleCall(address(bundleVault), bundleId, STRIKE, expiry, PREMIUM);
        callVault.cancelBundleOption(optId);
        vm.stopPrank();

        assertEq(bundleVault.ownerOf(bundleId), writer, "bundle NFT returned to writer");
        (, , , , , , , bool active) = _bundleOpt(optId);
        assertFalse(active, "option inactive after cancel");
    }

    function test_reclaimBundle_afterExpiry() public {
        uint256 bundleId = _mintBundle();
        uint256 expiry   = block.timestamp + EXPIRY_OFFSET;

        vm.startPrank(writer);
        bundleVault.approve(address(callVault), bundleId);
        uint256 optId = callVault.writeBundleCall(address(bundleVault), bundleId, STRIKE, expiry, PREMIUM);
        vm.stopPrank();

        vm.warp(block.timestamp + EXPIRY_OFFSET + 1);

        vm.prank(writer);
        callVault.reclaimBundle(optId);

        assertEq(bundleVault.ownerOf(bundleId), writer, "writer reclaims bundle NFT after expiry");
    }

    function test_cannotExercise_withoutApproval() public {
        uint256 bundleId = _mintBundle();
        uint256 expiry   = block.timestamp + EXPIRY_OFFSET;

        vm.startPrank(writer);
        bundleVault.approve(address(callVault), bundleId);
        uint256 optId = callVault.writeBundleCall(address(bundleVault), bundleId, STRIKE, expiry, PREMIUM);
        vm.stopPrank();

        vm.startPrank(buyer);
        usdc.approve(address(callVault), PREMIUM);
        callVault.buyBundleOption(optId);

        // No USDC approve for strike — should revert
        vm.expectRevert();
        callVault.exerciseBundleOption(optId);
        vm.stopPrank();
    }

    function test_cannotExercise_afterExpiry() public {
        uint256 bundleId = _mintBundle();
        uint256 expiry   = block.timestamp + EXPIRY_OFFSET;

        vm.startPrank(writer);
        bundleVault.approve(address(callVault), bundleId);
        uint256 optId = callVault.writeBundleCall(address(bundleVault), bundleId, STRIKE, expiry, PREMIUM);
        vm.stopPrank();

        vm.startPrank(buyer);
        usdc.approve(address(callVault), PREMIUM);
        callVault.buyBundleOption(optId);
        usdc.approve(address(callVault), STRIKE);
        vm.stopPrank();

        vm.warp(block.timestamp + EXPIRY_OFFSET + 1);

        vm.prank(buyer);
        vm.expectRevert("Expired");
        callVault.exerciseBundleOption(optId);
    }

    function test_cannotCancel_afterBuy() public {
        uint256 bundleId = _mintBundle();
        uint256 expiry   = block.timestamp + EXPIRY_OFFSET;

        vm.startPrank(writer);
        bundleVault.approve(address(callVault), bundleId);
        uint256 optId = callVault.writeBundleCall(address(bundleVault), bundleId, STRIKE, expiry, PREMIUM);
        vm.stopPrank();

        vm.startPrank(buyer);
        usdc.approve(address(callVault), PREMIUM);
        callVault.buyBundleOption(optId);
        vm.stopPrank();

        vm.prank(writer);
        vm.expectRevert("Cannot cancel");
        callVault.cancelBundleOption(optId);
    }

    // ── Helper to destructure bundleOptions tuple (drops premium field) ───────

    function _bundleOpt(uint256 id) internal view returns (
        address writer_, address buyer_, address bv_, uint256 bid_,
        uint256 strike_, uint256 expiry_, bool exercised_, bool active_
    ) {
        uint256 _premium;
        (writer_, buyer_, bv_, bid_, strike_, expiry_, _premium, exercised_, active_) = callVault.bundleOptions(id);
    }
}
