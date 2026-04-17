// @ts-nocheck
/**
 * scripts/lib/reporter.ts
 * Writes per-cycle JSON reports to logs/reports/ and updates logs/latest.json
 */

import { writeFileSync, mkdirSync } from 'fs';
import { resolve } from 'path';

const REPORTS_DIR = resolve(process.cwd(), 'logs/reports');
const STATUS_FILE  = resolve(process.cwd(), 'logs/status.json');
const LATEST_FILE  = resolve(process.cwd(), 'logs/latest.json');

export type RunnerState =
  | 'idle'
  | 'planning'
  | 'executing'
  | 'open_window'
  | 'monitoring'
  | 'settling'
  | 'reporting';

export type ScenarioType = 'loan' | 'option' | 'combined' | 'staking';

export interface TxRecord {
  hash: string;
  label: string;
  agent: string;
  gasUsed: string;
  basescanUrl: string;
}

export interface ParticipantRecord {
  address: string;
  role: 'borrower' | 'lender' | 'writer' | 'buyer';
  isAgent: boolean;
  agentName?: string;
  pnlUsdc: string;   // estimated profit/loss in USDC
  pnlNote: string;   // human-readable explanation
}

export interface DealRecord {
  type: 'loan' | 'option';
  id: number;
  openWindowSeconds: number;
  organicParticipation: boolean;
  outcome: 'funded-by-automation' | 'bought-by-automation' | 'funded-by-external' | 'bought-by-external' | 'settled' | 'expired';
  participants: ParticipantRecord[];
  // deal-level financial summary
  principalUsdc?: string;   // loan principal
  interestUsdc?: string;    // loan interest
  premiumUsdc?: string;     // option premium
  strikeUsdc?: string;      // option strike
}

export interface OpenDeal {
  type: 'loan' | 'option';
  id: number;
  windowEndsAt: string;
}

export interface CycleReport {
  cycleId: string;
  scenario: ScenarioType;
  status: 'complete' | 'partial' | 'failed';
  durationSeconds: number;
  transactions: TxRecord[];
  deals: DealRecord[];
  ethSpent: Record<string, string>;
  totalEthSpent: string;
  usdcVolume: string;
  organicParticipants: number;
  automatedParticipants: number;
  externalAddresses: string[];       // non-agent wallets that participated
  nextScheduledAt: string;
}

export interface CycleStatus {
  state: RunnerState;
  cycleId: string | null;
  scenario: ScenarioType | null;
  openDeals: OpenDeal[];
  transactions: TxRecord[];
  nextScheduledAt: string | null;
  ethBudget: Record<string, string>;
  lastError?: string;
}

// ─── Status file ──────────────────────────────────────────────────────────────

export function writeStatus(status: CycleStatus) {
  try {
    mkdirSync(resolve(process.cwd(), 'logs'), { recursive: true });
    writeFileSync(STATUS_FILE, JSON.stringify(status, null, 2), 'utf-8');
  } catch (e) {
    console.error('[reporter] Failed to write status.json:', e);
  }
}

export function buildInitialStatus(): CycleStatus {
  return {
    state: 'idle',
    cycleId: null,
    scenario: null,
    openDeals: [],
    transactions: [],
    nextScheduledAt: null,
    ethBudget: {},
  };
}

// ─── Report file ──────────────────────────────────────────────────────────────

export function writeReport(report: CycleReport) {
  try {
    mkdirSync(REPORTS_DIR, { recursive: true });

    // Sanitize cycleId for filename
    const safeId = report.cycleId.replace(/[:.]/g, '-').replace('T', 'T').slice(0, 24);
    const filePath = resolve(REPORTS_DIR, `cycle-${safeId}.json`);

    writeFileSync(filePath, JSON.stringify(report, null, 2), 'utf-8');
    writeFileSync(LATEST_FILE, JSON.stringify(report, null, 2), 'utf-8');

    console.log(`[reporter] Report written: logs/reports/cycle-${safeId}.json`);
  } catch (e) {
    console.error('[reporter] Failed to write report:', e);
  }
}

// ─── Report builder ───────────────────────────────────────────────────────────

export function buildReport(params: {
  cycleId: string;
  scenario: ScenarioType;
  status: 'complete' | 'partial' | 'failed';
  startedAt: number;
  transactions: TxRecord[];
  deals: DealRecord[];
  ethBefore: Record<string, bigint>;
  ethAfter: Record<string, bigint>;
  usdcVolume: bigint;
  nextScheduledAt: string | null;
}): CycleReport {
  const { cycleId, scenario, status, startedAt, transactions, deals,
          ethBefore, ethAfter, usdcVolume, nextScheduledAt } = params;

  const ethSpent: Record<string, string> = {};
  let totalWei = 0n;

  for (const agent of Object.keys(ethBefore)) {
    const before = ethBefore[agent] ?? 0n;
    const after  = ethAfter[agent]  ?? 0n;
    const spent  = before > after ? before - after : 0n;
    ethSpent[agent] = formatEth(spent);
    totalWei += spent;
  }

  const organicParticipants = deals.filter(d => d.organicParticipation).length;
  const automatedParticipants = deals.filter(d => !d.organicParticipation).length;

  // Collect external (non-agent) addresses
  const KNOWN_AGENT_NAMES = new Set(['BorrowerAgent_Delta','LendingAgent_Gamma','HedgeAgent_Epsilon','ArbitrageAgent_Beta','LiquidityAgent_Alpha']);
  const externalAddresses = Array.from(new Set(
    deals.flatMap(d => d.participants)
      .filter(p => !p.isAgent && p.address && p.address !== '0x0000000000000000000000000000000000000000')
      .map(p => p.address.toLowerCase())
  ));

  return {
    cycleId,
    scenario,
    status,
    durationSeconds: Math.round((Date.now() - startedAt) / 1000),
    transactions,
    deals,
    ethSpent,
    totalEthSpent: formatEth(totalWei),
    usdcVolume: formatUsdc(usdcVolume),
    organicParticipants,
    automatedParticipants,
    externalAddresses,
    nextScheduledAt: nextScheduledAt ?? new Date(Date.now() + 7200_000).toISOString(),
  };
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function formatEth(wei: bigint): string {
  if (wei === 0n) return '0';
  const str = wei.toString().padStart(19, '0');
  const int  = str.slice(0, -18) || '0';
  const dec  = str.slice(-18).replace(/0+$/, '').slice(0, 6);
  return dec ? `${int}.${dec}` : int;
}

function formatUsdc(raw: bigint): string {
  if (raw === 0n) return '0';
  const str = raw.toString().padStart(7, '0');
  const int  = str.slice(0, -6) || '0';
  const dec  = str.slice(-6).replace(/0+$/, '');
  return dec ? `${int}.${dec}` : int;
}
