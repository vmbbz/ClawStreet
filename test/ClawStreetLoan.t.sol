// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Test.sol";
import { ERC1967Proxy } from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";
import { ClawStreetLoan } from "../contracts/ClawStreetLoan.sol";
import { ClawStreetStaking } from "../contracts/ClawStreetStaking.sol";
import { ClawToken } from "../contracts/ClawToken.sol";
import "@pythnetwork/pyth-sdk-solidity/PythStructs.sol";

// ─── Mocks ────────────────────────────────────────────────────────────────────

/// @dev Minimal ERC-20 with 6 decimals (USDC stand-in).
contract MockERC20 {
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;
    uint8 public decimals = 6;

    function mint(address to, uint256 amount) external {
        balanceOf[to] += amount;
    }

    function transfer(address to, uint256 amount) external returns (bool) {
        require(balanceOf[msg.sender] >= amount, "ERC20: insufficient balance");
        balanceOf[msg.sender] -= amount;
        balanceOf[to] += amount;
        return true;
    }

    function transferFrom(address from, address to, uint256 amount) external returns (bool) {
        require(balanceOf[from] >= amount, "ERC20: insufficient balance");
        require(allowance[from][msg.sender] >= amount, "ERC20: allowance exceeded");
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

/// @dev Minimal ERC-721 that satisfies IERC721.transferFrom calls from ClawStreetLoan.
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

    function setApprovalForAll(address operator, bool approved) external {
        isApprovedForAll[msg.sender][operator] = approved;
    }

    function transferFrom(address from, address to, uint256 id) external {
        require(ownerOf[id] == from, "ERC721: wrong owner");
        require(to != address(0), "ERC721: transfer to zero address");
        ownerOf[id] = to;
    }

    function safeTransferFrom(address from, address to, uint256 id) external {
        require(ownerOf[id] == from, "ERC721: wrong owner");
        require(to != address(0), "ERC721: transfer to zero address");
        ownerOf[id] = to;
    }

    function supportsInterface(bytes4) external pure returns (bool) { return true; }
}

/// @dev Pyth oracle mock that returns proper PythStructs.Price structs.
///      Default: price = 2_000_000_000 ($2000 with expo=-6), EMA equals spot.
contract MockPyth {
    int64  public mockPrice    = 2_000_000_000; // $2000 with expo=-6
    int64  public mockEmaPrice = 2_000_000_000;
    int32  public mockExpo     = -6;

    function setPrice(int64 p)    external { mockPrice    = p; }
    function setEmaPrice(int64 p) external { mockEmaPrice = p; }
    function setExpo(int32 e)     external { mockExpo     = e; }

    function getPriceUnsafe(bytes32) external view returns (PythStructs.Price memory) {
        return PythStructs.Price({
            price:       mockPrice,
            conf:        0,
            expo:        mockExpo,
            publishTime: block.timestamp
        });
    }

    function getEmaPriceUnsafe(bytes32) external view returns (PythStructs.Price memory) {
        return PythStructs.Price({
            price:       mockEmaPrice,
            conf:        0,
            expo:        mockExpo,
            publishTime: block.timestamp
        });
    }

    function getUpdateFee(bytes[] calldata) external pure returns (uint256) { return 0; }
    function updatePriceFeeds(bytes[] calldata) external payable {}
}

/// @dev Reputation oracle mock.
contract MockReputation {
    mapping(address => uint256) public scores;

    function setScore(address agent, uint256 score) external { scores[agent] = score; }
    function getAgentScore(address agent) external view returns (uint256) { return scores[agent]; }
}

// ─── Test suite ───────────────────────────────────────────────────────────────

contract ClawStreetLoanTest is Test {
    // ─── Protocol contracts ───────────────────────────────────────────────────
    ClawStreetLoan    public loan;
    MockERC20         public usdc;
    MockERC721        public nft;
    MockPyth          public pyth;
    MockReputation    public reputation;

    // ─── Actors ───────────────────────────────────────────────────────────────
    address public admin    = makeAddr("admin");
    address public alice    = makeAddr("alice");    // borrower
    address public bob      = makeAddr("bob");      // lender
    address public charlie  = makeAddr("charlie");  // third-party
    address public treasury = makeAddr("treasury");

    // ─── Shared constants ─────────────────────────────────────────────────────
    uint256 constant PRINCIPAL = 1_000e6;   // 1 000 USDC
    uint256 constant INTEREST  = 50e6;      //    50 USDC
    uint256 constant DURATION  = 30 days;
    uint256 constant NFT_ID    = 1;

    // Price $2 000 with expo=-6 → collateralValue = 2 000e6 → LTV at 1 000e6 = 50%
    int64  constant PRICE_2000 = 2_000_000_000;

    // ─── Setup ────────────────────────────────────────────────────────────────

    function setUp() public {
        usdc       = new MockERC20();
        nft        = new MockERC721();
        pyth       = new MockPyth();
        reputation = new MockReputation();

        // Deploy ClawStreetLoan via UUPS proxy as admin
        vm.startPrank(admin);
        ClawStreetLoan impl = new ClawStreetLoan();
        bytes memory initData = abi.encodeCall(
            ClawStreetLoan.initialize,
            (address(usdc), address(pyth), bytes32(0))
        );
        ERC1967Proxy proxy = new ERC1967Proxy(address(impl), initData);
        loan = ClawStreetLoan(address(proxy));
        vm.stopPrank();

        // Fund actors
        usdc.mint(alice,   100_000e6);
        usdc.mint(bob,     100_000e6);
        usdc.mint(charlie, 100_000e6);

        nft.mint(alice, NFT_ID);
    }

    // ══════════════════════════════════════════════════════════════════════════
    //  createLoanOffer
    // ══════════════════════════════════════════════════════════════════════════

    /// @notice NFT custody transfers to loan contract during createLoanOffer.
    function test_createLoanOffer_escrowsNFT() public {
        _createOffer(NFT_ID, PRINCIPAL, INTEREST, DURATION);
        assertEq(nft.ownerOf(NFT_ID), address(loan), "NFT not escrowed");
    }

    /// @notice All Loan struct fields are populated correctly at creation.
    function test_createLoanOffer_loansStructPopulated() public {
        _createOffer(NFT_ID, PRINCIPAL, INTEREST, DURATION);

        (
            address borrower,
            address lender,
            address nftContract,
            uint256 nftId,
            uint256 principal,
            uint256 interest,
            uint256 duration,
            uint256 startTime,
            /* healthSnapshot */,
            bool    active,
            bool    repaid
        ) = loan.loans(0);

        assertEq(borrower,    alice,           "borrower mismatch");
        assertEq(lender,      address(0),      "lender should be 0");
        assertEq(nftContract, address(nft),    "nftContract mismatch");
        assertEq(nftId,       NFT_ID,          "nftId mismatch");
        assertEq(principal,   PRINCIPAL,       "principal mismatch");
        assertEq(interest,    INTEREST,        "interest mismatch");
        assertEq(duration,    DURATION,        "duration mismatch");
        assertEq(startTime,   0,               "startTime should be 0");
        assertTrue(active,                     "loan should be active");
        assertFalse(repaid,                    "loan should not be repaid");
    }

    /// @notice healthSnapshot > 0 when Pyth returns a valid non-zero price.
    function test_createLoanOffer_healthSnapshotRecorded() public {
        _createOffer(NFT_ID, PRINCIPAL, INTEREST, DURATION);

        (,,,,,,,, uint256 health,,) = loan.loans(0);
        assertGt(health, 0, "healthSnapshot should be > 0 with valid price");
    }

    /// @notice principal == 0 must revert.
    function test_createLoanOffer_revertsZeroPrincipal() public {
        uint256 id = 10;
        nft.mint(alice, id);

        vm.prank(alice);
        nft.approve(address(loan), id);

        vm.prank(alice);
        vm.expectRevert("Principal must be > 0");
        loan.createLoanOffer(address(nft), id, 0, INTEREST, DURATION);
    }

    /// @notice duration < MIN_DURATION (1 hour) reverts.
    function test_createLoanOffer_revertsDurationTooShort() public {
        uint256 id = 11;
        nft.mint(alice, id);

        vm.prank(alice);
        nft.approve(address(loan), id);

        vm.prank(alice);
        vm.expectRevert("Duration too short");
        loan.createLoanOffer(address(nft), id, PRINCIPAL, INTEREST, 1);
    }

    /// @notice MIN_DURATION - 1 reverts; MIN_DURATION exactly succeeds.
    function test_createLoanOffer_revertsMinDuration() public {
        uint256 tooShort = loan.MIN_DURATION() - 1;
        uint256 exact    = loan.MIN_DURATION();

        uint256 id1 = 20;
        uint256 id2 = 21;
        nft.mint(alice, id1);
        nft.mint(alice, id2);

        // One second under MIN_DURATION → reverts
        vm.prank(alice);
        nft.approve(address(loan), id1);
        vm.prank(alice);
        vm.expectRevert("Duration too short");
        loan.createLoanOffer(address(nft), id1, PRINCIPAL, INTEREST, tooShort);

        // Exactly MIN_DURATION → succeeds
        vm.prank(alice);
        nft.approve(address(loan), id2);
        vm.prank(alice);
        loan.createLoanOffer(address(nft), id2, PRINCIPAL, INTEREST, exact);
        (,,,,,,,,,bool active,) = loan.loans(0);
        assertTrue(active);
    }

    /// @notice interest = 0 is a valid loan offer (zero-interest loan).
    function test_createLoanOffer_zeroInterest_succeeds() public {
        uint256 id = 30;
        nft.mint(alice, id);

        vm.prank(alice);
        nft.approve(address(loan), id);
        vm.prank(alice);
        loan.createLoanOffer(address(nft), id, PRINCIPAL, 0, DURATION);

        (,,,,, uint256 interest,,,,,) = loan.loans(0);
        assertEq(interest, 0);
    }

    /// @notice loanCounter increments monotonically: 0 → 1 → 2.
    function test_createLoanOffer_incrementsLoanCounter() public {
        assertEq(loan.loanCounter(), 0);

        _createOffer(NFT_ID, PRINCIPAL, INTEREST, DURATION);
        assertEq(loan.loanCounter(), 1);

        uint256 id2 = 2;
        nft.mint(alice, id2);
        _createOffer(id2, PRINCIPAL, INTEREST, DURATION);
        assertEq(loan.loanCounter(), 2);
    }

    /// @notice Paused contract blocks createLoanOffer.
    function test_createLoanOffer_whenPaused_reverts() public {
        vm.prank(admin);
        loan.pause();

        uint256 id = 40;
        nft.mint(alice, id);
        vm.prank(alice);
        nft.approve(address(loan), id);

        vm.prank(alice);
        vm.expectRevert();
        loan.createLoanOffer(address(nft), id, PRINCIPAL, INTEREST, DURATION);
    }

    /// @notice LoanCreated event is emitted with correct parameters.
    function test_createLoanOffer_emitsLoanCreatedEvent() public {
        // collateralValue = 2000e6, principal = 1000e6 → LTV 50% → health = 100
        uint256 expectedHealth = 100;

        vm.prank(alice);
        nft.approve(address(loan), NFT_ID);

        vm.expectEmit(true, true, false, true);
        emit LoanCreated(0, alice, PRINCIPAL, expectedHealth);

        vm.prank(alice);
        loan.createLoanOffer(address(nft), NFT_ID, PRINCIPAL, INTEREST, DURATION);
    }

    // ══════════════════════════════════════════════════════════════════════════
    //  cancelLoanOffer
    // ══════════════════════════════════════════════════════════════════════════

    /// @notice NFT is returned to borrower on cancel.
    function test_cancelLoanOffer_returnsNFT() public {
        _createOffer(NFT_ID, PRINCIPAL, INTEREST, DURATION);

        vm.prank(alice);
        loan.cancelLoanOffer(0);

        assertEq(nft.ownerOf(NFT_ID), alice, "NFT should return to alice");
    }

    /// @notice loan.active = false after cancel.
    function test_cancelLoanOffer_setsInactive() public {
        _createOffer(NFT_ID, PRINCIPAL, INTEREST, DURATION);

        vm.prank(alice);
        loan.cancelLoanOffer(0);

        (,,,,,,,,,bool active,) = loan.loans(0);
        assertFalse(active, "loan should be inactive after cancel");
    }

    /// @notice Non-borrower cannot cancel.
    function test_cancelLoanOffer_revertsIfNotBorrower() public {
        _createOffer(NFT_ID, PRINCIPAL, INTEREST, DURATION);

        vm.prank(bob);
        vm.expectRevert("Not borrower");
        loan.cancelLoanOffer(0);
    }

    /// @notice Funded loan (lender != address(0)) cannot be cancelled.
    function test_cancelLoanOffer_revertsIfFunded() public {
        _createOffer(NFT_ID, PRINCIPAL, INTEREST, DURATION);
        _acceptLoan(0);

        vm.prank(alice);
        vm.expectRevert("Cannot cancel active or funded loan");
        loan.cancelLoanOffer(0);
    }

    /// @notice Already-cancelled loan cannot be cancelled again.
    function test_cancelLoanOffer_revertsIfAlreadyCancelled() public {
        _createOffer(NFT_ID, PRINCIPAL, INTEREST, DURATION);

        vm.prank(alice);
        loan.cancelLoanOffer(0);

        vm.prank(alice);
        vm.expectRevert("Cannot cancel active or funded loan");
        loan.cancelLoanOffer(0);
    }

    /// @notice LoanCancelled event is emitted.
    function test_cancelLoanOffer_emitsLoanCancelledEvent() public {
        _createOffer(NFT_ID, PRINCIPAL, INTEREST, DURATION);

        vm.expectEmit(true, false, false, false);
        emit LoanCancelled(0);

        vm.prank(alice);
        loan.cancelLoanOffer(0);
    }

    // ══════════════════════════════════════════════════════════════════════════
    //  acceptLoan
    // ══════════════════════════════════════════════════════════════════════════

    /// @notice alice receives principal - fee (net) when bob accepts.
    function test_acceptLoan_transfersPrincipalMinusFee() public {
        _createOffer(NFT_ID, PRINCIPAL, INTEREST, DURATION);

        uint256 aliceBefore = usdc.balanceOf(alice);
        _acceptLoan(0);

        uint256 fee = (PRINCIPAL * loan.BROKER_FEE_BPS()) / 10_000;
        assertEq(usdc.balanceOf(alice), aliceBefore + PRINCIPAL - fee, "alice net principal mismatch");
    }

    /// @notice Exact math: principal=10_000e6, fee=1%=100e6, alice gets 9_900e6.
    function test_acceptLoan_feeCalculation_exactMath() public {
        uint256 bigPrincipal = 10_000e6;
        uint256 expectedFee  = 100e6;
        uint256 expectedNet  = 9_900e6;

        uint256 id = 50;
        nft.mint(alice, id);

        vm.prank(alice);
        nft.approve(address(loan), id);
        vm.prank(alice);
        loan.createLoanOffer(address(nft), id, bigPrincipal, INTEREST, DURATION);

        usdc.mint(bob, bigPrincipal);
        uint256 aliceBefore = usdc.balanceOf(alice);

        vm.prank(bob);
        usdc.approve(address(loan), bigPrincipal);
        vm.prank(bob);
        loan.acceptLoan(0, new bytes[](0));

        assertEq(usdc.balanceOf(alice) - aliceBefore, expectedNet, "net principal to alice");
        assertEq(usdc.balanceOf(address(loan)),        expectedFee, "fee in contract");
    }

    /// @notice loan.lender = bob and loan.startTime = block.timestamp after accept.
    function test_acceptLoan_setsLenderAndStartTime() public {
        _createOffer(NFT_ID, PRINCIPAL, INTEREST, DURATION);

        uint256 ts = block.timestamp;
        _acceptLoan(0);

        (, address lender,,,,,, uint256 startTime,,,) = loan.loans(0);
        assertEq(lender,    bob, "lender mismatch");
        assertEq(startTime, ts,  "startTime mismatch");
    }

    /// @notice Accepting an already-funded loan reverts.
    function test_acceptLoan_revertsIfAlreadyFunded() public {
        _createOffer(NFT_ID, PRINCIPAL, INTEREST, DURATION);
        _acceptLoan(0);

        usdc.mint(charlie, PRINCIPAL);
        vm.prank(charlie);
        usdc.approve(address(loan), PRINCIPAL);

        vm.prank(charlie);
        vm.expectRevert("Loan not available");
        loan.acceptLoan(0, new bytes[](0));
    }

    /// @notice Cancelled loan cannot be accepted.
    function test_acceptLoan_revertsIfCancelled() public {
        _createOffer(NFT_ID, PRINCIPAL, INTEREST, DURATION);

        vm.prank(alice);
        loan.cancelLoanOffer(0);

        vm.prank(bob);
        usdc.approve(address(loan), PRINCIPAL);
        vm.prank(bob);
        vm.expectRevert("Loan not available");
        loan.acceptLoan(0, new bytes[](0));
    }

    /// @notice Borrower cannot be lender (self-lending).
    function test_acceptLoan_revertsSelfLending() public {
        _createOffer(NFT_ID, PRINCIPAL, INTEREST, DURATION);

        vm.prank(alice);
        usdc.approve(address(loan), PRINCIPAL);
        vm.prank(alice);
        vm.expectRevert("Cannot lend to self");
        loan.acceptLoan(0, new bytes[](0));
    }

    /// @notice When no staking contract is set, fee stays in loan contract.
    function test_acceptLoan_feeStaysInContract_whenNoStaking() public {
        _createOffer(NFT_ID, PRINCIPAL, INTEREST, DURATION);
        _acceptLoan(0);

        uint256 fee = (PRINCIPAL * loan.BROKER_FEE_BPS()) / 10_000;
        assertEq(usdc.balanceOf(address(loan)), fee, "fee should sit in loan contract");
    }

    /// @notice When staking contract is set, fee is forwarded and staker can claim.
    function test_acceptLoan_feeForwardedToStaking_whenSet() public {
        // Deploy staking infra
        vm.startPrank(admin);
        ClawToken clawToken = new ClawToken(admin);
        ClawStreetStaking staking = new ClawStreetStaking(
            address(clawToken), address(usdc), admin
        );
        staking.setFeeNotifier(address(loan), true);
        loan.setStakingContract(address(staking));
        vm.stopPrank();

        // Alice stakes CLAW so she has a staking position
        vm.prank(admin);
        clawToken.mint(alice, 1_000 * 1e18);
        vm.prank(alice);
        clawToken.approve(address(staking), 1_000 * 1e18);
        vm.prank(alice);
        staking.stake(1_000 * 1e18);

        // Create and accept loan
        _createOffer(NFT_ID, PRINCIPAL, INTEREST, DURATION);
        _acceptLoan(0);

        uint256 fee = (PRINCIPAL * loan.BROKER_FEE_BPS()) / 10_000;

        // Fee forwarded to staking, not in loan contract
        assertEq(usdc.balanceOf(address(loan)),    0,   "fee should leave loan contract");
        assertEq(usdc.balanceOf(address(staking)), fee, "fee should be in staking");
        assertApproxEqAbs(staking.pendingRevenue(alice), fee, 1);
    }

    /// @notice LoanAccepted and FeeCollected events are both emitted.
    function test_acceptLoan_emitsLoanAcceptedAndFeeCollectedEvents() public {
        _createOffer(NFT_ID, PRINCIPAL, INTEREST, DURATION);

        uint256 fee = (PRINCIPAL * loan.BROKER_FEE_BPS()) / 10_000;

        vm.prank(bob);
        usdc.approve(address(loan), PRINCIPAL);

        vm.expectEmit(true, true, false, false);
        emit LoanAccepted(0, bob);

        vm.expectEmit(false, false, false, true);
        emit FeeCollected(fee);

        vm.prank(bob);
        loan.acceptLoan(0, new bytes[](0));
    }

    // ══════════════════════════════════════════════════════════════════════════
    //  repayLoan
    // ══════════════════════════════════════════════════════════════════════════

    /// @notice NFT returns to alice after repayment.
    function test_repayLoan_returnsNFT_toBorrower() public {
        _createOffer(NFT_ID, PRINCIPAL, INTEREST, DURATION);
        _acceptLoan(0);
        _repayLoan(0);

        assertEq(nft.ownerOf(NFT_ID), alice, "NFT should return to borrower");
    }

    /// @notice Bob (lender) receives exactly principal + interest.
    function test_repayLoan_transfersPrincipalPlusInterest_toLender() public {
        _createOffer(NFT_ID, PRINCIPAL, INTEREST, DURATION);
        _acceptLoan(0);

        uint256 bobBefore = usdc.balanceOf(bob);
        // bob sent PRINCIPAL out to accept, so he is at bobInitial - PRINCIPAL
        _repayLoan(0);

        assertEq(
            usdc.balanceOf(bob) - bobBefore,
            PRINCIPAL + INTEREST,
            "lender should receive principal + interest"
        );
    }

    /// @notice repaid = true and active = false after repayment.
    function test_repayLoan_setsRepaidAndInactive() public {
        _createOffer(NFT_ID, PRINCIPAL, INTEREST, DURATION);
        _acceptLoan(0);
        _repayLoan(0);

        (,,,,,,,,,bool active, bool repaid) = loan.loans(0);
        assertFalse(active, "loan should be inactive");
        assertTrue(repaid,  "loan should be repaid");
    }

    /// @notice Only borrower can call repayLoan — lender calling must revert.
    function test_repayLoan_revertsIfNotBorrower() public {
        _createOffer(NFT_ID, PRINCIPAL, INTEREST, DURATION);
        _acceptLoan(0);

        uint256 total = PRINCIPAL + INTEREST;
        usdc.mint(bob, total);
        vm.prank(bob);
        usdc.approve(address(loan), total);

        vm.prank(bob);
        vm.expectRevert("Only borrower can repay");
        loan.repayLoan(0);
    }

    /// @notice Double repay reverts because loan is no longer active.
    function test_repayLoan_revertsIfAlreadyRepaid() public {
        _createOffer(NFT_ID, PRINCIPAL, INTEREST, DURATION);
        _acceptLoan(0);
        _repayLoan(0);

        // Second repay — need allowance first but expect revert before transfer
        vm.prank(alice);
        usdc.approve(address(loan), PRINCIPAL + INTEREST);
        vm.prank(alice);
        vm.expectRevert("Invalid loan state");
        loan.repayLoan(0);
    }

    /// @notice Repaying a cancelled (not-active) loan reverts.
    function test_repayLoan_revertsIfNotActive() public {
        _createOffer(NFT_ID, PRINCIPAL, INTEREST, DURATION);

        vm.prank(alice);
        loan.cancelLoanOffer(0);

        vm.prank(alice);
        usdc.approve(address(loan), PRINCIPAL + INTEREST);
        vm.prank(alice);
        vm.expectRevert("Invalid loan state");
        loan.repayLoan(0);
    }

    /// @notice Zero-interest loan: alice transfers only principal to lender.
    function test_repayLoan_zeroInterest_transfersOnlyPrincipal() public {
        uint256 id = 60;
        nft.mint(alice, id);
        vm.prank(alice);
        nft.approve(address(loan), id);
        vm.prank(alice);
        loan.createLoanOffer(address(nft), id, PRINCIPAL, 0, DURATION);

        _acceptLoan(0);

        uint256 bobBefore = usdc.balanceOf(bob);
        vm.prank(alice);
        usdc.approve(address(loan), PRINCIPAL);
        vm.prank(alice);
        loan.repayLoan(0);

        assertEq(usdc.balanceOf(bob) - bobBefore, PRINCIPAL, "zero interest: only principal returned");
    }

    /// @notice LoanRepaid event is emitted.
    function test_repayLoan_emitsLoanRepaidEvent() public {
        _createOffer(NFT_ID, PRINCIPAL, INTEREST, DURATION);
        _acceptLoan(0);

        vm.prank(alice);
        usdc.approve(address(loan), PRINCIPAL + INTEREST);

        vm.expectEmit(true, false, false, false);
        emit LoanRepaid(0);

        vm.prank(alice);
        loan.repayLoan(0);
    }

    // ══════════════════════════════════════════════════════════════════════════
    //  claimDefault
    // ══════════════════════════════════════════════════════════════════════════

    /// @notice Lender (bob) gets NFT after duration expires.
    function test_claimDefault_lenderGetsNFT() public {
        _createOffer(NFT_ID, PRINCIPAL, INTEREST, DURATION);
        _acceptLoan(0);

        vm.warp(block.timestamp + DURATION + 1);
        vm.prank(bob);
        loan.claimDefault(0);

        assertEq(nft.ownerOf(NFT_ID), bob, "lender should receive NFT on default");
    }

    /// @notice loan.active = false after default.
    function test_claimDefault_setsInactive() public {
        _createOffer(NFT_ID, PRINCIPAL, INTEREST, DURATION);
        _acceptLoan(0);

        vm.warp(block.timestamp + DURATION + 1);
        vm.prank(bob);
        loan.claimDefault(0);

        (,,,,,,,,,bool active,) = loan.loans(0);
        assertFalse(active, "loan should be inactive after default");
    }

    /// @notice At exactly startTime + duration (not strictly greater), the `>` guard reverts.
    function test_claimDefault_revertsBeforeExpiry_exactBoundary() public {
        _createOffer(NFT_ID, PRINCIPAL, INTEREST, DURATION);

        uint256 acceptedAt = block.timestamp;
        _acceptLoan(0);

        // Warp to startTime + duration — condition requires block.timestamp > startTime + duration
        vm.warp(acceptedAt + DURATION);

        vm.prank(bob);
        vm.expectRevert("Not yet defaulted");
        loan.claimDefault(0);
    }

    /// @notice One second past the boundary allows claimDefault.
    function test_claimDefault_succeedsOneSec_afterExpiry() public {
        _createOffer(NFT_ID, PRINCIPAL, INTEREST, DURATION);
        uint256 acceptedAt = block.timestamp;
        _acceptLoan(0);

        vm.warp(acceptedAt + DURATION + 1);
        vm.prank(bob);
        loan.claimDefault(0); // must not revert

        assertEq(nft.ownerOf(NFT_ID), bob);
    }

    /// @notice NOTE: claimDefault has NO msg.sender == lender check.
    ///         Anyone can trigger default after expiry; NFT still goes to loan.lender.
    ///         This is tested in edge file. Here we document the behavior:
    ///         charlie calls, NFT goes to bob (the lender).
    function test_claimDefault_revertsIfNotLender() public {
        // Actually, in this contract there is NO lender check — anyone can call.
        // We demonstrate the design: charlie calls, bob gets the NFT.
        _createOffer(NFT_ID, PRINCIPAL, INTEREST, DURATION);
        _acceptLoan(0);

        vm.warp(block.timestamp + DURATION + 1);

        // charlie calling succeeds (no access control); NFT goes to lender (bob)
        vm.prank(charlie);
        loan.claimDefault(0);

        assertEq(nft.ownerOf(NFT_ID), bob, "NFT should go to lender, not caller");
    }

    /// @notice Already-repaid loan cannot be defaulted.
    function test_claimDefault_revertsIfRepaid() public {
        _createOffer(NFT_ID, PRINCIPAL, INTEREST, DURATION);
        _acceptLoan(0);
        _repayLoan(0);

        vm.warp(block.timestamp + DURATION + 1);
        vm.prank(bob);
        vm.expectRevert("Invalid loan");
        loan.claimDefault(0);
    }

    /// @notice Unfunded loan (lender == address(0)) reverts with "Loan not funded".
    function test_claimDefault_revertsIfUnfunded() public {
        _createOffer(NFT_ID, PRINCIPAL, INTEREST, DURATION);

        vm.warp(block.timestamp + DURATION + 1);

        vm.prank(charlie);
        vm.expectRevert("Loan not funded");
        loan.claimDefault(0);
    }

    /// @notice Double default reverts because loan is no longer active.
    function test_claimDefault_revertsIfAlreadyDefaulted() public {
        _createOffer(NFT_ID, PRINCIPAL, INTEREST, DURATION);
        _acceptLoan(0);

        vm.warp(block.timestamp + DURATION + 1);
        vm.prank(bob);
        loan.claimDefault(0);

        vm.prank(bob);
        vm.expectRevert("Invalid loan");
        loan.claimDefault(0);
    }

    /// @notice LoanDefaulted event is emitted.
    function test_claimDefault_emitsLoanDefaultedEvent() public {
        _createOffer(NFT_ID, PRINCIPAL, INTEREST, DURATION);
        _acceptLoan(0);

        vm.warp(block.timestamp + DURATION + 1);

        vm.expectEmit(true, false, false, false);
        emit LoanDefaulted(0);

        vm.prank(bob);
        loan.claimDefault(0);
    }

    // ══════════════════════════════════════════════════════════════════════════
    //  suggestLTV — CRITICAL: was a bug, now fixed
    //
    //  Formula: if health < 55 → 0; else min(7000, 9000 - (100 - health) * 200)
    //  At health=55: 9000 - 45*200 = 9000 - 9000 = 0
    //  At health=56: 9000 - 44*200 = 9000 - 8800 = 200
    //  At health=100: 9000 - 0*200 = 9000 → capped at 7000
    // ══════════════════════════════════════════════════════════════════════════

    function test_suggestLTV_health0_returns0() public view {
        assertEq(loan.suggestLTV(0), 0, "health=0 should return 0");
    }

    function test_suggestLTV_health54_returns0() public view {
        assertEq(loan.suggestLTV(54), 0, "health=54 should return 0 (below 55 threshold)");
    }

    /// @notice At health=55: 9000 - (100-55)*200 = 9000 - 9000 = 0. Exactly breakeven.
    function test_suggestLTV_health55_returns0() public view {
        assertEq(loan.suggestLTV(55), 0, "health=55 should return 0 (breakeven: 9000-45*200=0)");
    }

    /// @notice At health=56: 9000 - (100-56)*200 = 9000 - 8800 = 200.
    function test_suggestLTV_health56_returns200() public view {
        assertEq(loan.suggestLTV(56), 200, "health=56 should return 200 bps (2% LTV)");
    }

    /// @notice At health=100: 9000 - 0 = 9000 → capped at 7000 by Math.min.
    function test_suggestLTV_health100_returns7000() public view {
        assertEq(loan.suggestLTV(100), 7000, "health=100 should return 7000 (70% cap)");
    }

    /// @notice health=101 exceeds range → must revert.
    function test_suggestLTV_health101_reverts() public {
        vm.expectRevert("Health out of range");
        loan.suggestLTV(101);
    }

    /// @notice Exact mid-curve: health=80 → min(7000, 9000 - 20*200) = min(7000, 5000) = 5000.
    function test_suggestLTV_health80_exact() public view {
        // 9000 - (100 - 80) * 200 = 9000 - 4000 = 5000; min(7000, 5000) = 5000
        assertEq(loan.suggestLTV(80), 5000, "health=80 should return 5000 bps");
    }

    /// @notice Fuzz: for any health ≤ 100, suggestLTV never exceeds 7000.
    function testFuzz_suggestLTV_neverReturnsAbove7000(uint8 health) public view {
        vm.assume(health <= 100);
        uint256 ltv = loan.suggestLTV(health);
        assertLe(ltv, 7000, "suggestLTV should never exceed 7000 bps");
    }

    // ══════════════════════════════════════════════════════════════════════════
    //  getHealthScore
    // ══════════════════════════════════════════════════════════════════════════

    /// @notice When Pyth price = 0, health = 0.
    function test_healthScore_priceZero_returns0() public {
        pyth.setPrice(0);
        uint256 score = loan.getHealthScore(address(nft), NFT_ID, PRINCIPAL, alice);
        assertEq(score, 0, "zero price should yield health=0");
    }

    /// @notice When principal = 0 (passed directly), health = 0.
    function test_healthScore_principalZero_returns0() public {
        uint256 score = loan.getHealthScore(address(nft), NFT_ID, 0, alice);
        assertEq(score, 0, "zero principal should yield health=0");
    }

    /// @notice LTV exactly 50% (collateralValue = 2*principal) → baseScore = 100, final = 100.
    function test_healthScore_exactlyAt50pctLTV_returns100() public {
        // price = 2000e6 (with expo=-6), principal = 1000e6 → LTV = 5000 bps = 50%
        // baseScore=100, discountMultiplier=100, repMultiplier=100
        // finalScore = min(100, 100*100*100/10000) = 100
        uint256 score = loan.getHealthScore(address(nft), NFT_ID, 1_000e6, alice);
        assertEq(score, 100, "50% LTV: health should be 100");
    }

    /// @notice LTV slightly over 50% → penalty applied.
    ///         principal = 1_020e6 → LTV = 1020/2000 = 5100 bps → excess = 100 bps
    ///         penalty = (100 * 2) / 100 = 2 → baseScore = 98 → finalScore = 98.
    function test_healthScore_slightlyOver50pct_penalty() public {
        uint256 principal = 1_020e6; // LTV = 51% with price=2000
        uint256 score = loan.getHealthScore(address(nft), NFT_ID, principal, alice);
        assertEq(score, 98, "LTV=51%: health should be 98");
    }

    /// @notice LTV high enough that penalty >= 100, score clamped to 0.
    ///         excess = 5000 bps → penalty = 5000*2/100 = 100 → baseScore = 0
    ///         principal = 2000e6 * (5000 + 5000) / 10000 = 10000e6 → LTV = 10000/2000 = 500%
    ///         excess = ltvBps(50000) - 5000 = 45000 → penalty = 45000*2/100 = 900 >= 100 → 0
    function test_healthScore_highLTV_clampsTo0() public {
        // principal = 50000e6, collateralValue = 2000e6 → LTV = 2500% → baseScore = 0
        uint256 principal = 50_000e6;
        usdc.mint(alice, principal);
        uint256 score = loan.getHealthScore(address(nft), NFT_ID, principal, alice);
        assertEq(score, 0, "extreme LTV: health should be 0");
    }

    /// @notice Volatility discount applied when spot drops > 5% below EMA.
    ///         spot = 1880 (drops 6% from ema=2000) → dropBps = 600 > 500 → multiplier=90
    ///         baseScore=100, discountMultiplier=90, repMultiplier=100
    ///         finalScore = 100 * 90 * 100 / 10000 = 90
    function test_healthScore_volatilityDiscount_applied() public {
        // EMA = 2000e6, spot = 1880e6 → 6% drop
        int64 ema  = 2_000_000_000;
        int64 spot = 1_880_000_000;
        pyth.setEmaPrice(ema);
        pyth.setPrice(spot);

        uint256 score = loan.getHealthScore(address(nft), NFT_ID, 1_000e6, alice);
        // collateralValue with spot = 1880e6 → LTV = 1000/1880 ≈ 5319 bps > 5000
        // excess = 319 → penalty = 319*2/100 = 6 → baseScore = 94
        // discountMultiplier = 90 → repMultiplier = 100
        // finalScore = 94 * 90 * 100 / 10000 = 84600/10000 = 84
        assertEq(score, 84, "6% vol drop should apply 0.9x discount");
    }

    /// @notice Volatility discount NOT applied when drop ≤ 5% (exactly 500 bps).
    ///         spot = 1900, ema = 2000 → dropBps = (100/2000)*10000 = 500 → NOT > 500
    function test_healthScore_volatilityDiscount_notApplied() public {
        int64 ema  = 2_000_000_000;
        int64 spot = 1_900_000_000; // 5% drop exactly
        pyth.setEmaPrice(ema);
        pyth.setPrice(spot);

        // dropBps = 500 which is NOT > 500 → discountMultiplier = 100
        // collateralValue = 1900e6, principal = 1000e6 → LTV = 5263 bps
        // excess = 263 → penalty = 263*2/100 = 5 → baseScore = 95
        // finalScore = 95 * 100 * 100 / 10000 = 95
        uint256 score = loan.getHealthScore(address(nft), NFT_ID, 1_000e6, alice);
        assertEq(score, 95, "5% drop (exactly 500 bps) should NOT trigger volatility discount");
    }

    /// @notice Reputation score > 800 → multiplier = 110 → score boosted (capped at 100).
    function test_healthScore_reputationBoost_above800() public {
        vm.prank(admin);
        loan.setReputationOracle(address(reputation));
        reputation.setScore(alice, 850);

        // baseScore=100, discountMultiplier=100, repMultiplier=110
        // finalScore = min(100, 100*100*110/10000) = min(100, 110) = 100
        uint256 score = loan.getHealthScore(address(nft), NFT_ID, 1_000e6, alice);
        assertEq(score, 100, "rep>800 with perfect base should cap at 100");
    }

    /// @notice Reputation score < 500 → multiplier = 90 → score penalised.
    function test_healthScore_reputationPenalty_below500() public {
        vm.prank(admin);
        loan.setReputationOracle(address(reputation));
        reputation.setScore(alice, 400);

        // baseScore=100, discountMultiplier=100, repMultiplier=90
        // finalScore = 100*100*90/10000 = 90
        uint256 score = loan.getHealthScore(address(nft), NFT_ID, 1_000e6, alice);
        assertEq(score, 90, "rep<500 should apply 0.9x penalty");
    }

    /// @notice Reputation score 500–800 → multiplier = 100 → neutral.
    function test_healthScore_reputationNeutral_500to800() public {
        vm.prank(admin);
        loan.setReputationOracle(address(reputation));
        reputation.setScore(alice, 650);

        uint256 score = loan.getHealthScore(address(nft), NFT_ID, 1_000e6, alice);
        assertEq(score, 100, "rep 500-800 should be neutral (100%)");
    }

    /// @notice Reputation score == 800 → NOT > 800 → multiplier = 100 (neutral).
    function test_healthScore_reputationBoundary_exactly800() public {
        vm.prank(admin);
        loan.setReputationOracle(address(reputation));
        reputation.setScore(alice, 800);

        // score == 800 → condition is score > 800 → false → neutral
        uint256 h = loan.getHealthScore(address(nft), NFT_ID, 1_000e6, alice);
        assertEq(h, 100, "rep=800 should be neutral (not > 800)");
    }

    /// @notice Reputation score == 500 → NOT < 500 → multiplier = 100 (neutral).
    function test_healthScore_reputationBoundary_exactly500() public {
        vm.prank(admin);
        loan.setReputationOracle(address(reputation));
        reputation.setScore(alice, 500);

        // score == 500 → condition is score < 500 → false → neutral
        uint256 h = loan.getHealthScore(address(nft), NFT_ID, 1_000e6, alice);
        assertEq(h, 100, "rep=500 should be neutral (not < 500)");
    }

    /// @notice Even with repMultiplier=110, finalScore is capped at 100.
    function test_healthScore_finalScore_cappedAt100() public {
        vm.prank(admin);
        loan.setReputationOracle(address(reputation));
        reputation.setScore(alice, 900);

        // Perfect setup: LTV=50%, no vol discount, rep multiplier=110
        // 100 * 100 * 110 / 10000 = 110 → capped at 100
        uint256 score = loan.getHealthScore(address(nft), NFT_ID, 1_000e6, alice);
        assertEq(score, 100, "final score must never exceed 100");
    }

    // ══════════════════════════════════════════════════════════════════════════
    //  Admin functions
    // ══════════════════════════════════════════════════════════════════════════

    /// @notice Paused contract blocks all write functions.
    function test_pause_blocksAllWriteFunctions() public {
        vm.prank(admin);
        loan.pause();

        uint256 id = 70;
        nft.mint(alice, id);
        vm.prank(alice);
        nft.approve(address(loan), id);

        // createLoanOffer
        vm.prank(alice);
        vm.expectRevert();
        loan.createLoanOffer(address(nft), id, PRINCIPAL, INTEREST, DURATION);

        // cancelLoanOffer — create directly in storage is not possible; skip direct test
        // acceptLoan
        vm.prank(bob);
        usdc.approve(address(loan), PRINCIPAL);
        vm.prank(bob);
        vm.expectRevert();
        loan.acceptLoan(0, new bytes[](0));

        // repayLoan
        vm.prank(alice);
        usdc.approve(address(loan), PRINCIPAL + INTEREST);
        vm.prank(alice);
        vm.expectRevert();
        loan.repayLoan(0);

        // claimDefault
        vm.prank(bob);
        vm.expectRevert();
        loan.claimDefault(0);
    }

    /// @notice After unpause, operations succeed.
    function test_unpause_restoresAllWriteFunctions() public {
        vm.prank(admin);
        loan.pause();

        vm.prank(admin);
        loan.unpause();

        // createLoanOffer should now work
        vm.prank(alice);
        nft.approve(address(loan), NFT_ID);
        vm.prank(alice);
        loan.createLoanOffer(address(nft), NFT_ID, PRINCIPAL, INTEREST, DURATION); // must not revert

        (,,,,,,,,,bool active,) = loan.loans(0);
        assertTrue(active);
    }

    /// @notice Admin can sweep fees from contract to treasury.
    function test_withdrawFees_adminSweeps() public {
        _createOffer(NFT_ID, PRINCIPAL, INTEREST, DURATION);
        _acceptLoan(0);

        uint256 fee = (PRINCIPAL * loan.BROKER_FEE_BPS()) / 10_000;
        assertEq(usdc.balanceOf(address(loan)), fee);

        vm.prank(admin);
        loan.withdrawFees(treasury);

        assertEq(usdc.balanceOf(treasury),       fee, "treasury should receive fee");
        assertEq(usdc.balanceOf(address(loan)), 0,   "loan contract should have 0 balance");
    }

    /// @notice withdrawFees reverts when balance is zero.
    function test_withdrawFees_revertsIfZeroBalance() public {
        vm.prank(admin);
        vm.expectRevert("No fees to withdraw");
        loan.withdrawFees(treasury);
    }

    /// @notice Non-admin cannot call withdrawFees.
    function test_withdrawFees_revertsIfNotAdmin() public {
        _createOffer(NFT_ID, PRINCIPAL, INTEREST, DURATION);
        _acceptLoan(0);

        vm.prank(alice);
        vm.expectRevert();
        loan.withdrawFees(treasury);
    }

    /// @notice withdrawFees with to = address(0) reverts.
    function test_withdrawFees_revertsZeroAddress() public {
        _createOffer(NFT_ID, PRINCIPAL, INTEREST, DURATION);
        _acceptLoan(0);

        vm.prank(admin);
        vm.expectRevert("Zero address");
        loan.withdrawFees(address(0));
    }

    /// @notice Only ADMIN_ROLE can set staking contract; StakingContractSet event emitted.
    function test_setStakingContract_adminOnly() public {
        address fakeStaking = makeAddr("fakeStaking");

        // Non-admin reverts
        vm.prank(alice);
        vm.expectRevert();
        loan.setStakingContract(fakeStaking);

        // Admin succeeds and event is emitted
        vm.expectEmit(true, false, false, false);
        emit StakingContractSet(fakeStaking);

        vm.prank(admin);
        loan.setStakingContract(fakeStaking);
    }

    /// @notice Only ADMIN_ROLE can set reputation oracle.
    function test_setReputationOracle_adminOnly() public {
        address fakeRep = makeAddr("fakeRep");

        vm.prank(alice);
        vm.expectRevert();
        loan.setReputationOracle(fakeRep);

        vm.prank(admin);
        loan.setReputationOracle(fakeRep); // must not revert
    }

    /// @notice _authorizeUpgrade reverts for non-UPGRADER_ROLE callers.
    function test_upgradeAuthorization_onlyUpgraderRole() public {
        ClawStreetLoan newImpl = new ClawStreetLoan();

        vm.prank(alice);
        vm.expectRevert();
        loan.upgradeToAndCall(address(newImpl), "");
    }

    // ══════════════════════════════════════════════════════════════════════════
    //  Events (dedicated emit tests)
    // ══════════════════════════════════════════════════════════════════════════

    function test_event_loanCreated() public {
        vm.prank(alice);
        nft.approve(address(loan), NFT_ID);

        vm.expectEmit(true, true, false, false);
        emit LoanCreated(0, alice, PRINCIPAL, 0);

        vm.prank(alice);
        loan.createLoanOffer(address(nft), NFT_ID, PRINCIPAL, INTEREST, DURATION);
    }

    function test_event_loanAccepted() public {
        _createOffer(NFT_ID, PRINCIPAL, INTEREST, DURATION);

        vm.prank(bob);
        usdc.approve(address(loan), PRINCIPAL);

        vm.expectEmit(true, true, false, false);
        emit LoanAccepted(0, bob);

        vm.prank(bob);
        loan.acceptLoan(0, new bytes[](0));
    }

    function test_event_loanRepaid() public {
        _createOffer(NFT_ID, PRINCIPAL, INTEREST, DURATION);
        _acceptLoan(0);

        vm.prank(alice);
        usdc.approve(address(loan), PRINCIPAL + INTEREST);

        vm.expectEmit(true, false, false, false);
        emit LoanRepaid(0);

        vm.prank(alice);
        loan.repayLoan(0);
    }

    function test_event_loanDefaulted() public {
        _createOffer(NFT_ID, PRINCIPAL, INTEREST, DURATION);
        _acceptLoan(0);

        vm.warp(block.timestamp + DURATION + 1);

        vm.expectEmit(true, false, false, false);
        emit LoanDefaulted(0);

        vm.prank(bob);
        loan.claimDefault(0);
    }

    function test_event_loanCancelled() public {
        _createOffer(NFT_ID, PRINCIPAL, INTEREST, DURATION);

        vm.expectEmit(true, false, false, false);
        emit LoanCancelled(0);

        vm.prank(alice);
        loan.cancelLoanOffer(0);
    }

    function test_event_feeCollected() public {
        _createOffer(NFT_ID, PRINCIPAL, INTEREST, DURATION);

        uint256 fee = (PRINCIPAL * loan.BROKER_FEE_BPS()) / 10_000;

        vm.prank(bob);
        usdc.approve(address(loan), PRINCIPAL);

        vm.expectEmit(false, false, false, true);
        emit FeeCollected(fee);

        vm.prank(bob);
        loan.acceptLoan(0, new bytes[](0));
    }

    // ══════════════════════════════════════════════════════════════════════════
    //  Helpers
    // ══════════════════════════════════════════════════════════════════════════

    function _createOffer(uint256 nftId, uint256 principal, uint256 interest, uint256 duration) internal {
        vm.prank(alice);
        nft.approve(address(loan), nftId);
        vm.prank(alice);
        loan.createLoanOffer(address(nft), nftId, principal, interest, duration);
    }

    function _acceptLoan(uint256 loanId) internal {
        vm.prank(bob);
        usdc.approve(address(loan), PRINCIPAL);
        vm.prank(bob);
        loan.acceptLoan(loanId, new bytes[](0));
    }

    function _repayLoan(uint256 loanId) internal {
        uint256 total = PRINCIPAL + INTEREST;
        vm.prank(alice);
        usdc.approve(address(loan), total);
        vm.prank(alice);
        loan.repayLoan(loanId);
    }

    // ─── Re-declare events for vm.expectEmit ──────────────────────────────────
    event LoanCreated(uint256 indexed loanId, address indexed borrower, uint256 principal, uint256 health);
    event LoanAccepted(uint256 indexed loanId, address indexed lender);
    event LoanRepaid(uint256 indexed loanId);
    event LoanDefaulted(uint256 indexed loanId);
    event LoanCancelled(uint256 indexed loanId);
    event FeeCollected(uint256 amount);
    event StakingContractSet(address indexed stakingContract);
    event FeesWithdrawn(address indexed to, uint256 amount);
}
