# ClawStreet — Deployment & Setup Guide

**Network:** Base Sepolia (Chain ID 84532)
**Framework:** Foundry
**Last updated:** April 2026

This guide covers everything a developer needs to fork ClawStreet, spin up agent wallets, deploy all contracts to Base Sepolia in one command, and fund all test wallets automatically.

---

## Table of Contents

1. [Prerequisites](#1-prerequisites)
2. [Environment Setup](#2-environment-setup)
3. [Agent Wallet Setup](#3-agent-wallet-setup)
4. [One-Command Bootstrap](#4-one-command-bootstrap)
5. [Step-by-Step Alternative](#5-step-by-step-alternative)
6. [What Gets Deployed](#6-what-gets-deployed)
7. [Post-Deploy Configuration](#7-post-deploy-configuration)
8. [Refunding Agents](#8-refunding-agents)
9. [Script Reference](#9-script-reference)
10. [Costs & Faucets](#10-costs--faucets)
11. [Troubleshooting](#11-troubleshooting)

---

## 1. Prerequisites

### Tools

| Tool | Install |
|------|---------|
| Foundry (forge + cast) | `curl -L https://foundry.paradigm.xyz \| bash && foundryup` |
| Git | System package manager |
| Node.js + npm | nodejs.org |
| Bash (WSL on Windows) | WSL2 recommended on Windows |

### Accounts needed (all free)

| Service | Purpose | URL |
|---------|---------|-----|
| Alchemy | RPC endpoint | alchemy.com |
| Basescan | Contract verification | basescan.org |
| Coinbase Wallet | Base Sepolia ETH faucet | coinbase.com/faucets |

---

## 2. Environment Setup

### Clone and install

```bash
git clone <your-repo>
cd ClawStreet
forge install
npm install --legacy-peer-deps
```

### Create your `.env`

```bash
cp .env.example .env
```

Fill in these values in `.env`:

```bash
# ── Required for deployment ────────────────────────────────────────────────────
DEPLOYER_PRIVATE_KEY=0xYOUR_PRIVATE_KEY

# ── Alchemy RPC (get free key at alchemy.com) ─────────────────────────────────
BASE_SEPOLIA_RPC=https://base-sepolia.g.alchemy.com/v2/YOUR_ALCHEMY_KEY

# ── Basescan verification (get free key at basescan.org/myapikey) ─────────────
BASESCAN_API_KEY=MFTZ13CZ4W6ZD6N621JQPCD3H1ZIA2XYWF

# ── Pyth Oracle (already filled — no account needed) ─────────────────────────
PYTH_ADDRESS=0xA2aa501b19aff244D90cc15a4Cf739D2725B5729
PYTH_ETH_USD_FEED_ID=0xff61491a931112ddf1bd8147cd1b641375f79f5825126d665480874634fd0ace
```

> The following are auto-filled by the bootstrap script — leave them blank for now:
> `USDC_ADDRESS`, `CLAW_TOKEN_ADDRESS`, `STAKING_ADDRESS`, `LOAN_ENGINE_ADDRESS`,
> `CALL_VAULT_ADDRESS`, `BUNDLE_VAULT_ADDRESS`, `MOCK_NFT_ADDRESS`, `MOCK_USDC_ADDRESS`,
> `AGENT1_ADDRESS` through `AGENT5_ADDRESS`

> **TestTokens** (tWETH, tWBTC, tLINK) are deployed separately — see Step 0 below.
> Add these after deploying:
> ```bash
> TEST_WETH_ADDRESS=0x<deployed>
> TEST_WBTC_ADDRESS=0x<deployed>
> TEST_LINK_ADDRESS=0x<deployed>
> # Browser-side (Vite) — needed for faucet UI
> VITE_BASE_SEPOLIA_RPC=https://base-sepolia.g.alchemy.com/v2/YOUR_KEY
> ```

---

## 3. Agent Wallet Setup

ClawStreet uses 5 agent wallets to simulate different market participants:

| Agent | Role | What it does |
|-------|------|-------------|
| **Agent1** LiquidityAgent_Alpha | Market Maker | Provides liquidity on both sides |
| **Agent2** ArbitrageAgent_Beta | Arbitrageur | Exploits price differences |
| **Agent3** LendingAgent_Gamma | Lender | Funds loan offers (needs most USDC) |
| **Agent4** BorrowerAgent_Delta | Borrower | Escrows NFTs, takes loans |
| **Agent5** HedgeAgent_Epsilon | Options Writer | Writes covered calls |

### Generate wallets (idempotent — safe to run multiple times)

```bash
bash scripts/setup-agent-wallets.sh
```

This script:
- Checks if `.env.agents` already exists — **skips generation** if all 5 wallets are present
- Generates 5 wallets using `cast wallet new`
- Saves private keys + addresses to `.env.agents` (gitignored)
- **Auto-injects** `AGENT1_ADDRESS` through `AGENT5_ADDRESS` into `.env`

> **Security:** `.env.agents` contains private keys. It is in `.gitignore`. Never commit it.
> Use `--force` to regenerate (destroys old keys):
> ```bash
> bash scripts/setup-agent-wallets.sh --force
> ```

---

## 4. One-Command Bootstrap

After filling `.env` and funding your deployer wallet (see [Costs & Faucets](#10-costs--faucets)):

```bash
bash scripts/bootstrap.sh
```

This runs 6 steps automatically:

```
[STEP 1/6] Validate environment
           Checks all required .env vars, tools, and deployer address.

[STEP 2/6] Create agent wallets
           Runs setup-agent-wallets.sh (idempotent — skips if already done).

[STEP 3/6] Check deployer ETH balance
           Warns if balance < 0.3 ETH.

[STEP 4/6] Disperse ETH to agent wallets
           Sends 0.05 ETH from deployer to each of the 5 agents.

[STEP 5/6] Deploy all contracts + disperse tokens
           Runs DeployAll.s.sol (12 sub-steps — see below).
           Auto-saves deployed addresses back to .env.

[STEP 6/6] Print full summary
           Prints all contract addresses and next steps.
```

### Options

```bash
bash scripts/bootstrap.sh --skip-eth    # skip ETH dispersal (already done)
bash scripts/bootstrap.sh --dry-run     # simulate without broadcasting
```

### Output

Bootstrap writes a timestamped log to `logs/bootstrap-YYYYMMDD_HHMMSS.log`.

---

## 5. Step-by-Step Alternative

If you prefer manual control:

```bash
# Step A: Generate agent wallets (only if .env.agents doesn't exist)
bash scripts/setup-agent-wallets.sh

# Step B: Send ETH to agent wallets from deployer
forge script script/DisperseETH.s.sol \
  --rpc-url base_sepolia \
  --broadcast \
  -vvvv

# Step C: Deploy all contracts + fund agents with USDC + STREET + NFTs
forge script script/DeployAll.s.sol \
  --rpc-url base_sepolia \
  --broadcast \
  --verify \
  -vvvv

# Step D (optional): Top up MockUSDC balances later
forge script script/DisperseUSDC.s.sol \
  --rpc-url base_sepolia \
  --broadcast \
  -vvvv
```

---

## 6. What Gets Deployed

`DeployAll.s.sol` deploys 12 sub-steps in one broadcast:

| Step | Contract | Type | Note |
|------|----------|------|------|
| 1 | **MockUSDC** | ERC-20, 6 decimals | Mintable unlimited, owned by deployer |
| 2 | **ClawStreetTestNFT** | ERC-721 | Borrower collateral for loans |
| 3 | **ClawToken** ($STREET) | ERC-20, 18 decimals | 100M max cap |
| 4 | **ClawStreetStaking** | ERC-721 + revenue share | Non-upgradeable |
| 5 | **ClawStreetBundleVault** | UUPS proxy | Asset bundling |
| 6 | **ClawStreetLoan** | UUPS proxy | NFT-collateralised loans + Pyth |
| 7 | **ClawStreetCallVault** | UUPS proxy | Covered call options |
| 8 | Wire: Loan → Staking | Config tx | Sets fee routing |
| 9 | Mint 50M STREET to deployer | Config tx | Treasury allocation |
| 10 | Disperse MockUSDC to all agents | Batch mint | Uses `disperseEqual` |
| 11 | Mint 5 test NFTs to Agent4 | Mint tx | Borrower collateral |
| 12 | Disperse STREET to staker agents | Mint txs | Agent1, 2, 5 |

### Token amounts disbursed

| Recipient | ETH | MockUSDC | STREET |
|-----------|-----|----------|------|
| Deployer | (yours) | 10,000,000 | 50,000,000 |
| Agent1 Alpha | 0.05 | 1,000 | 100,000 |
| Agent2 Beta | 0.05 | 500 | 50,000 |
| Agent3 Gamma | 0.05 | 2,000 | — |
| Agent4 Delta | 0.05 | 500 | — (gets 5 NFTs) |
| Agent5 Epsilon | 0.05 | 1,000 | 50,000 |

---

## 7. Live Deployed Addresses (Base Sepolia)

> Last deployed: 2026-04-12. ClawToken + Staking redeployed 2026-04-16 for $STREET symbol.

| Contract | Address | Basescan |
|----------|---------|---------|
| MockUSDC | `0xDCf9936b330D6957CaD463f850D1F2B6F1eABc3A` | [View ↗](https://sepolia.basescan.org/address/0xDCf9936b330D6957CaD463f850D1F2B6F1eABc3A) |
| MockNFT | `0x41119aAd1c69dba3934D0A061d312A52B06B27DF` | [View ↗](https://sepolia.basescan.org/address/0x41119aAd1c69dba3934D0A061d312A52B06B27DF) |
| ClawToken ($STREET) | `0xD11fC366828445B874F5202109E5f48C4D14FCe4` | [View ↗](https://sepolia.basescan.org/address/0xD11fC366828445B874F5202109E5f48C4D14FCe4) |
| ClawStreetStaking | `0xADBf89BA38915B9CF18E0a24Ea3E27F39d920bd3` | [View ↗](https://sepolia.basescan.org/address/0xADBf89BA38915B9CF18E0a24Ea3E27F39d920bd3) |
| ClawStreetBundleVault | `0x86ef420fD3e27c3Ac896c479B19b6A840b97Bee1` | [View ↗](https://sepolia.basescan.org/address/0x86ef420fD3e27c3Ac896c479B19b6A840b97Bee1) |
| ClawStreetLoan | `0x96C3291C9b0C34b007893326ee9dcA534BfcFa0c` | [View ↗](https://sepolia.basescan.org/address/0x96C3291C9b0C34b007893326ee9dcA534BfcFa0c) |
| ClawStreetCallVault | `0x69730728a0B19b844bc18888d2317987Bc528baE` | [View ↗](https://sepolia.basescan.org/address/0x69730728a0B19b844bc18888d2317987Bc528baE) |
| TestWETH (tWETH) | `0xE93695aE429a2C156F216Bc615E9Dd8d1A9794dE` | [View ↗](https://sepolia.basescan.org/address/0xE93695aE429a2C156F216Bc615E9Dd8d1A9794dE) |
| TestWBTC (tWBTC) | `0xCd1CA9D5612B0Eaefa6388129366226d9715161A` | [View ↗](https://sepolia.basescan.org/address/0xCd1CA9D5612B0Eaefa6388129366226d9715161A) |
| TestLINK (tLINK) | `0xD14135bcdFE39097122830E1F989cc6e11074B96` | [View ↗](https://sepolia.basescan.org/address/0xD14135bcdFE39097122830E1F989cc6e11074B96) |

**Agent wallets (seeded 2026-04-17):**

| Agent | Address | Role | Active Deals |
|-------|---------|------|-------------|
| LiquidityAgent_Alpha | `0xD1E84c88734013613230678B8E000dE53e4957dC` | Market Maker | Staked 10,000 STREET (ClawPass #1) |
| ArbitrageAgent_Beta | `0xBaf9d5E05d82bEA9B971B54AD148904ae25876b2` | Arbitrageur | Bought Option #1 (50 USDC premium) |
| LendingAgent_Gamma | `0x37D57004FdeBd029d9fcB1Cc88e275fEafA89353` | Lender | Funded Loan #0 (500 USDC, active) |
| BorrowerAgent_Delta | `0x5159345B9944Ab14D05c18853923070D3EBF60ad` | Borrower | Loans #0,1,2 borrower (3 NFTs escrowed) |
| HedgeAgent_Epsilon | `0x4EED792404bbC7bC98648EbE653E38995B8e3DfB` | Options Writer | Wrote Options #0,1,2 |

**Live protocol state (Base Sepolia):**
- **Loans:** 3 (Loan #0 active+funded, Loans #1+2 open listings)
- **Options:** 3 (Option #1 sold to Beta, Options #0+2 open listings)
- **Staking:** Alpha staked 10,000 STREET, holds ClawPass NFT #1

---

## 8. Post-Deploy Configuration

After bootstrap, copy the printed addresses into two files:

### `src/config/contracts.ts`

```ts
export const CONTRACT_ADDRESSES = {
  CLAW_TOKEN:   '0x...',  // from deploy output
  STAKING:      '0x...',
  LOAN_ENGINE:  '0x...',
  CALL_VAULT:   '0x...',
  BUNDLE_VAULT: '0x...',
};
```

### `config/base-sepolia.json` → `deployedContracts`

```json
{
  "deployedContracts": {
    "ClawToken":            "0x...",
    "ClawStreetStaking":    "0x...",
    "ClawStreetLoan":       "0x...",
    "ClawStreetCallVault":  "0x...",
    "ClawStreetBundleVault":"0x...",
    "MockUSDC":             "0x...",
    "MockNFT":              "0x..."
  }
}
```

Then start the dev server:

```bash
npm run dev
# → http://localhost:3000
```

The admin dashboard will show live on-chain data.

---

## 8. Refunding Agents

After running test scenarios, agents may have spent their USDC. Top them up:

```bash
# Default: re-mints standard amounts (1000/500/2000/500/1000 USDC)
forge script script/DisperseUSDC.s.sol --rpc-url base_sepolia --broadcast

# Custom amounts via .env overrides:
TOPUP_AGENT3=5000 forge script script/DisperseUSDC.s.sol --rpc-url base_sepolia --broadcast
```

For ETH top-up, run DisperseETH again (it sends to whatever the agents' current balances are):

```bash
forge script script/DisperseETH.s.sol --rpc-url base_sepolia --broadcast
```

---

## 9. Seed Protocol with Live Data

After deployment, the UI reads on-chain state. Use the seed script to populate it:

```bash
# Seed all (loans + options + staking)
npm run seed

# Seed only loans
npm run seed -- --only loans

# Seed only options
npm run seed -- --only options

# Seed only staking
npm run seed -- --only staking

# Dry run — prints plan without executing
npm run seed:check
```

The seed script is **idempotent** — safe to re-run. It detects which steps were already completed and skips them.

### What the seed creates

| Step | Agent | Action | Result |
|------|-------|--------|--------|
| 1 | Delta | `setApprovalForAll(LoanEngine, true)` | Operator approval for all NFTs |
| 2 | Delta | `createLoanOffer(NFT#1, 500 USDC, 14d)` | Loan #0 created |
| 3 | Gamma | `acceptLoan(0, pythVAA)` | Loan #0 funded and active |
| 4 | Delta | `createLoanOffer(NFT#2, 300 USDC, 30d)` | Loan #1 open listing |
| 5 | Delta | `createLoanOffer(NFT#3, 750 USDC, 21d)` | Loan #2 open listing |
| 6 | Epsilon | `writeCoveredCall(STREET, 1e18, $2000, 7d, $50)` | Option #0 written |
| 7 | Beta | `buyOption(0)` | Option #0 sold |
| 8 | Epsilon | `writeCoveredCall(STREET, 0.5e18, $1500, 14d, $25)` | Option #1 open |
| 9 | Alpha | `stake(10000 STREET)` | ClawPass #1 minted |

### ETH budget

Base Sepolia faucet limit: **0.5 ETH/day**. The seed script spends ~0.0005 ETH total in gas. Agents were funded with 0.008 ETH each (0.040 ETH total) which covers hundreds of seed runs.

### Pyth fee

`acceptLoan` requires a Pyth price update. The script automatically queries `getUpdateFee()` from the Pyth oracle and sends the exact required amount (currently 10 wei on Base Sepolia).

---

## 10. Script Reference

### Shell scripts (`scripts/`)

| Script | Description |
|--------|-------------|
| `bootstrap.sh` | **Main entry point.** Full setup in one command. |
| `setup-agent-wallets.sh` | Generate agent wallets (idempotent). |
| `run-tests.sh` | Run full test suite (unit + fuzz + invariant). |

### Forge scripts (`script/`)

| Script | Description |
|--------|-------------|
| `DeployAll.s.sol` | Deploy all 7 contracts + wire + fund agents. |
| `DeployMockUSDC.s.sol` | Deploy MockUSDC only + fund agents. |
| `DeployMockNFT.s.sol` | Deploy test NFT contract only. |
| `DeployClawStreet.s.sol` | Deploy protocol contracts only (no MockUSDC). |
| `DisperseETH.s.sol` | Send ETH from deployer to all 5 agents. |
| `DisperseUSDC.s.sol` | Top-up MockUSDC balances for all agents. |

### Contracts (`contracts/`)

| Contract | Description |
|----------|-------------|
| `MockUSDC.sol` | Mintable ERC-20 (6 dec). Has `disperseEqual` + `disperseCustom`. |
| `ClawToken.sol` | $STREET ERC-20, 100M cap, ownable mint. |
| `ClawStreetStaking.sol` | Stake STREET → ClawPass NFT + USDC revenue share. |
| `ClawStreetLoan.sol` | NFT-collateralised loans with Pyth oracle. |
| `ClawStreetCallVault.sol` | Covered call options on ERC-20s. |
| `ClawStreetBundleVault.sol` | Bundle ERC-20s + ERC-721s into one NFT. |

### Test files (`test/`)

| File | Tests | Type |
|------|-------|------|
| `ClawToken.t.sol` | 39 | Unit + fuzz |
| `ClawStreetStaking.t.sol` | 53 | Unit + fuzz |
| `ClawStreetStaking.edge.t.sol` | 8 | Edge + fuzz |
| `ClawStreetLoan.t.sol` | 78 | Unit + fuzz |
| `ClawStreetLoan.edge.t.sol` | 12 | Edge + integration + fuzz |
| `ClawStreetCallVault.t.sol` | 59 | Unit |
| `ClawStreetCallVault.edge.t.sol` | 9 | Edge + fuzz |
| `ClawStreetBundleVault.t.sol` | 13 | Unit |
| `ClawStreetBundleVaultLoan.t.sol` | 6 | Integration: BundleVault → LoanEngine |
| `test/invariants/StakingInvariant.t.sol` | 7 | Stateful invariant |
| `test/invariants/CallVaultInvariant.t.sol` | 6 | Stateful invariant |
| **Total** | **290** | |

---

## 10. Costs & Faucets

### All costs are zero on Base Sepolia

| What | Amount needed | Where to get it |
|------|--------------|----------------|
| **Deployer ETH** | 0.05 ETH for contracts | Coinbase faucet (0.1 ETH/day) |
| **Agent ETH** (×5) | 0.05 ETH each = 0.25 ETH | Same faucet |
| **Total ETH needed** | **0.3 ETH** | 3 faucet requests |
| **MockUSDC** | Unlimited | Minted by `MockUSDC.sol` (no faucet needed) |
| **Basescan API** | Free | basescan.org/myapikey |
| **Alchemy RPC** | Free tier | alchemy.com |
| **Pyth oracle** | Free, no account | pyth.network |

### Faucet links

- **ETH:** https://www.coinbase.com/faucets/base-ethereum-goerli-faucet
- **Basescan:** https://basescan.org/myapikey
- **Alchemy:** https://www.alchemy.com/

---

## 11. Troubleshooting

### `cast not found`
```bash
curl -L https://foundry.paradigm.xyz | bash
foundryup
source ~/.bashrc   # or restart terminal
```

### `ERESOLVE` on `npm install`
```bash
npm install --legacy-peer-deps
```
The rainbowkit peer dep requires wagmi@2 but the project uses wagmi@3. The `--legacy-peer-deps` flag resolves this safely.

### `tsx not recognized` on `npm run dev`
```bash
npm install --legacy-peer-deps   # installs tsx into node_modules/.bin
npm run dev
```

### Deploy fails: `insufficient funds`
Fund your deployer via the Coinbase faucet. Needs at least 0.35 ETH total.

### Verification fails
Check `BASESCAN_API_KEY` is set in `.env`. The key in this repo:
```
BASESCAN_API_KEY=MFTZ13CZ4W6ZD6N621JQPCD3H1ZIA2XYWF
```
Re-verify a specific contract manually:
```bash
forge verify-contract <ADDRESS> contracts/ClawToken.sol:ClawToken \
  --chain-id 84532 \
  --etherscan-api-key $BASESCAN_API_KEY
```

### Agent addresses not injected into `.env`
Run setup manually:
```bash
bash scripts/setup-agent-wallets.sh
```
Or add them manually from `.env.agents`:
```bash
cat .env.agents   # read addresses
# then add to .env:
AGENT1_ADDRESS=0x...
```

### `react-is` missing (server crash)
```bash
npm install react-is --legacy-peer-deps
npm run dev
```
