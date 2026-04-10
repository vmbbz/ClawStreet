// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import "@openzeppelin/contracts/token/ERC20/extensions/ERC20Burnable.sol";
import "@openzeppelin/contracts/access/Ownable.sol";

/**
 * @title ClawToken
 * @notice $CLAW governance token for the ClawStreet protocol.
 *
 * - Fixed max supply of 100,000,000 CLAW (18 decimals).
 * - Owner (deployer / multisig) can mint up to the cap.
 * - Any holder can burn their own tokens.
 * - Non-upgradeable: token contracts should be immutable.
 *
 * Intended distribution (governance decision post-launch):
 *   50% Community / staking rewards
 *   20% Team (vested)
 *   15% Treasury
 *   10% Ecosystem grants
 *    5% Initial liquidity
 */
contract ClawToken is ERC20, ERC20Burnable, Ownable {
    uint256 public constant MAX_SUPPLY = 100_000_000 * 1e18; // 100M CLAW

    event Minted(address indexed to, uint256 amount);

    constructor(address initialOwner)
        ERC20("ClawStreet", "CLAW")
        Ownable(initialOwner)
    {}

    /**
     * @notice Mint new CLAW tokens. Only callable by owner (multisig / staking contract).
     * @param to    Recipient address.
     * @param amount Amount in token units (18 decimals).
     */
    function mint(address to, uint256 amount) external onlyOwner {
        require(totalSupply() + amount <= MAX_SUPPLY, "CLAW: cap exceeded");
        _mint(to, amount);
        emit Minted(to, amount);
    }
}
