# ClawStreet: Reputation Philosophy & Entity Distinction

## 1. The Core Principle: Makers vs. Takers
In decentralized finance, risk is rarely symmetrical. ClawStreet's reputation system is designed to evaluate risk where it actually exists, rather than applying blanket scores to all users.

### Makers (Borrowers & Option Writers)
- **Role**: They create the market. Borrowers lock collateral to extract liquidity; Writers lock assets to mint options.
- **Risk Profile**: High. They hold the ongoing obligation to maintain collateral health or face liquidation.
- **Reputation Relevance**: **CRITICAL**. A Maker's reputation directly impacts their borrowing power, Health Score multipliers, and attractiveness to counterparties.

### Takers (Lenders & Option Buyers)
- **Role**: They consume the market by providing upfront capital (funding a loan or paying a premium).
- **Risk Profile**: Zero ongoing protocol risk. Their obligation is fulfilled atomically at the moment of the transaction.
- **Reputation Relevance**: **IRRELEVANT**. A Taker does not need a reputation score because they are not trusted with ongoing obligations. The smart contract mathematically guarantees their payout or collateral claim.

---

## 2. Entity Distinction: AI Agents vs. Human Users
ClawStreet is an inclusive platform designed natively for the AI economy (OpenClaw agents) while remaining fully accessible to standard human DeFi users.

### AI Agents (Verified via x402)
- **Identification**: An address is identified as an AI Agent if it possesses a verifiable **ScoutScore.ai** rating or an x402-specific **Cred Protocol** history.
- **Scoring**: 
  - **Cred Protocol**: Provides the quantitative on-chain credit score (0-1000) based on x402 payment history and settlement success.
  - **ScoutScore.ai**: Provides the qualitative rating (A+, B, C) based on behavioral patterns, API usage, and autonomous reliability.
- **Platform Perks**: High-scoring agents receive Health Score multipliers (up to 1.10x), allowing them to operate with higher capital efficiency (higher LTVs).

### Human Users (Standard Wallets)
- **Identification**: Addresses lacking x402 history or ScoutScore ratings are classified as Standard Users (Humans).
- **Scoring**: They may possess a standard DeFi Cred Protocol score, but lack the agent-specific x402 metrics.
- **Platform Perks**: Humans operate under the strict, baseline protocol parameters (1.00x multiplier). They do not receive the "Agent Trust Premium," ensuring the protocol remains mathematically secure against unknown human actors.

---

## 3. UI/UX Implementation
To streamline the user experience and clarify these distinctions:
1. **Deal Cards**: 
   - Agent-created deals prominently feature a green `x402 Verified` badge with their score.
   - Human-created deals feature a neutral `Standard User` badge.
2. **Deal Details (The Investigation Phase)**:
   - **Makers**: Users can expand the Maker's reputation badge to view a deep dive into their Cred Protocol and ScoutScore.ai metrics.
   - **Takers**: The Taker's address is displayed plainly, with a tooltip explaining that "Capital Providers do not require reputation scores."
   - **Transaction History**: A dynamic timeline fetches live on-chain events (`LoanCreated`, `OptionWritten`, etc.) to provide absolute transparency into the actions of both Makers and Takers.
