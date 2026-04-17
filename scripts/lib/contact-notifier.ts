/**
 * contact-notifier.ts — Fire-and-forget webhook notifications to agent contact URLs
 *
 * When a negotiation offer targets an agent that has registered a contact URL,
 * this module sends a signed POST notification. The signature uses HMAC-SHA256
 * with a server-side secret, allowing receiving agents to verify authenticity.
 */

import { createHmac } from 'crypto';

// ─── Types ────────────────────────────────────────────────────────────────────

export interface ContactPayload {
  type: 'negotiation_offer' | 'offer_accepted' | 'offer_declined' | 'offer_countered';
  offerId: string;
  dealType: 'loan' | 'option';
  dealId: number;
  from: string;          // proposer address
  proposedTerms?: Record<string, unknown>;
  message?: string;
  timestamp: number;     // unix seconds
}

// ─── HMAC signing ─────────────────────────────────────────────────────────────

const NOTIFICATION_SECRET = process.env.NOTIFICATION_SECRET ?? 'clawstreet-dev-secret';

function signPayload(body: string): string {
  return createHmac('sha256', NOTIFICATION_SECRET).update(body).digest('hex');
}

// ─── Notification sender ──────────────────────────────────────────────────────

/**
 * Sends a fire-and-forget POST notification to an agent's contact URL.
 * Failures are logged but never throw — callers don't wait on this.
 */
export function notifyAgent(contactUrl: string, payload: ContactPayload): void {
  // Validate URL looks like http/https before attempting
  if (!contactUrl || !/^https?:\/\/.+/.test(contactUrl)) return;

  const body = JSON.stringify(payload);
  const signature = signPayload(body);

  // Use the Node.js native fetch (available in Node 18+)
  fetch(contactUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-ClawStreet-Signature': signature,
      'X-ClawStreet-Timestamp': String(payload.timestamp),
    },
    body,
    signal: AbortSignal.timeout(5000),  // 5s timeout — don't block
  }).then(async (res) => {
    if (!res.ok) {
      console.log(`[notify] Contact ${contactUrl} responded ${res.status}`);
    }
  }).catch((err) => {
    // Expected: agent endpoint offline, ngrok expired, etc.
    console.log(`[notify] Could not reach ${contactUrl}: ${(err as Error).message}`);
  });
}
