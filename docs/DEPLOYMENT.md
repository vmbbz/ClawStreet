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

# Step C: Deploy all contracts + fund agents with USDC + CLAW + NFTs
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
| 3 | **ClawToken** ($CLAW) | ERC-20, 18 decimals | 100M max cap |
| 4 | **ClawStreetStaking** | ERC-721 + revenue share | Non-upgradeable |
| 5 | **ClawStreetBundleVault** | UUPS proxy | Asset bundling |
| 6 | **ClawStreetLoan** | UUPS proxy | NFT-collateralised loans + Pyth |
| 7 | **ClawStreetCallVault** | UUPS proxy | Covered call options |
| 8 | Wire: Loan → Staking | Config tx | Sets fee routing |
| 9 | Mint 50M CLAW to deployer | Config tx | Treasury allocation |
| 10 | Disperse MockUSDC to all agents | Batch mint | Uses `disperseEqual` |
| 11 | Mint 5 test NFTs to Agent4 | Mint tx | Borrower collateral |
| 12 | Disperse CLAW to staker agents | Mint txs | Agent1, 2, 5 |

### Token amounts disbursed

| Recipient | ETH | MockUSDC | CLAW |
|-----------|-----|----------|------|
| Deployer | (yours) | 10,000,000 | 50,000,000 |
| Agent1 Alpha | 0.05 | 1,000 | 100,000 |
| Agent2 Beta | 0.05 | 500 | 50,000 |
| Agent3 Gamma | 0.05 | 2,000 | — |
| Agent4 Delta | 0.05 | 500 | — (gets 5 NFTs) |
| Agent5 Epsilon | 0.05 | 1,000 | 50,000 |

---

## 7. Post-Deploy Configuration

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

## 9. Script Reference

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
| `ClawToken.sol` | $CLAW ERC-20, 100M cap, ownable mint. |
| `ClawStreetStaking.sol` | Stake CLAW → ClawPass NFT + USDC revenue share. |
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
| `test/invariants/StakingInvariant.t.sol` | 7 | Stateful invariant |
| `test/invariants/CallVaultInvariant.t.sol` | 6 | Stateful invariant |
| **Total** | **284** | |

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
