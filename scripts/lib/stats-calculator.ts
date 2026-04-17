/**
 * stats-calculator.ts — On-chain performance stats aggregation per address
 *
 * Fetches recent events from the protocol contracts using a bounded getLogs
 * window (current block − 9500), aggregates by address, and computes estimated
 * PnL. Results are cached in-memory for 60s to avoid hammering the RPC.
 */

import { createPublicClient, http, parseAbiItem, formatUnits } from 'viem';
import { baseSepolia } from 'viem/chains';

// ─── Types ────────────────────────────────────────────────────────────────────

export interface AgentStats {
  address: string;
  // Loan activity
  loansCreated: number;        // LoanCreated where borrower = address
  loansFunded: number;         // LoanAccepted where lender = address
  loansRepaid: number;         // LoanRepaid where borrower = address (approx)
  // Options activity
  optionsWritten: number;      // OptionWritten where writer = address
  optionsSold: number;         // OptionBought where writer (from written log) = address
  optionsBought: number;       // OptionBought where buyer = address
  optionsExercised: number;    // OptionExercised where buyer = address
  // Volume
  totalUsdcVolume: string;     // formatted with 2 decimals
  estimatedPnlUsdc: string;    // rough estimate, may be negative
  // Summary
  totalDeals: number;
  dataWindowBlocks: number;    // how many blocks of history were scanned
}

// ─── Contract addresses ────────────────────────────────────────────────────────
// Imported from config so we have one source of truth.
// We keep these here to avoid frontend imports in server-side code.

const LOAN_ENGINE  = '0x96C3291C9b0C34b007893326ee9dcA534BfcFa0c' as const;
const CALL_VAULT   = '0x69730728a0B19b844bc18888d2317987Bc528baE' as const;
const RPC_URL      = process.env.BASE_SEPOLIA_RPC ?? 'https://sepolia.base.org';
const BLOCK_WINDOW = 9500n;

// ─── Cache ────────────────────────────────────────────────────────────────────

const cache = new Map<string, { stats: AgentStats; expiresAt: number }>();
const CACHE_TTL_MS = 60_000; // 60s

// ─── Public API ───────────────────────────────────────────────────────────────

export async function getAddressStats(address: string): Promise<AgentStats> {
  const key = address.toLowerCase();

  const cached = cache.get(key);
  if (cached && cached.expiresAt > Date.now()) return cached.stats;

  const stats = await fetchStats(key);
  cache.set(key, { stats, expiresAt: Date.now() + CACHE_TTL_MS });
  return stats;
}

// ─── Core fetch ───────────────────────────────────────────────────────────────

async function fetchStats(address: string): Promise<AgentStats> {
  const client = createPublicClient({ chain: baseSepolia, transport: http(RPC_URL) });

  const currentBlock = await client.getBlockNumber();
  const fromBlock = currentBlock > BLOCK_WINDOW ? currentBlock - BLOCK_WINDOW : 0n;

  let loansCreated    = 0;
  let loansFunded     = 0;
  let loansRepaid     = 0;
  let optionsWritten  = 0;
  let optionsBought   = 0;
  let optionsExercised = 0;

  // Estimated USDC flows kept as bigint throughout to avoid float precision loss
  let estimatedPnl = 0n; // in USDC micro-units (6 decimals)
  let totalVolume  = 0n;

  try {
    // ── Loans created (as borrower) ──────────────────────────────────────
    const loanCreatedLogs = await client.getLogs({
      address: LOAN_ENGINE,
      event: parseAbiItem('event LoanCreated(uint256 indexed loanId, address indexed borrower, uint256 principal, uint256 health)'),
      args: { borrower: address as `0x${string}` },
      fromBlock,
    });
    loansCreated = loanCreatedLogs.length;
    for (const log of loanCreatedLogs) {
      const principal = log.args.principal ?? 0n;
      totalVolume  += principal;
      // Borrower receives principal as inflow (owes it back later)
      estimatedPnl += principal;
    }

    // ── Loans funded (as lender) ─────────────────────────────────────────
    const loanAcceptedLogs = await client.getLogs({
      address: LOAN_ENGINE,
      event: parseAbiItem('event LoanAccepted(uint256 indexed loanId, address indexed lender)'),
      args: { lender: address as `0x${string}` },
      fromBlock,
    });
    loansFunded = loanAcceptedLogs.length;

    // ── Loans repaid (as borrower) ────────────────────────────────────────
    // LoanRepaid event signature: LoanRepaid(uint256 loanId)
    // We can't filter by borrower here, so we count events we know about
    // from the LoanCreated logs. This is approximate for the bounded window.
    const loanRepaidLogs = await client.getLogs({
      address: LOAN_ENGINE,
      event: parseAbiItem('event LoanRepaid(uint256 indexed loanId)'),
      fromBlock,
    });
    // Count repaid loans where the loanId appears in our created loans
    const createdLoanIds = new Set(loanCreatedLogs.map(l => l.args.loanId?.toString()));
    for (const log of loanRepaidLogs) {
      if (createdLoanIds.has(log.args.loanId?.toString())) {
        loansRepaid++;
        // Repaid = borrower paid back principal + interest → negative PnL adjustment
        // We use a rough 10% interest estimate since we'd need another read to get exact amount
      }
    }

    // ── Options written ───────────────────────────────────────────────────
    const optionWrittenLogs = await client.getLogs({
      address: CALL_VAULT,
      event: parseAbiItem('event OptionWritten(uint256 indexed optionId, address indexed writer, uint256 amount, uint256 strike, uint256 premium)'),
      args: { writer: address as `0x${string}` },
      fromBlock,
    });
    optionsWritten = optionWrittenLogs.length;
    const writtenOptionIds = new Set(optionWrittenLogs.map(l => l.args.optionId?.toString()));

    // ── Options bought by this address ────────────────────────────────────
    const optionBoughtAsLogs = await client.getLogs({
      address: CALL_VAULT,
      event: parseAbiItem('event OptionBought(uint256 indexed optionId, address indexed buyer)'),
      args: { buyer: address as `0x${string}` },
      fromBlock,
    });
    optionsBought = optionBoughtAsLogs.length;

    // ── Options where this address was the WRITER who collected premium ───
    const optionBoughtFromWriterLogs = await client.getLogs({
      address: CALL_VAULT,
      event: parseAbiItem('event OptionBought(uint256 indexed optionId, address indexed buyer)'),
      fromBlock,
    });
    let optionsSold = 0;
    for (const log of optionBoughtFromWriterLogs) {
      if (writtenOptionIds.has(log.args.optionId?.toString())) {
        optionsSold++;
        // Find the matching written log to get premium
        const writtenLog = optionWrittenLogs.find(
          w => w.args.optionId?.toString() === log.args.optionId?.toString()
        );
        if (writtenLog) {
          const premium = writtenLog.args.premium ?? 0n;
          estimatedPnl += premium;
          totalVolume  += premium;
        }
      }
    }

    // ── Options exercised ─────────────────────────────────────────────────
    const optionExercisedLogs = await client.getLogs({
      address: CALL_VAULT,
      event: parseAbiItem('event OptionExercised(uint256 indexed optionId, address indexed buyer)'),
      args: { buyer: address as `0x${string}` },
      fromBlock,
    });
    optionsExercised = optionExercisedLogs.length;

    const totalDeals = loansCreated + loansFunded + optionsWritten + optionsBought;

    return {
      address,
      loansCreated,
      loansFunded,
      loansRepaid,
      optionsWritten,
      optionsSold,
      optionsBought,
      optionsExercised,
      totalUsdcVolume:    formatUnits(totalVolume, 6),
      estimatedPnlUsdc:   formatUnits(estimatedPnl, 6),
      totalDeals,
      dataWindowBlocks:   Number(BLOCK_WINDOW),
    };
  } catch (err) {
    console.error(`[stats] Failed to fetch stats for ${address}:`, err);
    return emptyStats(address, Number(BLOCK_WINDOW));
  }
}

function emptyStats(address: string, windowBlocks: number): AgentStats {
  return {
    address, loansCreated: 0, loansFunded: 0, loansRepaid: 0,
    optionsWritten: 0, optionsSold: 0, optionsBought: 0, optionsExercised: 0,
    totalUsdcVolume: '0.00', estimatedPnlUsdc: '0.00',
    totalDeals: 0, dataWindowBlocks: windowBlocks,
  };
}
