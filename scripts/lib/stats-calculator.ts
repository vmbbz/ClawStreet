// @ts-nocheck
/**
 * stats-calculator.ts — On-chain performance stats per address
 *
 * Uses direct contract reads (readContract on loans(id) / options(id)) instead of
 * getLogs to avoid block-range limits and public RPC rate limits. Works for any
 * history length on a testnet with a small number of total deals.
 */

import { createPublicClient, http, parseAbi, formatUnits } from 'viem';
import { baseSepolia } from 'viem/chains';

// ─── Types ────────────────────────────────────────────────────────────────────

export interface AgentStats {
  address: string;
  loansCreated: number;
  loansFunded: number;
  loansRepaid: number;
  optionsWritten: number;
  optionsSold: number;
  optionsBought: number;
  optionsExercised: number;
  totalUsdcVolume: string;
  estimatedPnlUsdc: string;
  totalDeals: number;
  dataWindowBlocks: number; // -1 = contract reads (no block window)
}

// ─── Contract addresses ────────────────────────────────────────────────────────

const LOAN_ENGINE = '0x96C3291C9b0C34b007893326ee9dcA534BfcFa0c' as const;
const CALL_VAULT  = '0x69730728a0B19b844bc18888d2317987Bc528baE' as const;
const RPC_URL     = process.env.BASE_SEPOLIA_RPC ?? 'https://sepolia.base.org';

// ─── Minimal ABIs (server-side, can't import from src/) ───────────────────────

const LOAN_ABI = parseAbi([
  'function loanCounter() external view returns (uint256)',
  'function loans(uint256) external view returns (address,address,address,uint256,uint256,uint256,uint256,uint256,uint256,bool,bool)',
]);

const VAULT_ABI = parseAbi([
  'function optionCounter() external view returns (uint256)',
  'function options(uint256) external view returns (address,address,address,uint256,uint256,uint256,uint256,bool,bool)',
]);

// ─── Cache ────────────────────────────────────────────────────────────────────

const cache = new Map<string, { stats: AgentStats; expiresAt: number }>();
const CACHE_TTL_MS = 60_000;

// Bulk cache: keyed by sorted address list so repeated identical loads hit cache
const bulkCache = new Map<string, { result: Record<string, AgentStats>; expiresAt: number }>();

// ─── Public API ───────────────────────────────────────────────────────────────

export async function getAddressStats(address: string): Promise<AgentStats> {
  const key = address.toLowerCase();

  const cached = cache.get(key);
  if (cached && cached.expiresAt > Date.now()) return cached.stats;

  const stats = await fetchStats(key);
  cache.set(key, { stats, expiresAt: Date.now() + CACHE_TTL_MS });
  return stats;
}

/**
 * Bulk variant — reads ALL loans + options ONCE (3 RPC calls total regardless
 * of agent count) and filters per-address in-memory. Use this when fetching
 * stats for multiple addresses to avoid N parallel RPC bursts.
 */
export async function getAllAgentsStats(
  addresses: string[],
): Promise<Record<string, AgentStats>> {
  if (addresses.length === 0) return {};

  const keys = addresses.map(a => a.toLowerCase());
  const cacheKey = [...keys].sort().join(',');

  const cached = bulkCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) return cached.result;

  const client = createPublicClient({ chain: baseSepolia, transport: http(RPC_URL) });

  try {
    // 1 multicall — get total counts
    const [loanCount, optionCount] = await client.multicall({
      contracts: [
        { address: LOAN_ENGINE, abi: LOAN_ABI, functionName: 'loanCounter' as const },
        { address: CALL_VAULT,  abi: VAULT_ABI, functionName: 'optionCounter' as const },
      ],
      allowFailure: false,
    }) as [bigint, bigint];

    // 1 multicall — all loans
    const loanIds = Array.from({ length: Number(loanCount) }, (_, i) => BigInt(i));
    const loanResults = loanIds.length > 0
      ? await client.multicall({
          contracts: loanIds.map(id => ({
            address: LOAN_ENGINE as `0x${string}`, abi: LOAN_ABI,
            functionName: 'loans' as const, args: [id] as const,
          })),
          allowFailure: true,
        })
      : [];
    const loans = loanResults
      .map(r => r.status === 'success' ? r.result as any[] : null)
      .filter((l): l is any[] => l !== null);

    // 1 multicall — all options
    const optionIds = Array.from({ length: Number(optionCount) }, (_, i) => BigInt(i));
    const optionResults = optionIds.length > 0
      ? await client.multicall({
          contracts: optionIds.map(id => ({
            address: CALL_VAULT as `0x${string}`, abi: VAULT_ABI,
            functionName: 'options' as const, args: [id] as const,
          })),
          allowFailure: true,
        })
      : [];
    const options = optionResults
      .map(r => r.status === 'success' ? r.result as any[] : null)
      .filter((o): o is any[] => o !== null);

    // Filter per-address in memory — O(keys × deals), no extra RPC
    const ZERO = '0x0000000000000000000000000000000000000000';
    const result: Record<string, AgentStats> = {};

    for (const addr of keys) {
      const loansCreated  = loans.filter(l => l[0]?.toLowerCase() === addr).length;
      const loansFunded   = loans.filter(l => l[1]?.toLowerCase() === addr && l[1] !== ZERO).length;
      const loansRepaid   = loans.filter(l => l[0]?.toLowerCase() === addr && l[10] === true).length;

      let estimatedPnl = 0n, totalVolume = 0n;
      for (const l of loans) {
        const principal = l[4] as bigint ?? 0n;
        const interest  = l[5] as bigint ?? 0n;
        const repaid    = l[10] as boolean;
        if (l[0]?.toLowerCase() === addr) totalVolume += principal;
        if (l[1]?.toLowerCase() === addr && l[1] !== ZERO) {
          totalVolume += principal;
          if (repaid) estimatedPnl += interest;
        }
      }

      const optionsWritten   = options.filter(o => o[0]?.toLowerCase() === addr).length;
      const optionsBought    = options.filter(o => o[1]?.toLowerCase() === addr && o[1] !== ZERO).length;
      const optionsSold      = options.filter(o => o[0]?.toLowerCase() === addr && o[1] !== ZERO).length;
      const optionsExercised = options.filter(o => o[1]?.toLowerCase() === addr && o[7] === true).length;
      for (const o of options) {
        if (o[0]?.toLowerCase() === addr && o[1] !== ZERO) {
          estimatedPnl += o[6] as bigint ?? 0n;
          totalVolume  += o[6] as bigint ?? 0n;
        }
      }

      const stats: AgentStats = {
        address: addr,
        loansCreated, loansFunded, loansRepaid,
        optionsWritten, optionsSold, optionsBought, optionsExercised,
        totalUsdcVolume:  formatUnits(totalVolume, 6),
        estimatedPnlUsdc: formatUnits(estimatedPnl, 6),
        totalDeals: loansCreated + loansFunded + optionsWritten + optionsBought,
        dataWindowBlocks: -1,
      };
      result[addr] = stats;
      // Also prime the per-address cache
      cache.set(addr, { stats, expiresAt: Date.now() + CACHE_TTL_MS });
    }

    bulkCache.set(cacheKey, { result, expiresAt: Date.now() + CACHE_TTL_MS });
    return result;
  } catch (err) {
    console.error('[stats] bulk fetch failed:', err);
    return Object.fromEntries(keys.map(a => [a, emptyStats(a)]));
  }
}

// ─── Core fetch (contract reads — no block range constraint) ──────────────────

async function fetchStats(address: string): Promise<AgentStats> {
  const client = createPublicClient({ chain: baseSepolia, transport: http(RPC_URL) });

  try {
    // ── Get total counts in one multicall ─────────────────────────────────────
    const counters = await client.multicall({
      contracts: [
        { address: LOAN_ENGINE, abi: LOAN_ABI, functionName: 'loanCounter' as const },
        { address: CALL_VAULT,  abi: VAULT_ABI, functionName: 'optionCounter' as const },
      ],
      allowFailure: false,
    }) as [bigint, bigint];
    const [loanCount, optionCount] = counters;

    // ── Batch all loan reads into one multicall ───────────────────────────────
    const loanIds = Array.from({ length: Number(loanCount) }, (_, i) => BigInt(i));
    const loanResults = loanIds.length > 0
      ? await client.multicall({
          contracts: loanIds.map(id => ({
            address: LOAN_ENGINE as `0x${string}`, abi: LOAN_ABI,
            functionName: 'loans' as const, args: [id] as const,
          })),
          allowFailure: true,
        })
      : [];
    const loans = loanResults
      .map(r => r.status === 'success' ? r.result as any[] : null)
      .filter((l): l is any[] => l !== null);

    // loan[0]=borrower, loan[1]=lender, loan[4]=principal, loan[5]=interest,
    // loan[9]=active, loan[10]=repaid
    const addr = address.toLowerCase();
    const ZERO = '0x0000000000000000000000000000000000000000';

    const loansCreated = loans.filter(l => l[0]?.toLowerCase() === addr).length;
    const loansFunded  = loans.filter(l => l[1]?.toLowerCase() === addr && l[1] !== ZERO).length;
    const loansRepaid  = loans.filter(l => l[0]?.toLowerCase() === addr && l[10] === true).length;

    // Estimate PnL: lender earns interest on funded+repaid loans
    let estimatedPnl = 0n;
    let totalVolume  = 0n;
    for (const l of loans) {
      const principal = l[4] as bigint ?? 0n;
      const interest  = l[5] as bigint ?? 0n;
      const repaid    = l[10] as boolean;
      if (l[0]?.toLowerCase() === addr) {
        totalVolume += principal;
      }
      if (l[1]?.toLowerCase() === addr && l[1] !== ZERO) {
        totalVolume += principal;
        if (repaid) estimatedPnl += interest;
      }
    }

    // ── Batch all option reads into one multicall ─────────────────────────────
    const optionIds = Array.from({ length: Number(optionCount) }, (_, i) => BigInt(i));
    const optionResults = optionIds.length > 0
      ? await client.multicall({
          contracts: optionIds.map(id => ({
            address: CALL_VAULT as `0x${string}`, abi: VAULT_ABI,
            functionName: 'options' as const, args: [id] as const,
          })),
          allowFailure: true,
        })
      : [];
    const options = optionResults
      .map(r => r.status === 'success' ? r.result as any[] : null)
      .filter((o): o is any[] => o !== null);

    // option[0]=writer, option[1]=buyer, option[6]=premium, option[7]=exercised
    const optionsWritten   = options.filter(o => o[0]?.toLowerCase() === addr).length;
    const optionsBought    = options.filter(o => o[1]?.toLowerCase() === addr && o[1] !== ZERO).length;
    const optionsSold      = options.filter(o => o[0]?.toLowerCase() === addr && o[1] !== ZERO).length;
    const optionsExercised = options.filter(o => o[1]?.toLowerCase() === addr && o[7] === true).length;

    for (const o of options) {
      const premium = o[6] as bigint ?? 0n;
      if (o[0]?.toLowerCase() === addr) {
        // Writer wrote a call — premium is income when bought
        if (o[1] !== ZERO) {
          estimatedPnl += premium;
          totalVolume  += premium;
        }
      }
    }

    const totalDeals = loansCreated + loansFunded + optionsWritten + optionsBought;

    return {
      address,
      loansCreated, loansFunded, loansRepaid,
      optionsWritten, optionsSold, optionsBought, optionsExercised,
      totalUsdcVolume:  formatUnits(totalVolume, 6),
      estimatedPnlUsdc: formatUnits(estimatedPnl, 6),
      totalDeals,
      dataWindowBlocks: -1, // contract reads — no block window constraint
    };
  } catch (err) {
    console.error(`[stats] readContract failed for ${address}:`, err);
    return emptyStats(address);
  }
}

function emptyStats(address: string): AgentStats {
  return {
    address, loansCreated: 0, loansFunded: 0, loansRepaid: 0,
    optionsWritten: 0, optionsSold: 0, optionsBought: 0, optionsExercised: 0,
    totalUsdcVolume: '0.00', estimatedPnlUsdc: '0.00',
    totalDeals: 0, dataWindowBlocks: -1,
  };
}
