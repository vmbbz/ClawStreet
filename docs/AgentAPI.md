# ClawStreet Agent API Documentation

## Overview

The Agent API provides endpoints for interacting with the ClawStreet protocol — both for
AI agents and for the CTP (Continuous Test Protocol) daemon. The server encodes transaction
payloads that agents sign locally, and manages the testnet cycle lifecycle.

---

## Transaction-Encoding Endpoints

These return signed transaction calldata ready for any wallet to broadcast.

### `POST /api/skills/createLoanOffer`

Encodes a `createLoanOffer` transaction.

**Body:**
```json
{
  "nftContract": "0x<nft-address>",
  "nftId": 1,
  "principal": "400",
  "interest": "40",
  "durationDays": 14
}
```

**Returns:**
```json
{
  "success": true,
  "transaction": {
    "to": "0x<LoanEngine>",
    "data": "0x<encodedCalldata>",
    "value": "0"
  }
}
```

---

### `POST /api/skills/hedgeCall`

Encodes a `writeCoveredCall` transaction.

**Body:**
```json
{
  "underlying": "0x<token-address>",
  "amount": "1000",
  "strike": "1500",
  "expiryDays": 7,
  "premium": "50"
}
```

**Returns:**
```json
{
  "success": true,
  "transaction": {
    "to": "0x<CallVault>",
    "data": "0x<encodedCalldata>",
    "value": "0"
  }
}
```

---

### `POST /api/skills/discoverOpportunity`

Returns open loan and option opportunities (mocked for testnet; would query a Subgraph in production).

**Returns:**
```json
{
  "success": true,
  "opportunities": [
    { "type": "loan", "nftContract": "0x...", "nftId": "1", "suggestedPrincipal": "1000 USDC", "healthScore": 85 },
    { "type": "call", "underlying": "0x...", "strike": "1.5", "premium": "50 USDC" }
  ]
}
```

---

## CTP Cycle Management Endpoints

These control and observe the Continuous Test Protocol daemon.

### `GET /api/cycle/status`

Returns the current runner state from `logs/status.json`.

**Response:**
```json
{
  "state": "open_window",
  "cycleId": "2026-04-17T10:00:00.000Z",
  "scenario": "combined",
  "openDeals": [
    { "type": "loan", "id": 3, "windowEndsAt": "2026-04-17T10:30:00.000Z" },
    { "type": "option", "id": 7, "windowEndsAt": "2026-04-17T10:30:00.000Z" }
  ],
  "transactions": [...],
  "nextScheduledAt": "2026-04-17T12:00:00.000Z",
  "ethBudget": {
    "Alpha": "0.012",
    "Beta": "0.009",
    "Gamma": "0.008",
    "Delta": "0.011",
    "Epsilon": "0.010"
  }
}
```

States: `idle | planning | executing | open_window | monitoring | settling | reporting`

---

### `POST /api/cycle/trigger`

Kicks off one CTP cycle (non-blocking — returns immediately while cycle runs in background).

- Returns **HTTP 202** `{ success: true, message: "Cycle started" }` if cycle was started
- Returns **HTTP 409** `{ success: false, message: "cycle already running" }` if one is in progress

---

### `GET /api/cycle/reports`

Lists cycle report metadata (newest first, max 50).

**Response:** Array of objects:
```json
[
  {
    "filename": "cycle-2026-04-17T10-00-00.json",
    "cycleId": "2026-04-17T10:00:00.000Z",
    "scenario": "combined",
    "status": "complete",
    "durationSeconds": 347,
    "txCount": 4,
    "dealCount": 2,
    "organicParticipants": 1,
    "automatedParticipants": 1,
    "totalEthSpent": "0.000413",
    "usdcVolume": "440",
    "nextScheduledAt": "2026-04-17T12:00:00.000Z"
  }
]
```

---

### `GET /api/cycle/reports/latest`

Returns the full JSON of the most recent completed cycle report. HTTP 404 if no reports yet.

---

### `GET /api/cycle/reports/:filename`

Returns the full JSON of a specific cycle report by filename (from the `reports` list).

---

## MockUSDC Faucet Endpoint

### `POST /api/faucet/usdc`

Mints 1000 MockUSDC to the specified wallet. Alpha (the protocol owner) signs and broadcasts
the `mintHuman` transaction server-side.

**Rate limit:** 1 claim per address per hour (in-memory, resets on server restart).

**Body:**
```json
{ "address": "0x<wallet-address>" }
```

**Success (HTTP 202):**
```json
{
  "success": true,
  "txHash": "0xabc...",
  "amount": "1000",
  "to": "0x<wallet-address>"
}
```

**Rate limited (HTTP 429):**
```json
{
  "success": false,
  "error": "Rate limited — try again in 47 minutes"
}
```

**Invalid address (HTTP 400):**
```json
{
  "success": false,
  "error": "Invalid address"
}
```

This endpoint is also exposed in the UI as a banner on the Market page for connected wallets
with less than 100 MockUSDC. The banner disappears once the user has claimed.

---

## Integration Flow

**For AI agents using the transaction-encoding endpoints:**
1. Agent calls an encoding endpoint with desired parameters
2. Server encodes the call using `viem.encodeFunctionData` against the contract ABI
3. Server returns `{ to, data, value }` transaction payload
4. Agent uses its local wallet (viem `walletClient`, CDP SDK, etc.) to sign and broadcast

**For API agents joining an open CTP cycle:**
```typescript
// Poll for an open window
const status = await fetch('http://localhost:3000/api/cycle/status').then(r => r.json());
if (status.state === 'open_window' && status.openDeals.length > 0) {
  for (const deal of status.openDeals) {
    if (deal.type === 'loan') {
      // call LoanEngine.acceptLoan(deal.id, pythPriceUpdateVAA)
    } else if (deal.type === 'option') {
      // call CallVault.buyOption(deal.id)
    }
  }
}
```

Note: `acceptLoan` requires a Pyth price update VAA (pass `0x` on testnet if oracle check is bypassed).
