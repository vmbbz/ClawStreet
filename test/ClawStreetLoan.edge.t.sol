// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Test.sol";
import { ERC1967Proxy } from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";
import { ClawStreetLoan } from "../contracts/ClawStreetLoan.sol";
import { ClawStreetStaking } from "../contracts/ClawStreetStaking.sol";
import { ClawToken } from "../contracts/ClawToken.sol";

// ─── Mock ERC-20 (USDC) ───────────────────────────────────────────────────────

contract MockERC20 {
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

// ─── Mock ERC-721 ─────────────────────────────────────────────────────────────

contract MockERC721 {
    mapping(uint256 => address) public ownerOf;
    mapping(address => mapping(address => bool)) public isApprovedForAll;
    mapping(uint256 => address) public getApproved;

    function mint(address to, uint256 id) external {
        ownerOf[id] = to;
    }

    function approve(address to, uint256 id) external {
        getApproved[id] = to;
    }

    function transferFrom(address from, address to, uint256 id) external {
        require(ownerOf[id] == from, "not owner");
        require(to != address(0), "transfer to zero");
        ownerOf[id] = to;
    }

    function safeTransferFrom(address from, address to, uint256 id) external {
        require(ownerOf[id] == from, "not owner");
        require(to != address(0), "transfer to zero");
        ownerOf[id] = to;
    }

    function supportsInterface(bytes4) external pure returns (bool) { return true; }
}

// ─── Mock Pyth oracle ────────────────────────────────────────────────────────

contract MockPyth {
    int64 public mockPrice;
    int64 public mockEmaPrice;
    int32 public mockExpo = -6;

    struct Price {
        int64  price;
        uint64 conf;
        int32  expo;
        uint   publishTime;
    }

    function setPrice(int64 _price) external { mockPrice = _price; }
    function setEmaPrice(int64 _price) external { mockEmaPrice = _price; }

    function getPriceUnsafe(bytes32) external view returns (Price memory) {
        return Price({ price: mockPrice, conf: 0, expo: mockExpo, publishTime: block.timestamp });
    }

    function getEmaPriceUnsafe(bytes32) external view returns (Price memory) {
        return Price({ price: mockEmaPrice == 0 ? mockPrice : mockEmaPrice, conf: 0, expo: mockExpo, publishTime: block.timestamp });
    }

    function getUpdateFee(bytes[] calldata) external pure returns (uint256) { return 0.001 ether; }

    function updatePriceFeeds(bytes[] calldata) external payable {}
}

// ─── Mock Reputation oracle ───────────────────────────────────────────────────

contract MockReputation {
    mapping(address => uint256) public scores;

    function setScore(address agent, uint256 score) external {
        scores[agent] = score;
    }

    function getAgentScore(address agent) external view returns (uint256) {
        return scores[agent];
    }
}

// ─── Test suite ───────────────────────────────────────────────────────────────

contract ClawStreetLoanEdgeTest is Test {
    ClawStreetLoan public loan;
    MockERC20      public usdc;
    MockERC721     public nft;
    MockPyth       public pyth;
    MockReputation public reputation;

    address public admin   = makeAddr("admin");
    address public alice   = makeAddr("alice");   // borrower
    address public bob     = makeAddr("bob");     // lender
    address public charlie = makeAddr("charlie"); // extra actor
    address public treasury = makeAddr("treasury");

    uint256 constant PRINCIPAL = 1_000e6;
    uint256 constant INTEREST  = 50e6;
    uint256 constant DURATION  = 30 days;
    uint256 constant NFT_ID    = 1;

    // Price = $2000 with expo=-6 → 2_000_000_000 (represents 2000.000000)
    int64 constant PRICE_2000 = 2_000_000_000;

    function setUp() public {
        usdc       = new MockERC20();
        nft        = new MockERC721();
        pyth       = new MockPyth();
        reputation = new MockReputation();

        pyth.setPrice(PRICE_2000);

        vm.startPrank(admin);
        ClawStreetLoan impl = new ClawStreetLoan();
        bytes memory init = abi.encodeCall(
            ClawStreetLoan.initialize,
            (address(usdc), address(pyth), bytes32(0))
        );
        ERC1967Proxy proxy = new ERC1967Proxy(address(impl), init);
        loan = ClawStreetLoan(address(proxy));
        vm.stopPrank();

        usdc.mint(alice,   100_000e6);
        usdc.mint(bob,     100_000e6);
        usdc.mint(charlie, 100_000e6);
        nft.mint(alice, NFT_ID);
    }

    // ─── AUDIT FINDING: MEDIUM — lender can no longer trigger repayment (FIXED) ──

    /// @notice repayLoan now restricts caller to loan.borrower only.
    ///         Lender calling repayLoan must revert with "Only borrower can repay".
    function test_repayLoan_lenderTriggersRepayment() public {
        _createOffer(NFT_ID);
        _acceptLoan(0);

        uint256 total = PRINCIPAL + INTEREST;

        // Borrower (alice) pre-approves the loan contract (as she normally would)
        vm.prank(alice);
        usdc.approve(address(loan), total);

        // Lender (bob) calling repayLoan must now revert
        vm.prank(bob);
        vm.expectRevert("Only borrower can repay");
        loan.repayLoan(0);
    }

    // ─── AUDIT FINDING: MEDIUM — claimDefault on unfunded loan reverts ────────

    /// @notice If no lender has accepted a loan (lender == address(0)),
    ///         claimDefault tries to transfer the NFT to address(0).
    ///         Our MockERC721 guards against this; the call must revert.
    function test_claimDefault_onUnfundedLoan_reverts() public {
        _createOffer(NFT_ID);

        // Loan exists but has no lender (address(0))
        (,address lender,,,,,,,,, ) = loan.loans(0);
        assertEq(lender, address(0));

        // Warp past a fabricated "duration" — duration was set to DURATION
        vm.warp(block.timestamp + DURATION + 1);

        // claimDefault should revert because transferFrom(contract, address(0), id) reverts
        vm.prank(charlie);
        vm.expectRevert();
        loan.claimDefault(0);
    }

    // ─── AUDIT FINDING: LOW — health score exactly at 50% LTV → score 100 ────

    /// @notice At exactly 50% LTV (ltvBps == 5000), baseScore must be 100.
    ///         Price = 2000 USDC → collateralValue = 2_000e6.
    ///         principal = 1_000e6 → LTV = 50% exactly.
    function test_healthScore_exactlyAt50pctLTV() public {
        // collateralValue = 2000 USDC, principal = 1000 USDC → LTV = 50%
        // No reputation oracle set → repMultiplier = 100
        // EMA == spot → discountMultiplier = 100
        // finalScore = 100 * 100 * 100 / 10000 = 100
        uint256 score = loan.getHealthScore(address(nft), NFT_ID, 1_000e6, alice);
        assertEq(score, 100);
    }

    // ─── AUDIT FINDING: LOW — health score just over 50% LTV → penalty 2 ────

    /// @notice LTV = 5100 bps → excess = 100 bps → penalty = (100 * 2) / 100 = 2
    ///         baseScore = 100 - 2 = 98.
    ///         finalScore = 98 * 100 * 100 / 10000 = 98.
    function test_healthScore_slightlyOver50pct() public {
        // collateralValue = 2000 USDC
        // principal at LTV 51% = 2000 * 5100 / 10000 = 1020 USDC
        uint256 principal = 1_020e6;
        uint256 score = loan.getHealthScore(address(nft), NFT_ID, principal, alice);
        assertEq(score, 98);
    }

    // ─── AUDIT FINDING: LOW — reputation boost (score > 800) → 110/100 ───────

    function test_healthScore_reputationBoostHighScore() public {
        vm.prank(admin);
        loan.setReputationOracle(address(reputation));
        reputation.setScore(alice, 850);

        // LTV = 50% → baseScore = 100, discountMultiplier = 100, repMultiplier = 110
        // finalScore = min(100, 100 * 100 * 110 / 10000) = min(100, 110) = 100
        uint256 score = loan.getHealthScore(address(nft), NFT_ID, 1_000e6, alice);
        assertEq(score, 100); // capped at 100 by Math.min
    }

    // ─── AUDIT FINDING: LOW — reputation penalty (score < 500) → 90/100 ──────

    function test_healthScore_reputationPenaltyLowScore() public {
        vm.prank(admin);
        loan.setReputationOracle(address(reputation));
        reputation.setScore(alice, 400);

        // LTV = 50% → baseScore = 100, discountMultiplier = 100, repMultiplier = 90
        // finalScore = 100 * 100 * 90 / 10000 = 90
        uint256 score = loan.getHealthScore(address(nft), NFT_ID, 1_000e6, alice);
        assertEq(score, 90);
    }

    // ─── AUDIT FINDING: MEDIUM — fee forwarding full integration ─────────────

    /// @notice Full integration: deploy both contracts, alice stakes CLAW,
    ///         bob lends, fee flows to staking, alice claims USDC revenue.
    function test_feeForwarding_toStakingContract() public {
        // 1. Deploy ClawToken + ClawStreetStaking
        vm.startPrank(admin);
        ClawToken clawToken = new ClawToken(admin);
        ClawStreetStaking stakingContract = new ClawStreetStaking(
            address(clawToken),
            address(usdc),
            admin
        );
        // Authorise loan contract as a fee notifier
        stakingContract.setFeeNotifier(address(loan), true);
        vm.stopPrank();

        // 2. Wire staking contract into loan
        vm.prank(admin);
        loan.setStakingContract(address(stakingContract));

        // 3. Alice stakes CLAW
        vm.prank(admin);
        clawToken.mint(alice, 10_000 * 1e18);

        vm.prank(alice);
        clawToken.approve(address(stakingContract), 10_000 * 1e18);
        vm.prank(alice);
        stakingContract.stake(10_000 * 1e18);

        // 4. Bob creates an NFT and offers a loan; charlie accepts
        nft.mint(bob, 42);
        vm.prank(bob);
        nft.approve(address(loan), 42);
        vm.prank(bob);
        loan.createLoanOffer(address(nft), 42, PRINCIPAL, INTEREST, DURATION);

        uint256 fee = (PRINCIPAL * loan.BROKER_FEE_BPS()) / 10000;

        vm.prank(charlie);
        usdc.approve(address(loan), PRINCIPAL);
        vm.prank(charlie);
        loan.acceptLoan(0, new bytes[](0));

        // 5. Fee should have flowed to staking contract
        assertEq(usdc.balanceOf(address(stakingContract)), fee);
        assertApproxEqAbs(stakingContract.pendingRevenue(alice), fee, 2);

        // 6. Alice claims revenue
        vm.prank(alice);
        stakingContract.claimRevenue();
        assertApproxEqAbs(usdc.balanceOf(alice), 100_000e6 + fee, 2);
    }

    // ─── AUDIT FINDING: LOW — minimum duration enforced (FIXED) ─────────────

    /// @notice duration=1 second now reverts with "Duration too short".
    function test_shortDuration_oneSec() public {
        vm.prank(alice);
        nft.approve(address(loan), NFT_ID);
        vm.prank(alice);
        vm.expectRevert("Duration too short");
        loan.createLoanOffer(address(nft), NFT_ID, PRINCIPAL, INTEREST, 1);
    }

    /// @notice duration=1 hour (MIN_DURATION) succeeds.
    function test_shortDuration_oneHour_succeeds() public {
        vm.prank(alice);
        nft.approve(address(loan), NFT_ID);
        vm.prank(alice);
        loan.createLoanOffer(address(nft), NFT_ID, PRINCIPAL, INTEREST, 1 hours);

        (,,,,,,,,,bool active,) = loan.loans(0);
        assertTrue(active);
    }

    // ─── Same NFT can be re-used after cancel ─────────────────────────────────

    function test_multipleLoans_sameNFT_contract() public {
        // First offer
        _createOffer(NFT_ID);
        assertEq(nft.ownerOf(NFT_ID), address(loan));

        // Cancel it — NFT returned to alice
        vm.prank(alice);
        loan.cancelLoanOffer(0);
        assertEq(nft.ownerOf(NFT_ID), alice);

        // Re-offer the same NFT
        _createOffer(NFT_ID);
        assertEq(nft.ownerOf(NFT_ID), address(loan));

        (,,,,,,,,,bool active,) = loan.loans(1);
        assertTrue(active);
    }

    // ─── acceptLoan refunds excess ETH when priceUpdateData is provided ───────

    function test_acceptLoan_refundsExcessEth() public {
        _createOffer(NFT_ID);

        // getUpdateFee returns 0.001 ether, send 0.01 ether — excess must be refunded
        bytes[] memory updateData = new bytes[](1);
        updateData[0] = hex"deadbeef";

        uint256 oracleFee = pyth.getUpdateFee(updateData);
        uint256 excess    = 0.01 ether;
        vm.deal(bob, 1 ether);

        vm.prank(bob);
        usdc.approve(address(loan), PRINCIPAL);

        uint256 bobEthBefore = bob.balance;

        vm.prank(bob);
        loan.acceptLoan{value: excess}(0, updateData);

        // Bob should have been refunded (excess - oracleFee)
        assertApproxEqAbs(bob.balance, bobEthBefore - oracleFee, 1);
    }

    // ─── Fuzz: full loan lifecycle ────────────────────────────────────────────

    function testFuzz_loanLifecycle(
        uint128 principal,
        uint128 interest,
        uint32  duration
    ) public {
        vm.assume(principal > 0);
        vm.assume(duration  >= 1 hours);
        vm.assume(principal < 10_000e6);
        vm.assume(interest  < 10_000e6);

        uint256 nftId = 999;
        nft.mint(alice, nftId);

        vm.prank(alice);
        nft.approve(address(loan), nftId);
        vm.prank(alice);
        loan.createLoanOffer(address(nft), nftId, principal, interest, duration);

        uint256 loanId = loan.loanCounter() - 1;

        usdc.mint(bob, principal);
        vm.prank(bob);
        usdc.approve(address(loan), principal);
        vm.prank(bob);
        loan.acceptLoan(loanId, new bytes[](0));

        uint256 total = uint256(principal) + uint256(interest);
        usdc.mint(alice, total);
        vm.prank(alice);
        usdc.approve(address(loan), total);
        vm.prank(alice);
        loan.repayLoan(loanId);

        assertEq(nft.ownerOf(nftId), alice);
        (,,,,,,,,,bool active, bool repaid) = loan.loans(loanId);
        assertFalse(active);
        assertTrue(repaid);
    }

    // ─── Helpers ─────────────────────────────────────────────────────────────

    function _createOffer(uint256 nftId) internal {
        vm.prank(alice);
        nft.approve(address(loan), nftId);
        vm.prank(alice);
        loan.createLoanOffer(address(nft), nftId, PRINCIPAL, INTEREST, DURATION);
    }

    function _acceptLoan(uint256 loanId) internal {
        vm.prank(bob);
        usdc.approve(address(loan), PRINCIPAL);
        vm.prank(bob);
        loan.acceptLoan(loanId, new bytes[](0));
    }
}
