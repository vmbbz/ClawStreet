// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Test.sol";
import { ERC1967Proxy } from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";
import { ClawStreetLoan } from "../contracts/ClawStreetLoan.sol";

// ─── Mock contracts ───────────────────────────────────────────────────────────

contract MockERC20 {
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;
    uint8 public decimals = 6;

    function mint(address to, uint256 amount) external {
        balanceOf[to] += amount;
    }

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
        require(ownerOf[id] == from);
        ownerOf[id] = to;
    }

    function safeTransferFrom(address from, address to, uint256 id) external {
        require(ownerOf[id] == from);
        ownerOf[id] = to;
    }

    function supportsInterface(bytes4) external pure returns (bool) { return true; }
}

/// @dev Pyth mock — returns a fixed price so health score is deterministic
contract MockPyth {
    int64 public mockPrice;
    int32 public mockExpo = -6; // 6 decimals

    struct Price {
        int64  price;
        uint64 conf;
        int32  expo;
        uint   publishTime;
    }

    function setPrice(int64 _price) external { mockPrice = _price; }

    function getPriceUnsafe(bytes32) external view returns (Price memory) {
        return Price({ price: mockPrice, conf: 0, expo: mockExpo, publishTime: block.timestamp });
    }

    function getEmaPriceUnsafe(bytes32) external view returns (Price memory) {
        return Price({ price: mockPrice, conf: 0, expo: mockExpo, publishTime: block.timestamp });
    }

    function getUpdateFee(bytes[] calldata) external pure returns (uint256) { return 0; }

    function updatePriceFeeds(bytes[] calldata) external payable {}
}

// ─── Test suite ───────────────────────────────────────────────────────────────

contract ClawStreetLoanTest is Test {
    ClawStreetLoan public loan;
    MockERC20  public usdc;
    MockERC721 public nft;
    MockPyth   public pyth;

    address public admin   = makeAddr("admin");
    address public alice   = makeAddr("alice"); // borrower
    address public bob     = makeAddr("bob");   // lender
    address public treasury = makeAddr("treasury");

    uint256 constant PRINCIPAL = 1_000e6;  // 1000 USDC
    uint256 constant INTEREST  = 50e6;     // 50 USDC
    uint256 constant DURATION  = 30 days;
    uint256 constant NFT_ID    = 1;

    function setUp() public {
        usdc = new MockERC20();
        nft  = new MockERC721();
        pyth = new MockPyth();

        // ETH price = $2000 (represented as 2000_000000 with expo -6)
        pyth.setPrice(2_000_000_000);

        // Deploy via UUPS proxy
        vm.startPrank(admin);
        ClawStreetLoan impl = new ClawStreetLoan();
        bytes memory init = abi.encodeCall(
            ClawStreetLoan.initialize,
            (address(usdc), address(pyth), bytes32(0))
        );
        ERC1967Proxy proxy = new ERC1967Proxy(address(impl), init);
        loan = ClawStreetLoan(address(proxy));
        vm.stopPrank();

        // Fund actors
        usdc.mint(alice, 10_000e6);
        usdc.mint(bob,   10_000e6);
        nft.mint(alice, NFT_ID);
    }

    // ── createLoanOffer ───────────────────────────────────────────────────────

    function test_createLoanOffer_escrowsNFT() public {
        _createOffer();
        assertEq(nft.ownerOf(NFT_ID), address(loan));
        (address borrower, address lender, address nftContract, uint256 nftId,,,,,, bool active,) = loan.loans(0);
        assertEq(borrower, alice);
        assertEq(lender, address(0));
        assertEq(nftContract, address(nft));
        assertEq(nftId, NFT_ID);
        assertTrue(active);
    }

    function test_createLoanOffer_revertsZeroPrincipal() public {
        nft.mint(alice, 2);
        vm.prank(alice);
        nft.approve(address(loan), 2);

        vm.prank(alice);
        vm.expectRevert("Principal must be > 0");
        loan.createLoanOffer(address(nft), 2, 0, INTEREST, DURATION);
    }

    // ── cancelLoanOffer ───────────────────────────────────────────────────────

    function test_cancelLoanOffer_returnsNFT() public {
        _createOffer();

        vm.prank(alice);
        loan.cancelLoanOffer(0);

        assertEq(nft.ownerOf(NFT_ID), alice);
        (,,,,,,,,,bool active,) = loan.loans(0);
        assertFalse(active);
    }

    function test_cancelLoanOffer_revertsIfNotBorrower() public {
        _createOffer();

        vm.prank(bob);
        vm.expectRevert("Not borrower");
        loan.cancelLoanOffer(0);
    }

    // ── acceptLoan ────────────────────────────────────────────────────────────

    function test_acceptLoan_transfersPrincipal() public {
        _createOffer();

        uint256 aliceBefore = usdc.balanceOf(alice);
        _acceptLoan();

        uint256 fee = (PRINCIPAL * 100) / 10000; // 1%
        uint256 net = PRINCIPAL - fee;

        assertEq(usdc.balanceOf(alice), aliceBefore + net);
        assertEq(usdc.balanceOf(address(loan)), fee); // fee sits in loan contract (no staking set)
    }

    function test_acceptLoan_setsLender() public {
        _createOffer();
        _acceptLoan();

        (,address lender,,,,,,,,,) = loan.loans(0);
        assertEq(lender, bob);
    }

    function test_acceptLoan_revertsIfFunded() public {
        _createOffer();
        _acceptLoan();

        address charlie = makeAddr("charlie");
        usdc.mint(charlie, 10_000e6);
        vm.prank(charlie);
        usdc.approve(address(loan), PRINCIPAL);
        vm.prank(charlie);
        vm.expectRevert("Loan not available");
        loan.acceptLoan(0, new bytes[](0));
    }

    // ── repayLoan ─────────────────────────────────────────────────────────────

    function test_repayLoan_returnsNFT() public {
        _createOffer();
        _acceptLoan();

        uint256 total = PRINCIPAL + INTEREST;
        vm.prank(alice);
        usdc.approve(address(loan), total);
        vm.prank(alice);
        loan.repayLoan(0);

        assertEq(nft.ownerOf(NFT_ID), alice);
        (,,,,,,,,,bool active, bool repaid) = loan.loans(0);
        assertFalse(active);
        assertTrue(repaid);
    }

    function test_repayLoan_transfersToLender() public {
        _createOffer();
        _acceptLoan();

        uint256 bobBefore = usdc.balanceOf(bob);
        uint256 total = PRINCIPAL + INTEREST;
        vm.prank(alice);
        usdc.approve(address(loan), total);
        vm.prank(alice);
        loan.repayLoan(0);

        assertEq(usdc.balanceOf(bob), bobBefore + total);
    }

    // ── claimDefault ──────────────────────────────────────────────────────────

    function test_claimDefault_lenderGetsNFT() public {
        _createOffer();
        _acceptLoan();

        vm.warp(block.timestamp + DURATION + 1);
        vm.prank(bob);
        loan.claimDefault(0);

        assertEq(nft.ownerOf(NFT_ID), bob);
    }

    function test_claimDefault_revertsBeforeExpiry() public {
        _createOffer();
        _acceptLoan();

        vm.warp(block.timestamp + DURATION - 1);
        vm.prank(bob);
        vm.expectRevert("Not yet defaulted");
        loan.claimDefault(0);
    }

    // ── withdrawFees (admin) ──────────────────────────────────────────────────

    function test_withdrawFees_adminSweepsFees() public {
        _createOffer();
        _acceptLoan();

        uint256 fee = (PRINCIPAL * 100) / 10000;
        assertEq(usdc.balanceOf(address(loan)), fee);

        vm.prank(admin);
        loan.withdrawFees(treasury);

        assertEq(usdc.balanceOf(treasury), fee);
        assertEq(usdc.balanceOf(address(loan)), 0);
    }

    function test_withdrawFees_revertsIfNotAdmin() public {
        vm.prank(alice);
        vm.expectRevert();
        loan.withdrawFees(treasury);
    }

    // ── pause / unpause ───────────────────────────────────────────────────────

    function test_pause_blocksOffers() public {
        vm.prank(admin);
        loan.pause();

        nft.mint(alice, 99);
        vm.prank(alice);
        nft.approve(address(loan), 99);
        vm.prank(alice);
        vm.expectRevert();
        loan.createLoanOffer(address(nft), 99, PRINCIPAL, INTEREST, DURATION);
    }

    // ─── Helpers ──────────────────────────────────────────────────────────────

    function _createOffer() internal {
        vm.prank(alice);
        nft.approve(address(loan), NFT_ID);
        vm.prank(alice);
        loan.createLoanOffer(address(nft), NFT_ID, PRINCIPAL, INTEREST, DURATION);
    }

    function _acceptLoan() internal {
        vm.prank(bob);
        usdc.approve(address(loan), PRINCIPAL);
        vm.prank(bob);
        loan.acceptLoan(0, new bytes[](0));
    }
}
