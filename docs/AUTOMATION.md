# ClawStreet — Continuous Test Protocol (CTP) Automation Guide

The Continuous Test Protocol (CTP) is a daemon that autonomously cycles through the
ClawStreet protocol on Base Sepolia: creating loans and options, waiting for external
participants, then auto-settling and generating JSON reports.

---

## Why Automation?

| Manual seeding | CTP daemon |
|---|---|
| Someone runs `npm run seed` once | Runs on a timer — every hour, 2 hours, etc. |
| Creates static on-chain state | Creates fresh deals every cycle |
| No open participation window | Every cycle has an open window for external agents |
| No audit trail | Full JSON report per cycle with organic vs automated counts |
| No monitoring | Watches on-chain events in real time |

---

## Architecture

```
IDLE → PLANNING → EXECUTING → OPEN_WINDOW
  ↑                                  │
  │                            MONITORING
  │                                  │
IDLE ← REPORTING ← SETTLING ← ──────┘
```

The daemon writes `logs/status.json` after every state change so the TestLab
**Automation** tab can poll it live without restarting anything.

---

## Quick Start

### One cycle (recommended first run)

```bash
npm run runner:once
```

This will:
1. Read agent wallets from `.env.agents`
2. Check ETH budgets (aborts if any agent < 0.002 ETH)
3. Create an open loan listing and/or option listing on Base Sepolia
4. Wait 5 minutes for external participants
5. Auto-settle any unfilled deals
6. Write `logs/reports/cycle-<ISO>.json` and `logs/latest.json`
7. Exit

### Continuous scheduler (production)

```bash
npm run runner:schedule    # every 1 hour, 30-min open window
```

Or configure via environment variable for the built-in server scheduler:

```bash
# .env
CYCLE_INTERVAL_SECONDS=7200       # auto-start cycle every 2h when server boots
CYCLE_OPEN_WINDOW_SECONDS=1800    # 30-min open window
```

Then `npm run dev` starts both the UI and the cycle scheduler.

### Dev mode (fast cycles for testing)

```bash
npm run runner:dev    # every 5 minutes, 60s open window
```

---

## CLI Flags

| Flag | Default | Description |
|------|---------|-------------|
| `--once` | — | Run one cycle and exit |
| `--interval N` | 7200 | Seconds between cycles |
| `--open-window N` | 1800 | Seconds to wait for external participation (30 min default for fair human access) |
| `--scenario S` | auto | Force: `loan`, `option`, `combined`, or `staking` |
| `--dry-run` | — | Print plan without executing transactions |

### Examples

```bash
# Force loan-only scenario, 10-minute open window
tsx scripts/agent-runner.ts --once --scenario loan --open-window 600

# Combined mode, every 30 minutes
tsx scripts/agent-runner.ts --interval 1800 --scenario combined

# Dry run to check what would happen
tsx scripts/agent-runner.ts --dry-run
```

---

## Scenarios

### `combined` (default)
Creates one open loan listing (Delta borrower) AND one open option listing (Epsilon writer).
Two opportunities for external participation per cycle.

### `loan`
Delta creates an NFT-collateralised loan offer. External lenders can call `acceptLoan()`.
Gamma auto-funds if unclaimed at window expiry.

### `option`
Epsilon writes a covered call on STREET tokens. External buyers can call `buyOption()`.
Beta auto-buys if unclaimed at window expiry.

### `staking`
Alpha claims pending USDC revenue from the staking contract.
Lightweight — runs when Alpha has pending revenue.

---

## Open Participation — How External Agents Join

When the daemon is in `open_window` state, real on-chain listings exist that any
wallet can interact with. The **TestLab → Automation** tab shows an open window
banner with a countdown timer and links to the deals.

**To participate as an external agent:**

1. Connect MetaMask to Base Sepolia (Chain ID 84532)
2. Get test ETH from the [Alchemy faucet](https://www.alchemy.com/faucets/base-sepolia)
3. Get MockUSDC from the Market page faucet banner (visible when balance < 100 USDC) — click **"Get 1000 Test USDC"** and confirm the transaction
4. Go to `/market` when the banner is active
5. Find deals tagged **[TEST CYCLE]** — these are the open window deals
6. Click "Fund Loan" or "Buy Option"
7. Approve USDC spending when prompted (step 1 of 2), then confirm the main action (step 2 of 2)

Your wallet address is recorded in the cycle report as `organic: true`. The daemon
detects your participation via `LoanAccepted` / `OptionBought` events and skips
auto-settling that deal.

**To participate as an API agent:**

```typescript
// Watch for open window via polling
const status = await fetch('http://localhost:3000/api/cycle/status').then(r => r.json());
if (status.state === 'open_window' && status.openDeals.length > 0) {
  for (const deal of status.openDeals) {
    if (deal.type === 'loan') {
      // call acceptLoan(deal.id, priceVAA) with your agent wallet
    } else if (deal.type === 'option') {
      // call buyOption(deal.id) with your agent wallet
    }
  }
}
```

---

## Cycle Reports

Each cycle writes a JSON report to `logs/reports/cycle-<ISO>.json`.

```json
{
  "cycleId": "2026-04-17T10:00:00.000Z",
  "scenario": "combined",
  "status": "complete",
  "durationSeconds": 347,
  "transactions": [
    {
      "hash": "0xabc...",
      "label": "Delta: createLoanOffer (NFT #3, 400 USDC, 14d)",
      "agent": "BorrowerAgent_Delta",
      "gasUsed": "95234",
      "basescanUrl": "https://sepolia.basescan.org/tx/0xabc..."
    }
  ],
  "deals": [
    {
      "type": "loan",
      "id": 3,
      "openWindowSeconds": 1800,
      "organicParticipation": false,
      "outcome": "funded-by-automation",
      "principalUsdc": "400",
      "interestUsdc": "40",
      "participants": [
        {
          "role": "borrower",
          "address": "0x5159...",
          "isAgent": true,
          "agentName": "BorrowerAgent_Delta",
          "pnlUsdc": "+400",
          "pnlNote": "received +400 USDC principal (owes 440 USDC back)"
        },
        {
          "role": "lender",
          "address": "0x37D5...",
          "isAgent": true,
          "agentName": "LendingAgent_Gamma",
          "pnlUsdc": "+40",
          "pnlNote": "estimated +40 USDC interest when loan repaid"
        }
      ]
    },
    {
      "type": "option",
      "id": 7,
      "openWindowSeconds": 1800,
      "organicParticipation": true,
      "outcome": "bought-by-external",
      "premiumUsdc": "50",
      "strikeUsdc": "1500",
      "participants": [
        {
          "role": "writer",
          "address": "0xC5C5...",
          "isAgent": true,
          "agentName": "HedgeAgent_Epsilon",
          "pnlUsdc": "+50",
          "pnlNote": "collected +50 USDC premium"
        },
        {
          "role": "buyer",
          "address": "0xBaf9...",
          "isAgent": false,
          "pnlUsdc": "-50",
          "pnlNote": "paid 50 USDC premium; profits if ETH > 1500 at expiry"
        }
      ]
    }
  ],
  "ethSpent": { "Alpha": "0", "Beta": "0.000068", "Gamma": "0.000091", "Delta": "0.000142", "Epsilon": "0.000112" },
  "totalEthSpent": "0.000413",
  "usdcVolume": "440",
  "organicParticipants": 1,
  "automatedParticipants": 1,
  "externalAddresses": ["0xbaf9d5e05d82bea9b971b54ad148904ae25876b2"],
  "nextScheduledAt": "2026-04-17T12:00:00.000Z"
}
```

### Report fields

| Field | Description |
|-------|-------------|
| `deals[].participants` | Per-role breakdown with `isAgent`, `agentName`, `pnlUsdc`, `pnlNote` |
| `deals[].principalUsdc` / `interestUsdc` | Loan financials |
| `deals[].premiumUsdc` / `strikeUsdc` | Option financials |
| `externalAddresses` | Non-agent wallets that interacted with any deal this cycle |
| `organicParticipants` | Count of deals where a non-agent participated |
| `automatedParticipants` | Count of deals auto-settled by agents |

PnL values are **estimates** — they assume loans are repaid and options reach expiry with no early exit. The `pnlNote` field gives plain-English context.

The `logs/latest.json` is always overwritten with the most recent report.

---

## API Endpoints

The dev server (`npm run dev`) exposes these endpoints:

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/api/cycle/status` | Current runner state (`logs/status.json`) |
| `POST` | `/api/cycle/trigger` | Trigger one cycle (returns 202 if started, 409 if already running) |
| `GET` | `/api/cycle/reports` | List of report metadata (newest first, max 50) |
| `GET` | `/api/cycle/reports/latest` | Full JSON of most recent report |
| `GET` | `/api/cycle/reports/:filename` | Full JSON of a specific report |
| `POST` | `/api/faucet/usdc` | Mint 1000 MockUSDC to a given address (rate-limited: 1 per address per hour) |

### Faucet endpoint

```http
POST /api/faucet/usdc
Content-Type: application/json

{ "address": "0x<your-wallet>" }
```

Returns `{ success: true, txHash: "0x...", amount: "1000", to: "0x..." }` on success.
Returns HTTP 429 with cooldown message if called within 1 hour of a previous claim.

Alpha (the protocol owner) mints on behalf of the caller — `MockUSDC.mintHuman` is `onlyOwner`.
The faucet is also exposed as a button on the Market page for connected wallets with < 100 USDC.

---

## ETH Budget Management

Each cycle checks ETH balances before executing. If any agent falls below **0.002 ETH**,
the cycle aborts with an error written to `logs/status.json`.

**Recommended minimum:** 0.008 ETH per agent (covers ~80 transactions).

**Refuel agents:**
```bash
# Get Base Sepolia ETH from faucet (0.5 ETH/day per account):
# https://www.alchemy.com/faucets/base-sepolia
# https://faucet.quicknode.com/base/sepolia
# https://faucet.circle.com/ (USDC too)

# Send to agent addresses (visible in TestLab → Overview → Agent Status)
```

The ETH budget monitor in **TestLab → Automation** shows per-agent ETH with
OK / LOW / CRITICAL status badges.

---

## OS-Level Cron (Alternative to Built-in Scheduler)

For production or CI, add a crontab entry:

```bash
# Run CTP every 2 hours
0 */2 * * * cd /path/to/ClawStreet && npm run runner:once >> logs/cron.log 2>&1

# Every hour
0 * * * * cd /path/to/ClawStreet && npm run runner:once >> logs/cron.log 2>&1
```

Or use the built-in server scheduler (simpler — no crontab needed):

```bash
# .env
CYCLE_INTERVAL_SECONDS=7200
CYCLE_OPEN_WINDOW_SECONDS=1800
```

---

## TestLab Automation Tab

The **Automation** tab (`/test-lab` → Tab ④) provides:

- **Cycle status badge** with live state (idle/planning/executing/open_window/settling/reporting)
- **Open window banner** with countdown timer and links to open deals
- **ETH budget monitor** per agent with OK/LOW/CRITICAL status
- **"Run Cycle Now"** button that calls `POST /api/cycle/trigger`
- **Recent cycle reports** list with expandable transaction details and JSON download
- **External participation guide** explaining how to join a cycle

Status auto-refreshes every 10 seconds.

---

## Troubleshooting

**"ETH too low" abort:**
Top up the flagged agent wallet using any Base Sepolia faucet.

**"Delta has no available NFT" — loan creation skipped:**
All of Delta's NFTs are locked as collateral in funded loans. The runner automatically
calls `repayOldestActiveLoan()` before each loan cycle — this repays Delta's oldest
active loan to free an NFT. If Delta lacks enough USDC to repay, the cycle falls back
to the option-only scenario. Top up Delta's USDC balance via the faucet to fix this.

**Cycle stuck in `executing`:**
A transaction may have timed out. Check `logs/status.json` for `lastError`.
Re-run `npm run runner:once` — the script is idempotent for deal creation.

**Cycle stuck in `monitoring` after restart:**
`logs/status.json` may be stale from a previous interrupted cycle. Delete the file
or reset it to `{ "state": "idle" }` — the next `runner:once` will write fresh state.

**Report shows `outcome: expired`:**
The auto-settle transaction for a deal failed (usually low gas or state mismatch).
The deal is left open on-chain. Run the seed script (`npm run seed:loans` or
`npm run seed:options`) to manually create fresh state.

**`eth_getLogs is limited to a 10,000 range` errors in the UI:**
The chain-monitor polls using `getLogs` with a bounded block range (current − 9,500).
If you see this error in the frontend (OptionDetails / Profile pages), it means a
`fromBlock: 'earliest'` was used — this is fixed in the current codebase. Pull latest.

**`eth_newFilter` / `eth_getFilterChanges` / "filter not found" errors:**
The public Base Sepolia RPC (`https://sepolia.base.org`) disables filter-based event
subscriptions. The chain-monitor uses `getLogs` polling (15s interval) instead of
`watchContractEvent` — no action needed. These errors indicate an older version.

---

*See `docs/TESTING.md` for the full test suite documentation.*
