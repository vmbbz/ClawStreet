# Deal Visualization & Analytics

ClawStreet provides professional-grade visualization and analytics for all financial instruments (Loans and Options) traded on the platform. This ensures transparency, risk management, and a premium user experience for both retail and institutional actors.

## Loan Details Page (`/loan/:id`)

The Loan Details page offers a comprehensive view of an individual OTC NFT-collateralized loan.

### Key Features:
1. **Status Tracking**: Real-time badges indicating if a loan is `Active`, `Awaiting Funder`, `Repaid`, or `Defaulted`.
2. **Counterparty Information**: Displays the addresses of both the Borrower and the Lender, highlighting if the current user is a party to the deal.
3. **Financial Terms**: Clear breakdown of Principal, Interest, Total Repayment, Duration, and Implied APR.
4. **Risk Metrics**:
   - **Health Score**: A 0-100 score based on Pyth oracle price feeds. A score below 30 indicates high liquidation risk.
   - **Est. LTV (Loan-to-Value)**: The ratio of the loan principal to the estimated value of the collateral NFT.
   - **Time Remaining**: A countdown to the loan expiry, after which the lender can claim default.
5. **Collateral Valuation Chart**: An interactive area chart (powered by `recharts`) showing the simulated historical and current estimated value of the collateral NFT against the critical **Liquidation Threshold**.
6. **Deal Timeline**: A chronological timeline tracking the lifecycle of the loan from creation to funding, and finally to settlement (repayment or default).

## Option Details Page (`/option/:id`)

The Option Details page provides deep insights into covered call contracts written in the Hedge Vault.

### Key Features:
1. **Status Tracking**: Real-time badges indicating if an option is `Available`, `Active`, `Exercised`, `Expired`, or `Cancelled`.
2. **Contract Terms**: Details the Underlying Asset, Amount Locked, Strike Price, Premium Cost, and Expiry Date.
3. **Counterparty Information**: Displays the Writer (Seller) and the Buyer.
4. **Financial Metrics**:
   - **Moneyness**: Indicates whether the option is currently "In The Money" (ITM) or "Out of the Money" (OTM) based on simulated current prices.
   - **Break-Even Price**: Calculates the exact price the underlying asset must reach for the buyer to profit (Strike Price + Premium paid per token).
   - **Time to Expiry**: Countdown to the contract's expiration date.
5. **Underlying Asset Price Chart**: An interactive area chart tracking the simulated price of the underlying asset against the **Strike Price** reference line.
6. **Contract Timeline**: A visual timeline showing when the call was written, purchased, and ultimately settled (exercised or expired).

## Navigation

All deal cards across the application (`Marketplace`, `Portfolio`, `Hedge Vault`) have been upgraded to include a **"View Details"** or **"Details"** button. This allows users to seamlessly transition from a high-level overview to deep, professional-grade analytics for any specific deal.
