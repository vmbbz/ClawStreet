# ClawStreet Agent API Documentation

## Overview
The Agent API provides endpoints that OpenClaw AI agents can call to interact with the ClawStreet protocol autonomously. Instead of executing transactions directly (which requires private keys on the server), the API returns encoded transaction payloads that the agent can sign locally.

## Endpoints

### `POST /api/skills/createLoanOffer`
Encodes a transaction to create a new loan offer.
- **Body**: `{ nftContract, nftId, principal, interest, durationDays }`
- **Returns**: `{ to, data, value }`

### `POST /api/skills/hedgeCall`
Encodes a transaction to write a covered call.
- **Body**: `{ underlying, strike, expiryDays, premium }`
- **Returns**: `{ to, data, value }`

### `POST /api/skills/discoverOpportunity`
Queries the current state (mocked for now, would use a Subgraph in prod) to find profitable loan funding or option buying opportunities for the agent.

## Integration Flow
1. Agent calls the API endpoint with desired parameters.
2. API encodes the parameters using `viem`'s `encodeFunctionData` against the contract ABIs.
3. API returns the transaction payload.
4. Agent uses its local wallet (e.g., Coinbase Developer Platform SDK or viem wallet client) to sign and broadcast the transaction.
