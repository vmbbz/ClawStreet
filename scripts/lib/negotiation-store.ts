/**
 * negotiation-store.ts — Off-chain bargaining / counter-offer system
 *
 * Agents and humans can propose alternative deal terms before committing on-chain.
 * Offers are signed with EIP-191 personal_sign. Accepted negotiations result in
 * the original creator cancelling their on-chain deal and reposting at agreed terms.
 *
 * Storage: in-memory Map + logs/negotiations.json for persistence.
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { dirname } from 'path';
import { recoverMessageAddress } from 'viem';
import { randomUUID } from 'crypto';

// ─── Types ────────────────────────────────────────────────────────────────────

export type OfferStatus = 'pending' | 'accepted' | 'declined' | 'countered' | 'expired';

export interface NegotiationOffer {
  id: string;                 // uuid
  dealType: 'loan' | 'option';
  dealId: number;
  from: string;               // proposer address (lowercase)
  to: string;                 // deal creator address (lowercase)
  proposedTerms: {
    interestRate?: number;    // for loans — e.g. 10 = 10%
    principal?: number;       // for loans — USDC amount
    premium?: number;         // for options — USDC amount
    strike?: number;          // for options — USDC strike price
    message?: string;         // freeform note (max 280 chars)
  };
  status: OfferStatus;
  parentOfferId?: string;     // id of the offer this counters
  createdAt: number;          // unix seconds
  updatedAt: number;          // unix seconds
}

// ─── Constants ────────────────────────────────────────────────────────────────

const STORE_FILE   = 'logs/negotiations.json';
const MAX_TS_DRIFT = 300;                       // 5 minutes
const OFFER_TTL_S  = 48 * 60 * 60;             // 48h — offers expire after 2 days

// ─── File helpers ─────────────────────────────────────────────────────────────

function ensureDir(file: string) {
  const dir = dirname(file);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
}

function loadStore(): Record<string, NegotiationOffer> {
  try {
    if (existsSync(STORE_FILE)) {
      return JSON.parse(readFileSync(STORE_FILE, 'utf-8'));
    }
  } catch {}
  return {};
}

function saveStore(store: Record<string, NegotiationOffer>) {
  ensureDir(STORE_FILE);
  writeFileSync(STORE_FILE, JSON.stringify(store, null, 2));
}

function pruneExpired(store: Record<string, NegotiationOffer>): Record<string, NegotiationOffer> {
  const nowS = Math.floor(Date.now() / 1000);
  const pruned: Record<string, NegotiationOffer> = {};
  for (const [id, offer] of Object.entries(store)) {
    if (nowS - offer.createdAt < OFFER_TTL_S) {
      pruned[id] = offer;
    }
  }
  return pruned;
}

// ─── Message builders ─────────────────────────────────────────────────────────

export function buildOfferMessage(params: {
  dealType: 'loan' | 'option';
  dealId: number;
  proposedTerms: NegotiationOffer['proposedTerms'];
  timestamp: number;
}): string {
  const terms = JSON.stringify(params.proposedTerms);
  return [
    'ClawStreet Negotiation Offer',
    `DealType: ${params.dealType}`,
    `DealId: ${params.dealId}`,
    `Terms: ${terms}`,
    `Timestamp: ${params.timestamp}`,
  ].join('\n');
}

export function buildRespondMessage(params: {
  offerId: string;
  response: 'accept' | 'decline' | 'counter';
  counterTerms?: NegotiationOffer['proposedTerms'];
  timestamp: number;
}): string {
  const lines = [
    'ClawStreet Negotiation Response',
    `OfferId: ${params.offerId}`,
    `Response: ${params.response}`,
    `Timestamp: ${params.timestamp}`,
  ];
  if (params.counterTerms) {
    lines.push(`CounterTerms: ${JSON.stringify(params.counterTerms)}`);
  }
  return lines.join('\n');
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Submit a new offer on an existing deal.
 */
export async function submitOffer(params: {
  from: string;
  to: string;
  dealType: 'loan' | 'option';
  dealId: number;
  proposedTerms: NegotiationOffer['proposedTerms'];
  timestamp: number;
  signature: `0x${string}`;
}): Promise<{ success: boolean; offerId?: string; error?: string }> {
  const { from, to, dealType, dealId, proposedTerms, timestamp, signature } = params;

  // Validate timestamp
  const drift = Math.abs(Math.floor(Date.now() / 1000) - timestamp);
  if (drift > MAX_TS_DRIFT) return { success: false, error: `Timestamp drift ${drift}s exceeds limit` };

  // Validate message
  if (proposedTerms.message && proposedTerms.message.length > 280) {
    return { success: false, error: 'Message must be ≤ 280 characters' };
  }

  // Verify signature
  const message = buildOfferMessage({ dealType, dealId, proposedTerms, timestamp });
  try {
    const recovered = await recoverMessageAddress({ message, signature });
    if (recovered.toLowerCase() !== from.toLowerCase()) {
      return { success: false, error: 'Signature does not match from address' };
    }
  } catch {
    return { success: false, error: 'Invalid signature' };
  }

  let store = loadStore();
  store = pruneExpired(store);

  const nowS = Math.floor(Date.now() / 1000);
  const id = randomUUID();

  store[id] = {
    id,
    dealType,
    dealId,
    from: from.toLowerCase(),
    to: to.toLowerCase(),
    proposedTerms,
    status: 'pending',
    createdAt: nowS,
    updatedAt: nowS,
  };

  saveStore(store);
  return { success: true, offerId: id };
}

/**
 * Respond to an existing offer (accept / decline / counter).
 */
export async function respondToOffer(params: {
  respondingAddress: string;
  offerId: string;
  response: 'accept' | 'decline' | 'counter';
  counterTerms?: NegotiationOffer['proposedTerms'];
  timestamp: number;
  signature: `0x${string}`;
}): Promise<{ success: boolean; newOfferId?: string; error?: string }> {
  const { respondingAddress, offerId, response, counterTerms, timestamp, signature } = params;

  const drift = Math.abs(Math.floor(Date.now() / 1000) - timestamp);
  if (drift > MAX_TS_DRIFT) return { success: false, error: 'Timestamp too old' };

  // Verify signature
  const message = buildRespondMessage({ offerId, response, counterTerms, timestamp });
  try {
    const recovered = await recoverMessageAddress({ message, signature });
    if (recovered.toLowerCase() !== respondingAddress.toLowerCase()) {
      return { success: false, error: 'Signature does not match responding address' };
    }
  } catch {
    return { success: false, error: 'Invalid signature' };
  }

  let store = loadStore();
  store = pruneExpired(store);

  const offer = store[offerId];
  if (!offer) return { success: false, error: 'Offer not found' };
  if (offer.status !== 'pending') return { success: false, error: `Offer is already ${offer.status}` };

  const responder = respondingAddress.toLowerCase();
  // Only the `to` party can respond (deal creator)
  if (responder !== offer.to) {
    return { success: false, error: 'Only the deal creator can respond to this offer' };
  }

  const nowS = Math.floor(Date.now() / 1000);

  if (response === 'counter' && counterTerms) {
    // Mark original as countered, create a new pending counter-offer
    offer.status = 'countered';
    offer.updatedAt = nowS;

    const newId = randomUUID();
    store[newId] = {
      id: newId,
      dealType: offer.dealType,
      dealId: offer.dealId,
      from: offer.to,        // original `to` is now the proposer
      to: offer.from,        // original `from` is now the receiver
      proposedTerms: counterTerms,
      status: 'pending',
      parentOfferId: offerId,
      createdAt: nowS,
      updatedAt: nowS,
    };

    saveStore(store);
    return { success: true, newOfferId: newId };
  } else {
    offer.status = response === 'accept' ? 'accepted' : 'declined';
    offer.updatedAt = nowS;
    saveStore(store);
    return { success: true };
  }
}

/**
 * Get all offers for a specific deal (newest first).
 */
export function getOffersForDeal(dealType: 'loan' | 'option', dealId: number): NegotiationOffer[] {
  let store = loadStore();
  store = pruneExpired(store);
  return Object.values(store)
    .filter(o => o.dealType === dealType && o.dealId === dealId)
    .sort((a, b) => b.createdAt - a.createdAt);
}

/**
 * Get all offers involving a specific address (as proposer or receiver).
 */
export function getOffersForAddress(address: string): NegotiationOffer[] {
  const addr = address.toLowerCase();
  let store = loadStore();
  store = pruneExpired(store);
  return Object.values(store)
    .filter(o => o.from === addr || o.to === addr)
    .sort((a, b) => b.createdAt - a.createdAt);
}
