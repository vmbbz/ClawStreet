# ClawStreet: Dynamic Health Score & Agent Reputation Plan

## 1. Executive Summary
The current `getHealthScore` function in the `ClawStreetLoan` contract uses basic placeholder logic. To transition to a production-ready, institutional-grade platform, we must implement a dynamic health score that reacts to real-time market volatility, accurate NFT floor prices, and the on-chain reputation of the AI agents executing the trades. 

This document outlines the architecture and integration path for NFT Oracles, dynamic health score mathematics, and x402-based agent reputation scoring.

---

## 2. NFT Floor Price Oracles
To calculate accurate Loan-to-Value (LTV) ratios, the smart contract requires reliable, manipulation-resistant NFT floor price data.

### Recommended Services
1. **Pyth Network (Primary Recommendation)**
   - **Why**: Pyth is an industry-standard, low-latency pull oracle. ClawStreet's UI already references Pyth, making this a natural fit. Pyth offers robust NFT floor price feeds on multiple chains.
   - **Cost**: Free to read on-chain; users/agents pay a minimal gas fee to "pull" the latest price update when interacting with the contract.
2. **Chainlink NFT Floor Pricing Feeds (Alternative)**
   - **Why**: The most battle-tested oracle network in DeFi. Excellent for blue-chip NFTs (BAYC, CryptoPunks).
   - **Cost**: Free to consume on supported networks, though feed availability depends on the specific blockchain.
3. **Reservoir API (Off-chain Fallback)**
   - **Why**: Aggregates liquidity across all major NFT marketplaces. Useful for the frontend to display real-time charts before the on-chain oracle updates.

### Integration Path
- Import the `IPyth` interface into `ClawStreetLoan.sol`.
- Require borrowers/lenders to pass a `bytes[] calldata priceUpdateData` when calling critical functions (e.g., `acceptLoan`, `liquidate`).
- The contract will call `pyth.updatePriceFeeds{value: fee}(priceUpdateData)` to ensure the floor price is fresh before calculating the health score.

---

## 3. Dynamic Health Score Calculation
The health score (0-100) dictates liquidation risk. It must be sensitive to price drops and market volatility.

### Proposed Formula
`Health Score = Base Score * Volatility Discount * Reputation Multiplier`

1. **Base Score (LTV-based)**
   - `Collateral Value = NFT Floor Price (from Oracle)`
   - `LTV = Principal / Collateral Value`
   - `Base Score = MAX(0, 100 - ((LTV - Safe_LTV_Threshold) * Penalty_Factor))`
2. **Volatility Discount**
   - Compare the Oracle's Exponential Moving Average (EMA) price to the Spot price.
   - If `Spot < EMA` by a significant margin (high downside volatility), apply a discount (e.g., 0.9x) to the health score to accelerate liquidation warnings.
3. **Reputation Multiplier**
   - Agents with high x402 transaction scores receive a "trust premium" (e.g., 1.05x multiplier), allowing their loans to sustain slightly higher LTVs before liquidation.

---

## 4. Agent Reputation & x402 Integration
With the rise of the **x402 standard** (Payment Required for Agentic Commerce), AI agents are building verifiable on-chain transaction histories. We will leverage this to score agents.

### Scoring Providers
We integrate with the leading x402 credit scoring protocols:
- **Cred Protocol**: Analyzes an agent's x402 payment history, successful settlements, and default rates to generate a quantitative on-chain credit score (0-1000).
- **ScoutScore.ai**: Evaluates agent reliability and assigns qualitative ratings (e.g., A+, B, C) based on behavioral patterns and DeFi interactions.

### Integration Path
1. **On-Chain Registry**: ClawStreet will query an on-chain Reputation Oracle (or an EAS - Ethereum Attestation Service schema) that stores the agent's x402 credit score.
2. **Tiered System**:
   - **Tier 1 (Score > 800)**: 1.10x Health Score multiplier (Lower liquidation risk).
   - **Tier 2 (Score 500-800)**: 1.00x multiplier (Standard).
   - **Tier 3 (Score < 500 or Unknown)**: 0.90x multiplier (Strict liquidation parameters).

---

## 5. Execution Roadmap (Completed)

### Phase 1: Oracle Integration
- [x] Install Pyth Network Solidity SDK (`@pythnetwork/pyth-sdk-solidity`).
- [x] Update `ClawStreetLoan.sol` to accept Pyth price feed IDs for supported NFT collections.
- [x] Implement the `updatePriceFeeds` logic in state-changing functions, properly calculating and paying the Pyth update fee.

### Phase 2: Advanced Mathematics
- [x] Implement the `Base Score` and `Volatility Discount` logic in `getHealthScore`.
- [x] Write comprehensive unit tests simulating price crashes to ensure the health score drops below the liquidation threshold (e.g., 30) accurately.

### Phase 3: x402 Reputation Integration
- [x] Define an `IAgentReputation` interface.
- [x] Create a mock Reputation Oracle for testnet deployment that simulates x402 credit scores.
- [x] Integrate the `Reputation Multiplier` into the final `getHealthScore` output.

### Phase 4: Frontend & Docs
- [x] Update `LoanDetails.tsx` and `OptionDetails.tsx` to fetch and display the Agent's x402 Reputation Score, including detailed breakdowns from Cred Protocol and ScoutScore.ai.
- [x] Add subtle reputation badges to deal cards across the Marketplace, Portfolio, and Hedge Vault.
- [x] Update the Agent API documentation and Landing page to highlight the integration of Cred Protocol and ScoutScore.ai.
- [x] Implement dynamic "Transaction History" on Loan and Option details pages by querying live on-chain events (`LoanCreated`, `OptionWritten`, etc.) via `wagmi`'s `usePublicClient`, with a robust fallback to mock data if the contracts are not yet deployed.
