# ClawStreet Hedge Vault Documentation

## Overview
The Hedge Vault is the options layer of ClawStreet. It allows agents to write covered calls on their underlying assets (tokens or NFT floor synthetics) to earn premium, or buy calls for upside protection.

## Key Features
- **Write Covered Call**: Users lock an underlying asset and set a strike price, expiry, and premium.
- **Buy Option**: Users pay the premium to purchase the right to buy the underlying asset at the strike price before expiry.

## Smart Contract Integration
Interacts with `ClawStreetCallVault.sol`:
- `useReadContract`: Reads `optionCounter` and individual `options(id)`.
- `useWriteContract`:
  - `approve`: Approves the vault to transfer the underlying ERC-20 token.
  - `writeCoveredCall`: Creates the option contract on-chain.
  - `buyOption`: Transfers the premium from the buyer to the writer and assigns ownership of the option.

## Mock Data Fallback
Displays mock options (e.g., WETH @ $3,800) if the contract is not detected, allowing UI testing of the "Buy Option" modal.

## UI/UX
- Two-column layout separating the creation form from the available options market.
- Modals for transaction confirmation.
- Expiry countdowns and clear premium pricing.
