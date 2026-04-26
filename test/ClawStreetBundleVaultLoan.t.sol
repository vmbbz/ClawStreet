// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Test.sol";
import { ERC1967Proxy } from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";
import { ClawStreetBundleVault } from "../contracts/ClawStreetBundleVault.sol";
import { ClawStreetLoan } from "../contracts/ClawStreetLoan.sol";
import "@pythnetwork/pyth-sdk-solidity/PythStructs.sol";

// ─── Minimal mocks ────────────────────────────────────────────────────────────

contract MockUSDC6 {
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

/// @dev ERC-20 with 18 decimals — simulates tWETH
contract MockWETH18 {
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

contract MockPythInteg {
    // $2000 with expo = -6 → price in 6 decimals = 2_000_000_000
    function getPriceUnsafe(bytes32) external view returns (PythStructs.Price memory) {
        return PythStructs.Price({ price: 2_000_000_000, conf: 0, expo: -6, publishTime: block.timestamp });
    }
    function getEmaPriceUnsafe(bytes32) external view returns (PythStructs.Price memory) {
        return PythStructs.Price({ price: 2_000_000_000, conf: 0, expo: -6, publishTime: block.timestamp });
    }
    function getUpdateFee(bytes[] calldata) external pure returns (uint256) { return 0; }
    function updatePriceFeeds(bytes[] calldata) external payable {}
}

/// @dev Minimal staking mock: all stakers have hasPass = true.
contract MockStakingForLoan {
    function notifyFee(uint256) external {}
    function positions(address) external view returns (
        uint256 staked, uint256 stakedAt, uint256 rewardDebt, uint256 passId, bool hasPass
    ) {
        return (1e18, block.timestamp, 0, 1, true);
    }
}

// ─── Integration test: BundleVault → LoanEngine ───────────────────────────────

/**
 * @title ClawStreetBundleVaultLoan
 * @notice Integration test covering the full production flow:
 *   1. Borrower deposits tWETH into BundleVault → receives Bundle NFT
 *   2. Borrower approves Bundle NFT to LoanEngine
 *   3. Borrower calls createLoanOffer(bundleVault, bundleId, ...)
 *   4. Lender calls acceptLoan(loanId, [])
 *   5. Borrower repays → Bundle NFT returned
 *   6. Lender claims default → Bundle NFT transferred to lender
 *
 * This test does NOT use MockNFT. It uses real BundleVault + LoanEngine.
 */
contract ClawStreetBundleVaultLoan is Test {
    ClawStreetBundleVault public vault;
    ClawStreetLoan        public loan;
    MockUSDC6             public usdc;
    MockWETH18            public weth;
    MockPythInteg         public pyth;

    address admin    = makeAddr("admin");
    address borrower = makeAddr("borrower");
    address lender   = makeAddr("lender");

    uint256 constant PRINCIPAL = 400e6;  // 400 USDC
    uint256 constant INTEREST  = 24e6;   //  24 USDC
    uint256 constant DURATION  = 14 days;
    uint256 constant WETH_AMT  = 0.5e18; // 0.5 tWETH per bundle

    function setUp() public {
        usdc = new MockUSDC6();
        weth = new MockWETH18();
        pyth = new MockPythInteg();

        vm.startPrank(admin);

        // Deploy BundleVault via UUPS proxy
        ClawStreetBundleVault vaultImpl = new ClawStreetBundleVault();
        bytes memory vaultInit = abi.encodeCall(ClawStreetBundleVault.initialize, ("ClawStreet Bundle", "BUNDLE"));
        vault = ClawStreetBundleVault(address(new ERC1967Proxy(address(vaultImpl), vaultInit)));

        // Deploy LoanEngine via UUPS proxy
        ClawStreetLoan loanImpl = new ClawStreetLoan();
        bytes memory loanInit = abi.encodeCall(
            ClawStreetLoan.initialize,
            (address(usdc), address(pyth), bytes32(0))
        );
        loan = ClawStreetLoan(address(new ERC1967Proxy(address(loanImpl), loanInit)));

        vm.stopPrank();

        // Configure bundle-aware collateral pricing
        vm.startPrank(admin);
        loan.setBundleVault(address(vault));
        // Mock returns the same price for any feedId, so bytes32(uint256(1)) suffices
        loan.setTokenPriceFeed(address(weth), bytes32(uint256(1)));
        vm.stopPrank();

        // Fund actors
        weth.mint(borrower, 10e18);      // 10 tWETH to borrower
        usdc.mint(lender, 10_000e6);     // 10k USDC to lender
        usdc.mint(borrower, 10_000e6);   // 10k USDC to borrower (for repayment)
    }

    // ── Helper ────────────────────────────────────────────────────────────────

    function _depositBundle() internal returns (uint256 bundleId) {
        address[] memory erc20s = new address[](1);
        uint256[] memory amts   = new uint256[](1);
        address[] memory erc721s = new address[](0);
        uint256[] memory ids     = new uint256[](0);
        erc20s[0] = address(weth);
        amts[0]   = WETH_AMT;

        vm.startPrank(borrower);
        weth.approve(address(vault), WETH_AMT);
        bundleId = vault.depositBundle(erc20s, amts, erc721s, ids, "");
        vm.stopPrank();
    }

    // ── Tests ─────────────────────────────────────────────────────────────────

    function test_depositBundle_mintsBundleNFT() public {
        uint256 bundleId = _depositBundle();

        assertEq(vault.ownerOf(bundleId), borrower, "borrower should own bundle NFT");
        assertEq(vault.balanceOf(borrower), 1, "borrower should have 1 bundle");
        assertEq(weth.balanceOf(address(vault)), WETH_AMT, "vault should hold tWETH");
    }

    function test_fullFlow_repay() public {
        // Step 1: Borrower deposits tWETH → Bundle NFT
        uint256 bundleId = _depositBundle();

        // Step 2: Borrower approves Bundle NFT to LoanEngine
        vm.prank(borrower);
        vault.approve(address(loan), bundleId);

        // Step 3: Borrower creates loan offer (vault address as nftContract)
        vm.prank(borrower);
        loan.createLoanOffer(address(vault), bundleId, PRINCIPAL, INTEREST, DURATION);

        uint256 loanId = loan.loanCounter() - 1;
        (address b, address l,,, uint256 p,,,,, bool active, bool repaid) = loan.loans(loanId);
        assertEq(b, borrower);
        assertEq(l, address(0), "loan not yet funded");
        assertEq(p, PRINCIPAL);
        assertTrue(active);
        assertFalse(repaid);

        // Bundle NFT is now escrowed in LoanEngine
        assertEq(vault.ownerOf(bundleId), address(loan), "loan engine holds bundle NFT");

        // Step 4: Lender funds the loan
        vm.startPrank(lender);
        usdc.approve(address(loan), PRINCIPAL);
        loan.acceptLoan{value: 0}(loanId, new bytes[](0));
        vm.stopPrank();

        (,address funded_lender,,,,,,,, bool active2,) = loan.loans(loanId);
        assertEq(funded_lender, lender, "lender recorded");
        assertTrue(active2);

        // Step 5: Borrower repays
        uint256 totalRepay = PRINCIPAL + INTEREST;
        vm.startPrank(borrower);
        usdc.approve(address(loan), totalRepay);
        loan.repayLoan(loanId);
        vm.stopPrank();

        (,,,,,,,,, bool active3, bool repaid3) = loan.loans(loanId);
        assertFalse(active3, "loan should be inactive after repay");
        assertTrue(repaid3, "loan should be marked repaid");

        // Bundle NFT returned to borrower
        assertEq(vault.ownerOf(bundleId), borrower, "bundle NFT returned after repay");
    }

    function test_fullFlow_default() public {
        uint256 bundleId = _depositBundle();

        vm.prank(borrower);
        vault.approve(address(loan), bundleId);

        vm.prank(borrower);
        loan.createLoanOffer(address(vault), bundleId, PRINCIPAL, INTEREST, DURATION);
        uint256 loanId = loan.loanCounter() - 1;

        vm.startPrank(lender);
        usdc.approve(address(loan), PRINCIPAL);
        loan.acceptLoan{value: 0}(loanId, new bytes[](0));
        vm.stopPrank();

        // Warp past loan duration
        vm.warp(block.timestamp + DURATION + 1);

        // Lender claims default — bundle is auto-unwrapped and split proportionally
        // debt = 400 + 24 = 424 USDC; bundleValue = 0.5 WETH * $2000 = 1000 USDC
        // lenderFraction = 424/1000 = 0.424 → lenderWeth ≈ 0.212 WETH; borrower ≈ 0.288 WETH
        vm.prank(lender);
        loan.claimDefault(loanId);

        uint256 debt = PRINCIPAL + INTEREST; // 424e6
        uint256 bundleVal = 1000e6;          // 0.5 WETH * $2000
        uint256 expectedLenderWad = (debt * 1e18) / bundleVal;
        uint256 expectedLenderWeth   = (WETH_AMT * expectedLenderWad) / 1e18;
        uint256 expectedBorrowerWeth = WETH_AMT - expectedLenderWeth;

        // Borrower's WETH balance = initial (10e18) - deposited (0.5e18) + returned (expectedBorrowerWeth)
        assertApproxEqAbs(weth.balanceOf(lender),   expectedLenderWeth,                      1e9, "lender proportional WETH");
        assertApproxEqAbs(weth.balanceOf(borrower), 10e18 - WETH_AMT + expectedBorrowerWeth, 1e9, "borrower residual WETH");

        // Bundle NFT is burned — lender does NOT hold the NFT
        assertEq(vault.balanceOf(lender), 0, "lender receives assets not the Bundle NFT");

        (,,,,,,,,, bool active4,) = loan.loans(loanId);
        assertFalse(active4, "loan should be inactive after default");
    }

    function test_bundleDefault_fullDefault_lenderGetsAll() public {
        // Bundle value ($500) < debt ($900) → lender gets 100% of assets
        uint256 smallAmt = 0.25e18; // 0.25 WETH * $2000 = $500

        address[] memory erc20s  = new address[](1); erc20s[0]  = address(weth);
        uint256[] memory amts    = new uint256[](1); amts[0]    = smallAmt;
        address[] memory erc721s = new address[](0);
        uint256[] memory ids     = new uint256[](0);

        vm.startPrank(borrower);
        weth.approve(address(vault), smallAmt);
        uint256 bundleId = vault.depositBundle(erc20s, amts, erc721s, ids, "");
        vault.approve(address(loan), bundleId);
        // principal 800 + interest 100 = 900 USDC debt > 500 USDC bundle value
        loan.createLoanOffer(address(vault), bundleId, 800e6, 100e6, DURATION);
        vm.stopPrank();

        uint256 loanId = loan.loanCounter() - 1;

        vm.startPrank(lender);
        usdc.approve(address(loan), 800e6);
        loan.acceptLoan{value: 0}(loanId, new bytes[](0));
        vm.stopPrank();

        vm.warp(block.timestamp + DURATION + 1);

        uint256 borrowerWethBefore = weth.balanceOf(borrower);

        vm.prank(lender);
        loan.claimDefault(loanId);

        assertEq(weth.balanceOf(lender),   smallAmt,           "lender gets all WETH (full default)");
        assertEq(weth.balanceOf(borrower), borrowerWethBefore, "borrower receives nothing");
        assertEq(vault.balanceOf(lender),  0,                  "bundle NFT burned not transferred");
    }

    function test_bundleContainsCorrectAssets() public {
        uint256 bundleId = _depositBundle();

        // Withdraw and verify assets returned
        vm.prank(borrower);
        vault.withdrawBundle(bundleId);

        assertEq(weth.balanceOf(borrower), 10e18, "borrower gets tWETH back");
        assertEq(vault.balanceOf(borrower), 0, "bundle NFT burned");
    }

    function test_healthScore_withBundleNFT() public {
        uint256 bundleId = _depositBundle();

        vm.prank(borrower);
        vault.approve(address(loan), bundleId);

        vm.prank(borrower);
        loan.createLoanOffer(address(vault), bundleId, PRINCIPAL, INTEREST, DURATION);

        uint256 health = loan.getHealthScore(address(vault), bundleId, PRINCIPAL, borrower);
        // Bundle-aware pricing: 0.5 WETH * $2000 = $1000 value. Principal = $400. LTV = 40% → health 100.
        assertEq(health, 100, "health score should be 100 for bundle LTV 40%");
    }

    /// @notice ClawPass 5% health boost: same collateral, lower LTV → baseScore < 100 → ClawPass lifts it.
    ///         0.5 WETH @ $2000 = $1000 bundle value. Principal $600 → LTV 60% → excess 1000 bps
    ///         → penalty 20 → baseScore 80. Without pass: finalScore = 80. With pass: 80 * 105/100 = 84.
    function test_healthScore_clawPassBoost() public {
        uint256 bundleId = _depositBundle();

        // Without ClawPass: no staking contract wired
        uint256 healthNoPass = loan.getHealthScore(address(vault), bundleId, 600e6, borrower);
        // LTV = 60% (over 50% safe threshold) → baseScore = 80; no discounts; no pass
        assertEq(healthNoPass, 80, "baseline health without ClawPass");

        // Wire in MockStaking (all stakers have hasPass = true)
        MockStakingForLoan mockStaking = new MockStakingForLoan();
        vm.prank(admin);
        loan.setStakingContract(address(mockStaking));

        uint256 healthWithPass = loan.getHealthScore(address(vault), bundleId, 600e6, borrower);
        // 80 * 105 / 100 = 84
        assertEq(healthWithPass, 84, "ClawPass 5% boost lifts health from 80 to 84");
        assertGt(healthWithPass, healthNoPass, "ClawPass always improves health score");
    }

    function test_cancelLoanOffer_returnsBundle() public {
        uint256 bundleId = _depositBundle();

        vm.prank(borrower);
        vault.approve(address(loan), bundleId);

        vm.prank(borrower);
        loan.createLoanOffer(address(vault), bundleId, PRINCIPAL, INTEREST, DURATION);
        uint256 loanId = loan.loanCounter() - 1;

        // Bundle is escrowed in LoanEngine
        assertEq(vault.ownerOf(bundleId), address(loan));

        vm.prank(borrower);
        loan.cancelLoanOffer(loanId);

        // Bundle NFT returned to borrower after cancel
        assertEq(vault.ownerOf(bundleId), borrower, "bundle returned after cancel");
    }
}
