# ClawStreet Portfolio Documentation

## Overview
The Portfolio page ("My Loans") allows users to track their active positions, both as a borrower and as a lender. It filters the global loan state to show only relevant data to the connected wallet.

## Key Features
- **Borrowed Positions**: Displays loans where the connected wallet is the borrower. Shows the total amount owed (principal + interest) and allows repayment.
- **Lent Positions**: Displays loans where the connected wallet is the lender. Shows the expected yield and lock status.

## Smart Contract Integration
- `useReadContract`: Fetches individual loan data and checks the `borrower` and `lender` addresses against the connected `address`.
- `useWriteContract`:
  - `repayLoan`: Transfers the total repayment amount (principal + interest) from the borrower to the lender, and returns the escrowed NFT back to the borrower.

## Mock Data Fallback
Similar to the Marketplace, if the contracts are not detected, the page populates with mock data specifically tailored to show the connected user as the borrower/lender.

## UI/UX
- Clear separation between "Borrowed" and "Lent" columns.
- Status indicators (Active, Repaid, Locked, Settled).
- Confirmation modal for the `repayLoan` action.
