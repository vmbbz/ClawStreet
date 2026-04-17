/**
 * agent-registry.ts — Off-chain agent announcement registry
 *
 * External agents and humans sign an EIP-191 personal_sign message to announce
 * themselves to the ClawStreet protocol. The registry is persisted to
 * logs/agent-registry.json and survives server restarts. Entries expire after
 * 24h without a heartbeat (re-announce).
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { dirname } from 'path';
import { recoverMessageAddress } from 'viem';

// ─── Types ────────────────────────────────────────────────────────────────────

export type ParticipantType = 'agent' | 'human';

export interface AgentEntry {
  address: string;             // lowercase hex
  name: string;                // display name, max 32 chars
  contact: string;             // http URL for bargaining webhook, or ''
  role: string;                // one of VALID_ROLES
  participantType: ParticipantType;
  isInternal: boolean;         // true = dev test agents (never expires)
  signedAt: number;            // unix seconds — first announcement
  lastSeen: number;            // unix seconds — most recent announce/heartbeat
}

// ─── Constants ────────────────────────────────────────────────────────────────

const REGISTRY_FILE = 'logs/agent-registry.json';
const TTL_MS        = 24 * 60 * 60 * 1000;  // 24 hours
const MAX_TS_DRIFT  = 300;                    // 5 minutes — reject stale messages

export const VALID_ROLES = [
  'Market Maker',
  'Lender',
  'Borrower',
  'Options Writer',
  'Arbitrageur',
] as const;

// ─── File helpers ─────────────────────────────────────────────────────────────

function ensureDir(file: string) {
  const dir = dirname(file);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
}

function loadRegistry(): Record<string, AgentEntry> {
  try {
    if (existsSync(REGISTRY_FILE)) {
      return JSON.parse(readFileSync(REGISTRY_FILE, 'utf-8'));
    }
  } catch {}
  return {};
}

function saveRegistry(registry: Record<string, AgentEntry>) {
  ensureDir(REGISTRY_FILE);
  writeFileSync(REGISTRY_FILE, JSON.stringify(registry, null, 2));
}

function pruneExpired(registry: Record<string, AgentEntry>): Record<string, AgentEntry> {
  const now = Date.now();
  const pruned: Record<string, AgentEntry> = {};
  for (const [addr, entry] of Object.entries(registry)) {
    // Internal (dev) agents never expire
    if (entry.isInternal || now - entry.lastSeen * 1000 < TTL_MS) {
      pruned[addr] = entry;
    }
  }
  return pruned;
}

// ─── Message builders ─────────────────────────────────────────────────────────

/**
 * Canonical sign-in message. Must match exactly what the frontend signs.
 */
export function buildAnnounceMessage(params: {
  address: string;
  name: string;
  contact: string;
  role: string;
  participantType: ParticipantType;
  timestamp: number;
}): string {
  return [
    'ClawStreet Agent Announcement',
    `Address: ${params.address.toLowerCase()}`,
    `Name: ${params.name}`,
    `Contact: ${params.contact}`,
    `Role: ${params.role}`,
    `Type: ${params.participantType}`,
    `Timestamp: ${params.timestamp}`,
  ].join('\n');
}

/**
 * Canonical sign-out message.
 */
export function buildSignOutMessage(address: string, timestamp: number): string {
  return [
    'ClawStreet Sign-Out',
    `Address: ${address.toLowerCase()}`,
    `Timestamp: ${timestamp}`,
  ].join('\n');
}

// ─── Validation ───────────────────────────────────────────────────────────────

function validateTimestamp(timestamp: number): string | null {
  const drift = Math.abs(Math.floor(Date.now() / 1000) - timestamp);
  if (drift > MAX_TS_DRIFT) return `Timestamp drift ${drift}s exceeds ${MAX_TS_DRIFT}s limit`;
  return null;
}

function validateFields(name: string, role: string, contact: string): string | null {
  if (!name || name.length > 32) return 'Name must be 1–32 characters';
  if (!(VALID_ROLES as readonly string[]).includes(role)) {
    return `Role must be one of: ${VALID_ROLES.join(', ')}`;
  }
  if (contact && !/^https?:\/\/.+/.test(contact)) {
    return 'Contact must be an http/https URL or empty string';
  }
  return null;
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Verify signature and register/update an agent in the registry.
 */
export async function verifyAndRegister(params: {
  address: string;
  name: string;
  contact: string;
  role: string;
  participantType: ParticipantType;
  timestamp: number;
  signature: `0x${string}`;
}): Promise<{ success: boolean; error?: string }> {
  const { address, name, contact, role, participantType, timestamp, signature } = params;

  const tsError = validateTimestamp(timestamp);
  if (tsError) return { success: false, error: tsError };

  const fieldError = validateFields(name, role, contact);
  if (fieldError) return { success: false, error: fieldError };

  const message = buildAnnounceMessage({ address, name, contact, role, participantType, timestamp });

  try {
    const recovered = await recoverMessageAddress({ message, signature });
    if (recovered.toLowerCase() !== address.toLowerCase()) {
      return { success: false, error: 'Signature does not match claimed address' };
    }
  } catch {
    return { success: false, error: 'Invalid signature format' };
  }

  let registry = loadRegistry();
  registry = pruneExpired(registry);
  const key = address.toLowerCase();
  const nowS = Math.floor(Date.now() / 1000);

  registry[key] = {
    address: key,
    name,
    contact: contact || '',
    role,
    participantType,
    isInternal: false,
    signedAt: registry[key]?.signedAt ?? nowS,  // preserve original sign-in time
    lastSeen: nowS,
  };

  saveRegistry(registry);
  return { success: true };
}

/**
 * Verify signature and remove an agent from the registry.
 */
export async function verifyAndDeregister(params: {
  address: string;
  timestamp: number;
  signature: `0x${string}`;
}): Promise<{ success: boolean; error?: string }> {
  const { address, timestamp, signature } = params;

  const tsError = validateTimestamp(timestamp);
  if (tsError) return { success: false, error: tsError };

  const message = buildSignOutMessage(address, timestamp);

  try {
    const recovered = await recoverMessageAddress({ message, signature });
    if (recovered.toLowerCase() !== address.toLowerCase()) {
      return { success: false, error: 'Signature does not match claimed address' };
    }
  } catch {
    return { success: false, error: 'Invalid signature format' };
  }

  let registry = loadRegistry();
  const key = address.toLowerCase();

  if (!registry[key]) return { success: false, error: 'Address not found in registry' };
  if (registry[key].isInternal) return { success: false, error: 'Cannot deregister internal dev agents' };

  delete registry[key];
  saveRegistry(registry);
  return { success: true };
}

/**
 * List all live agents (prunes expired entries, persists pruned state).
 */
export function listAgents(): AgentEntry[] {
  let registry = loadRegistry();
  const pruned = pruneExpired(registry);

  // Persist if anything was pruned
  if (Object.keys(pruned).length !== Object.keys(registry).length) {
    saveRegistry(pruned);
  }

  return Object.values(pruned);
}

/**
 * Get a single agent entry by address.
 */
export function getAgent(address: string): AgentEntry | null {
  const registry = loadRegistry();
  return registry[address.toLowerCase()] ?? null;
}

/**
 * Register an internal dev agent (no signature required — called at server start).
 */
export function registerInternalAgent(params: {
  address: string;
  name: string;
  role: string;
}): void {
  let registry = loadRegistry();
  const key = params.address.toLowerCase();

  // Only write if not already present (preserve existing lastSeen)
  if (!registry[key]) {
    const nowS = Math.floor(Date.now() / 1000);
    registry[key] = {
      address: key,
      name: params.name,
      contact: '',
      role: params.role,
      participantType: 'agent',
      isInternal: true,
      signedAt: nowS,
      lastSeen: nowS,
    };
    saveRegistry(registry);
  }
}
