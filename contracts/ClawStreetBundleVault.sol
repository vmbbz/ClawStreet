// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/access/AccessControlUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/token/ERC721/ERC721Upgradeable.sol";
import "@openzeppelin/contracts-upgradeable/token/ERC721/extensions/ERC721URIStorageUpgradeable.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/token/ERC721/IERC721.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

contract ClawStreetBundleVault is
    Initializable,
    UUPSUpgradeable,
    AccessControlUpgradeable,
    ERC721Upgradeable,
    ERC721URIStorageUpgradeable,
    ReentrancyGuard
{
    using SafeERC20 for IERC20;
    bytes32 public constant MINTER_ROLE = keccak256("MINTER_ROLE");

    uint256 private _nextTokenId;

    struct BundleContent {
        address[] erc20Tokens;
        uint256[] erc20Amounts;
        address[] erc721Contracts;
        uint256[] erc721Ids;
    }

    mapping(uint256 => BundleContent) internal bundleContents;

    event BundleDeposited(uint256 indexed tokenId, address indexed owner);
    event BundleWithdrawn(uint256 indexed tokenId, address indexed to);

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        _disableInitializers();
    }

    function initialize(string memory name, string memory symbol) public initializer {
        __ERC721_init(name, symbol);
        __ERC721URIStorage_init();
        __AccessControl_init();


        _grantRole(DEFAULT_ADMIN_ROLE, msg.sender);
        _grantRole(MINTER_ROLE, msg.sender);
    }

    function depositBundle(
        address[] calldata erc20Tokens,
        uint256[] calldata erc20Amounts,
        address[] calldata erc721Contracts,
        uint256[] calldata erc721Ids,
        string calldata metadataURI
    ) external nonReentrant returns (uint256) {
        require(erc20Tokens.length == erc20Amounts.length, "ERC20 length mismatch");
        require(erc721Contracts.length == erc721Ids.length, "ERC721 length mismatch");
        require(erc20Tokens.length + erc721Contracts.length > 0, "Bundle cannot be empty");

        uint256 tokenId = _nextTokenId++;

        // Transfer ERC20s
        for (uint256 i = 0; i < erc20Tokens.length; i++) {
            IERC20(erc20Tokens[i]).safeTransferFrom(msg.sender, address(this), erc20Amounts[i]);
        }

        // Transfer ERC721s (e.g. Uniswap V3 positions)
        for (uint256 i = 0; i < erc721Contracts.length; i++) {
            IERC721(erc721Contracts[i]).transferFrom(msg.sender, address(this), erc721Ids[i]);
        }

        _safeMint(msg.sender, tokenId);
        _setTokenURI(tokenId, metadataURI);

        bundleContents[tokenId] = BundleContent({
            erc20Tokens: erc20Tokens,
            erc20Amounts: erc20Amounts,
            erc721Contracts: erc721Contracts,
            erc721Ids: erc721Ids
        });

        emit BundleDeposited(tokenId, msg.sender);
        return tokenId;
    }

    function withdrawBundle(uint256 tokenId) external nonReentrant {
        require(ownerOf(tokenId) == msg.sender, "Not owner");

        BundleContent storage content = bundleContents[tokenId];

        // Return ERC20s
        for (uint256 i = 0; i < content.erc20Tokens.length; i++) {
            IERC20(content.erc20Tokens[i]).safeTransfer(msg.sender, content.erc20Amounts[i]);
        }

        // Return ERC721s
        for (uint256 i = 0; i < content.erc721Contracts.length; i++) {
            IERC721(content.erc721Contracts[i]).transferFrom(address(this), msg.sender, content.erc721Ids[i]);
        }

        _burn(tokenId);
        delete bundleContents[tokenId];

        emit BundleWithdrawn(tokenId, msg.sender);
    }

    // Required overrides
    // ── Getter for bundleContents (can't be public due to dynamic array members) ──
    function getBundleContent(uint256 tokenId) external view returns (
        address[] memory erc20Tokens,
        uint256[] memory erc20Amounts,
        address[] memory erc721Contracts,
        uint256[] memory erc721Ids
    ) {
        BundleContent storage c = bundleContents[tokenId];
        return (c.erc20Tokens, c.erc20Amounts, c.erc721Contracts, c.erc721Ids);
    }

    // ── Required OZ v5 overrides ──────────────────────────────────────────────
    function tokenURI(uint256 tokenId) public view override(ERC721Upgradeable, ERC721URIStorageUpgradeable) returns (string memory) {
        return super.tokenURI(tokenId);
    }

    function supportsInterface(bytes4 interfaceId) public view override(ERC721Upgradeable, ERC721URIStorageUpgradeable, AccessControlUpgradeable) returns (bool) {
        return super.supportsInterface(interfaceId);
    }

    // _burn is no longer virtual in OZ v5 ERC721Upgradeable — removed override.
    // ERC721URIStorageUpgradeable handles URI cleanup via _update hook internally.

    function _authorizeUpgrade(address) internal override onlyRole(DEFAULT_ADMIN_ROLE) {}
}
