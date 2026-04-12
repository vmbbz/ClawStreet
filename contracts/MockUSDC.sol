// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import "@openzeppelin/contracts/access/Ownable.sol";

/**
 * @title MockUSDC
 * @notice Mintable ERC-20 with 6 decimals — drop-in USDC replacement for
 *         Base Sepolia testing. Owner (deployer) can mint unlimited tokens
 *         to any address. NOT for mainnet use.
 *
 * Deployment:
 *   forge script script/DeployMockUSDC.s.sol --rpc-url base_sepolia --broadcast --verify
 *
 * After deploy, set USDC_ADDRESS=<deployed address> in .env
 */
contract MockUSDC is ERC20, Ownable {
    uint8 private constant DECIMALS = 6;

    /// @notice Emitted when tokens are batch-dispersed to multiple recipients.
    event BatchDispersed(address indexed by, uint256 recipientCount, uint256 totalAmount);

    constructor(address initialOwner)
        ERC20("USD Coin (ClawStreet Testnet)", "USDC")
        Ownable(initialOwner)
    {}

    // ─── Decimals ─────────────────────────────────────────────────────────────

    function decimals() public pure override returns (uint8) {
        return DECIMALS;
    }

    // ─── Minting ──────────────────────────────────────────────────────────────

    /**
     * @notice Mint `amount` (in raw 6-decimal units) to `to`.
     * @dev    Use toRaw(humanAmount) helper: 1000 USDC = 1_000_000_000 (1000 * 1e6).
     */
    function mint(address to, uint256 amount) external onlyOwner {
        require(to != address(0), "MockUSDC: mint to zero address");
        _mint(to, amount);
    }

    /**
     * @notice Mint a human-readable amount (e.g. 1000 = 1000 USDC) to `to`.
     *         Automatically multiplies by 1e6.
     */
    function mintHuman(address to, uint256 humanAmount) external onlyOwner {
        require(to != address(0), "MockUSDC: mint to zero address");
        _mint(to, humanAmount * 10 ** DECIMALS);
    }

    // ─── Batch dispersal ──────────────────────────────────────────────────────

    /**
     * @notice Mint the same `amountEach` to every address in `recipients`.
     *         One call funds all agent wallets.
     * @param recipients  Array of wallet addresses to fund.
     * @param amountEach  Raw amount (6 decimals) each recipient receives.
     *                    Use amountEach = N * 1e6 for N USDC per wallet.
     */
    function disperseEqual(address[] calldata recipients, uint256 amountEach) external onlyOwner {
        require(recipients.length > 0, "MockUSDC: empty recipients");
        require(amountEach > 0,        "MockUSDC: zero amount");

        uint256 total;
        for (uint256 i; i < recipients.length; i++) {
            require(recipients[i] != address(0), "MockUSDC: zero address in list");
            _mint(recipients[i], amountEach);
            total += amountEach;
        }
        emit BatchDispersed(msg.sender, recipients.length, total);
    }

    /**
     * @notice Mint custom amounts to each recipient.
     *         `recipients` and `amounts` must be the same length.
     * @param recipients  Array of wallet addresses.
     * @param amounts     Raw amount (6 decimals) for each corresponding wallet.
     */
    function disperseCustom(
        address[] calldata recipients,
        uint256[] calldata amounts
    ) external onlyOwner {
        require(recipients.length > 0,                "MockUSDC: empty recipients");
        require(recipients.length == amounts.length,  "MockUSDC: length mismatch");

        uint256 total;
        for (uint256 i; i < recipients.length; i++) {
            require(recipients[i] != address(0), "MockUSDC: zero address in list");
            require(amounts[i] > 0,              "MockUSDC: zero amount for recipient");
            _mint(recipients[i], amounts[i]);
            total += amounts[i];
        }
        emit BatchDispersed(msg.sender, recipients.length, total);
    }

    // ─── Convenience view ─────────────────────────────────────────────────────

    /// @notice Returns `addr`'s balance formatted as a human-readable string (no decimals).
    function balanceHuman(address addr) external view returns (uint256) {
        return balanceOf(addr) / 10 ** DECIMALS;
    }
}
