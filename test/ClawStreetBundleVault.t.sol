// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Test.sol";
import { ERC1967Proxy } from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";
import { ClawStreetBundleVault } from "../contracts/ClawStreetBundleVault.sol";

// ─── Mock ERC-20 for bundles ──────────────────────────────────────────────────

contract MockERC20Bundle {
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

// ─── Mock ERC-721 for bundles ─────────────────────────────────────────────────

contract MockERC721Bundle {
    string public name;
    mapping(uint256 => address) public ownerOf;
    mapping(address => mapping(address => bool)) public isApprovedForAll;
    mapping(uint256 => address) public getApproved;

    constructor(string memory _name) { name = _name; }

    function mint(address to, uint256 id) external { ownerOf[id] = to; }

    function approve(address to, uint256 id) external { getApproved[id] = to; }

    function setApprovalForAll(address operator, bool approved) external {
        isApprovedForAll[msg.sender][operator] = approved;
    }

    function transferFrom(address from, address to, uint256 id) external {
        require(ownerOf[id] == from, "not owner");
        require(
            msg.sender == from ||
            isApprovedForAll[from][msg.sender] ||
            getApproved[id] == msg.sender,
            "not approved"
        );
        ownerOf[id] = to;
    }

    function safeTransferFrom(address from, address to, uint256 id) external {
        require(ownerOf[id] == from, "not owner");
        ownerOf[id] = to;
    }

    function supportsInterface(bytes4) external pure returns (bool) { return true; }
}

// ─── Test suite ───────────────────────────────────────────────────────────────

contract ClawStreetBundleVaultTest is Test {
    ClawStreetBundleVault public vault;

    MockERC20Bundle public tokenA;
    MockERC20Bundle public tokenB;
    MockERC721Bundle public nftA;
    MockERC721Bundle public nftB;

    address public admin = makeAddr("admin");
    address public alice = makeAddr("alice");
    address public bob   = makeAddr("bob");

    uint256 constant AMOUNT_A = 1_000e18;
    uint256 constant AMOUNT_B = 500e6;
    uint256 constant NFT_ID_1 = 1;
    uint256 constant NFT_ID_2 = 2;

    function setUp() public {
        tokenA = new MockERC20Bundle("TokenA");
        tokenB = new MockERC20Bundle("TokenB");
        nftA   = new MockERC721Bundle("NFTA");
        nftB   = new MockERC721Bundle("NFTB");

        vm.startPrank(admin);
        ClawStreetBundleVault impl = new ClawStreetBundleVault();
        bytes memory init = abi.encodeCall(
            ClawStreetBundleVault.initialize,
            ("ClawBundle", "CLAWB")
        );
        ERC1967Proxy proxy = new ERC1967Proxy(address(impl), init);
        vault = ClawStreetBundleVault(address(proxy));
        vm.stopPrank();

        // Fund alice
        tokenA.mint(alice, 100_000e18);
        tokenB.mint(alice, 100_000e6);
        nftA.mint(alice, NFT_ID_1);
        nftA.mint(alice, NFT_ID_2);
        nftB.mint(alice, NFT_ID_1);
        nftB.mint(alice, NFT_ID_2);

        // Fund bob
        tokenA.mint(bob, 100_000e18);
        tokenB.mint(bob, 100_000e6);
        nftA.mint(bob, 10);
        nftB.mint(bob, 10);
    }

    // ─── depositBundle — ERC20 only ───────────────────────────────────────────

    function test_depositBundle_erc20Only() public {
        address[] memory erc20Tokens   = _arr(address(tokenA), address(tokenB));
        uint256[] memory erc20Amounts  = _amounts(AMOUNT_A, AMOUNT_B);
        address[] memory erc721Contracts = new address[](0);
        uint256[] memory erc721Ids      = new uint256[](0);

        _approveERC20(alice, AMOUNT_A, AMOUNT_B);

        vm.prank(alice);
        uint256 tokenId = vault.depositBundle(erc20Tokens, erc20Amounts, erc721Contracts, erc721Ids, "ipfs://test");

        // Vault holds the tokens
        assertEq(tokenA.balanceOf(address(vault)), AMOUNT_A);
        assertEq(tokenB.balanceOf(address(vault)), AMOUNT_B);

        // Alice received the bundle NFT
        assertEq(vault.ownerOf(tokenId), alice);
        assertEq(tokenId, 0); // first deposit
    }

    // ─── depositBundle — ERC721 only ─────────────────────────────────────────

    function test_depositBundle_erc721Only() public {
        address[] memory erc20Tokens   = new address[](0);
        uint256[] memory erc20Amounts  = new uint256[](0);
        address[] memory erc721Contracts = _arr(address(nftA), address(nftB));
        uint256[] memory erc721Ids       = _amounts(NFT_ID_1, NFT_ID_1);

        vm.prank(alice);
        nftA.approve(address(vault), NFT_ID_1);
        vm.prank(alice);
        nftB.approve(address(vault), NFT_ID_1);

        vm.prank(alice);
        uint256 tokenId = vault.depositBundle(erc20Tokens, erc20Amounts, erc721Contracts, erc721Ids, "ipfs://test");

        assertEq(nftA.ownerOf(NFT_ID_1), address(vault));
        assertEq(nftB.ownerOf(NFT_ID_1), address(vault));
        assertEq(vault.ownerOf(tokenId), alice);
    }

    // ─── depositBundle — mixed ERC20 + ERC721 ────────────────────────────────

    function test_depositBundle_mixed() public {
        address[] memory erc20Tokens     = _arr(address(tokenA));
        uint256[] memory erc20Amounts    = _amounts(AMOUNT_A);
        address[] memory erc721Contracts = _arr(address(nftA));
        uint256[] memory erc721Ids       = _amounts(NFT_ID_1);

        vm.prank(alice);
        tokenA.approve(address(vault), AMOUNT_A);
        vm.prank(alice);
        nftA.approve(address(vault), NFT_ID_1);

        vm.prank(alice);
        uint256 tokenId = vault.depositBundle(erc20Tokens, erc20Amounts, erc721Contracts, erc721Ids, "ipfs://bundle");

        assertEq(tokenA.balanceOf(address(vault)), AMOUNT_A);
        assertEq(nftA.ownerOf(NFT_ID_1), address(vault));
        assertEq(vault.ownerOf(tokenId), alice);
    }

    // ─── depositBundle — empty bundle now reverts (FIXED) ────────────────────

    /// @notice AUDIT FINDING: LOW — empty bundle deposit now reverts with "Bundle cannot be empty".
    function test_depositBundle_empty() public {
        address[] memory empty20      = new address[](0);
        uint256[] memory emptyAmounts = new uint256[](0);
        address[] memory empty721     = new address[](0);
        uint256[] memory emptyIds     = new uint256[](0);

        vm.prank(alice);
        vm.expectRevert("Bundle cannot be empty");
        vault.depositBundle(empty20, emptyAmounts, empty721, emptyIds, "");
    }

    // ─── depositBundle — length mismatch ERC20 reverts ───────────────────────

    function test_depositBundle_lengthMismatch_erc20_reverts() public {
        address[] memory tokens  = _arr(address(tokenA), address(tokenB));
        uint256[] memory amounts = _amounts(AMOUNT_A); // length 1, not 2

        vm.prank(alice);
        vm.expectRevert("ERC20 length mismatch");
        vault.depositBundle(tokens, amounts, new address[](0), new uint256[](0), "");
    }

    // ─── depositBundle — length mismatch ERC721 reverts ──────────────────────

    function test_depositBundle_lengthMismatch_erc721_reverts() public {
        address[] memory contracts = _arr(address(nftA), address(nftB));
        uint256[] memory ids       = _amounts(NFT_ID_1); // length 1, not 2

        vm.prank(alice);
        vm.expectRevert("ERC721 length mismatch");
        vault.depositBundle(new address[](0), new uint256[](0), contracts, ids, "");
    }

    // ─── withdrawBundle — all assets returned ────────────────────────────────

    function test_withdrawBundle_returnsAllAssets() public {
        uint256 tokenId = _depositMixed(alice);

        uint256 aliceTokenABefore = tokenA.balanceOf(alice);
        uint256 aliceTokenBBefore = tokenB.balanceOf(alice);

        vm.prank(alice);
        vault.withdrawBundle(tokenId);

        assertEq(tokenA.balanceOf(alice), aliceTokenABefore + AMOUNT_A);
        assertEq(tokenB.balanceOf(alice), aliceTokenBBefore + AMOUNT_B);
        assertEq(nftA.ownerOf(NFT_ID_1), alice);
        assertEq(nftB.ownerOf(NFT_ID_1), alice);
    }

    // ─── withdrawBundle — bundle NFT is burned ───────────────────────────────

    function test_withdrawBundle_burnsNFT() public {
        uint256 tokenId = _depositMixed(alice);

        vm.prank(alice);
        vault.withdrawBundle(tokenId);

        // ownerOf should revert (ERC721: token burned)
        vm.expectRevert();
        vault.ownerOf(tokenId);
    }

    // ─── withdrawBundle — non-owner reverts ──────────────────────────────────

    function test_withdrawBundle_nonOwner_reverts() public {
        uint256 tokenId = _depositMixed(alice);

        vm.prank(bob);
        vm.expectRevert("Not owner");
        vault.withdrawBundle(tokenId);
    }

    // ─── Bundle NFT is transferable (unlike ClawPass) ────────────────────────

    function test_bundleNFT_isTransferable() public {
        uint256 tokenId = _depositERC20Only(alice);

        vm.prank(alice);
        vault.transferFrom(alice, bob, tokenId);

        assertEq(vault.ownerOf(tokenId), bob);

        // Bob (new owner) can withdraw
        uint256 bobTokenABefore = tokenA.balanceOf(bob);
        vm.prank(bob);
        vault.withdrawBundle(tokenId);
        assertEq(tokenA.balanceOf(bob), bobTokenABefore + AMOUNT_A);
    }

    // ─── getBundleContent returns correct data ────────────────────────────────

    function test_getBundleContent() public {
        uint256 tokenId = _depositMixed(alice);

        (
            address[] memory t20,
            uint256[] memory a20,
            address[] memory t721,
            uint256[] memory ids
        ) = vault.getBundleContent(tokenId);

        assertEq(t20.length,  2);
        assertEq(a20.length,  2);
        assertEq(t721.length, 2);
        assertEq(ids.length,  2);

        assertEq(t20[0], address(tokenA));
        assertEq(t20[1], address(tokenB));
        assertEq(a20[0], AMOUNT_A);
        assertEq(a20[1], AMOUNT_B);
        assertEq(t721[0], address(nftA));
        assertEq(t721[1], address(nftB));
        assertEq(ids[0],  NFT_ID_1);
        assertEq(ids[1],  NFT_ID_1);
    }

    // ─── Multiple deposits get independent token IDs ──────────────────────────

    function test_multipleDeposits_independentTokenIds() public {
        uint256 id0 = _depositERC20Only(alice);

        vm.prank(alice);
        tokenA.approve(address(vault), AMOUNT_A);
        vm.prank(alice);
        tokenB.approve(address(vault), AMOUNT_B);

        address[] memory t20 = _arr(address(tokenA), address(tokenB));
        uint256[] memory a20 = _amounts(AMOUNT_A, AMOUNT_B);
        vm.prank(alice);
        uint256 id1 = vault.depositBundle(t20, a20, new address[](0), new uint256[](0), "");

        assertEq(id0, 0);
        assertEq(id1, 1);
        assertEq(vault.ownerOf(id0), alice);
        assertEq(vault.ownerOf(id1), alice);
    }

    // ─── withdrawBundle clears content ───────────────────────────────────────

    function test_withdrawBundle_clearsContent() public {
        uint256 tokenId = _depositMixed(alice);

        vm.prank(alice);
        vault.withdrawBundle(tokenId);

        // bundleContents mapping is deleted — getBundleContent returns empty arrays
        (
            address[] memory t20,
            uint256[] memory a20,
            address[] memory t721,
            uint256[] memory ids
        ) = vault.getBundleContent(tokenId);

        assertEq(t20.length,  0);
        assertEq(a20.length,  0);
        assertEq(t721.length, 0);
        assertEq(ids.length,  0);
    }

    // ─── Helpers ─────────────────────────────────────────────────────────────

    /// @dev Deposit two ERC20s + two ERC721s for `who`
    function _depositMixed(address who) internal returns (uint256 tokenId) {
        address[] memory t20  = _arr(address(tokenA), address(tokenB));
        uint256[] memory a20  = _amounts(AMOUNT_A, AMOUNT_B);
        address[] memory t721 = _arr(address(nftA),   address(nftB));
        uint256[] memory ids  = _amounts(NFT_ID_1,     NFT_ID_1);

        vm.prank(who);
        tokenA.approve(address(vault), AMOUNT_A);
        vm.prank(who);
        tokenB.approve(address(vault), AMOUNT_B);
        vm.prank(who);
        nftA.approve(address(vault), NFT_ID_1);
        vm.prank(who);
        nftB.approve(address(vault), NFT_ID_1);

        vm.prank(who);
        tokenId = vault.depositBundle(t20, a20, t721, ids, "ipfs://mixed");
    }

    /// @dev Deposit two ERC20s only for `who`
    function _depositERC20Only(address who) internal returns (uint256 tokenId) {
        address[] memory t20 = _arr(address(tokenA), address(tokenB));
        uint256[] memory a20 = _amounts(AMOUNT_A, AMOUNT_B);

        vm.prank(who);
        tokenA.approve(address(vault), AMOUNT_A);
        vm.prank(who);
        tokenB.approve(address(vault), AMOUNT_B);

        vm.prank(who);
        tokenId = vault.depositBundle(t20, a20, new address[](0), new uint256[](0), "ipfs://erc20only");
    }

    function _approveERC20(address who, uint256 amtA, uint256 amtB) internal {
        vm.prank(who);
        tokenA.approve(address(vault), amtA);
        vm.prank(who);
        tokenB.approve(address(vault), amtB);
    }

    // ── Array helpers ─────────────────────────────────────────────────────────

    function _arr(address a) internal pure returns (address[] memory r) {
        r = new address[](1);
        r[0] = a;
    }

    function _arr(address a, address b) internal pure returns (address[] memory r) {
        r = new address[](2);
        r[0] = a;
        r[1] = b;
    }

    function _amounts(uint256 a) internal pure returns (uint256[] memory r) {
        r = new uint256[](1);
        r[0] = a;
    }

    function _amounts(uint256 a, uint256 b) internal pure returns (uint256[] memory r) {
        r = new uint256[](2);
        r[0] = a;
        r[1] = b;
    }
}
