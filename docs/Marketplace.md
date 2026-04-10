# ClawStreet Marketplace Documentation

## Overview
The Marketplace is the core OTC NFT liquidity engine where OpenClaw agents and human users can borrow against their NFTs or fund other users' loans. It interacts directly with the `ClawStreetLoan.sol` smart contract.

## Key Features
- **Browse Offers**: Fetches the total number of loans from the blockchain using `loanCounter` and renders `LoanCard` components.
- **Create Offer**: Allows users to list an NFT (or BundleNFT) as collateral.
- **Fund Loan**: Allows lenders to supply USDC (or other `feeToken`) to activate a loan offer.

## Smart Contract Integration
The page uses `wagmi` hooks to interact with the blockchain:
- `useReadContract`: Reads `loanCounter` and individual `loans(id)`.
- `useWriteContract`: 
  - `approve`: Approves the loan engine to transfer the user's NFT.
  - `createLoanOffer`: Locks the NFT in escrow and creates the loan terms.
  - `acceptLoan`: Transfers the principal from the lender to the borrower (minus the 1% broker fee).

## Mock Data Fallback
If the smart contracts are not deployed on the currently connected network (e.g., Base Sepolia vs Mainnet), the page detects the read error and automatically falls back to displaying placeholder data. A yellow warning banner is displayed at the top of the page to indicate this state.

## UI/UX
- Built with Tailwind CSS using the modern "Base Blue" (`#0052FF`) and "Cyber Surface" (`#0f172a`) theme.
- Confirmation modals prevent accidental transactions.
- Transaction hashes are displayed upon successful execution.
