// @ts-nocheck
/**
 * scripts/lib/chain-monitor.ts
 * Watches on-chain events during the open participation window.
 *
 * Uses getLogs polling (compatible with all public RPC endpoints).
 * watchContractEvent / eth_newFilter is disabled on most public nodes.
 */

import { parseAbi, type PublicClient } from 'viem';

export interface ParticipationEvent {
  type: 'loan' | 'option';
  id: number;
  participant: string;
  txHash: string;
  blockNumber: bigint;
}

const LOAN_ABI = parseAbi([
  'event LoanAccepted(uint256 indexed loanId, address indexed lender)',
]);

const OPTION_ABI = parseAbi([
  'event OptionBought(uint256 indexed optionId, address indexed buyer)',
]);

const LOAN_READ_ABI = parseAbi([
  'function loans(uint256 loanId) external view returns (address borrower, address lender, address nftContract, uint256 nftId, uint256 principal, uint256 interest, uint256 duration, uint256 startTime, uint256 healthSnapshot, bool active, bool repaid)',
]);

const OPTION_READ_ABI = parseAbi([
  'function options(uint256 optionId) external view returns (address writer, address buyer, address underlying, uint256 amount, uint256 strike, uint256 expiry, uint256 premium, bool exercised, bool active)',
]);

const ZERO_ADDR = '0x0000000000000000000000000000000000000000';
const POLL_INTERVAL_MS = 15_000;

/**
 * Watches for LoanAccepted / OptionBought events by polling getLogs every 15s.
 * Falls back to direct contract state reads if getLogs fails.
 * Compatible with all public HTTP RPC endpoints.
 *
 * @returns Array of organic participation events detected
 */
export async function watchForParticipation(
  loanIds: bigint[],
  optionIds: bigint[],
  timeoutMs: number,
  publicClient: PublicClient,
  loanEngine: `0x${string}`,
  callVault: `0x${string}`,
): Promise<ParticipationEvent[]> {
  const events: ParticipationEvent[] = [];
  const filled = new Set<string>();
  const totalDeals = loanIds.length + optionIds.length;

  if (totalDeals === 0) {
    console.log('[monitor] No open deals to watch — skipping participation window');
    return [];
  }

  console.log(`[monitor] Watching ${loanIds.length} loans + ${optionIds.length} options for ${Math.round(timeoutMs / 1000)}s`);
  console.log(`[monitor]   Loan IDs:   ${loanIds.map(String).join(', ') || 'none'}`);
  console.log(`[monitor]   Option IDs: ${optionIds.map(String).join(', ') || 'none'}`);
  console.log(`[monitor]   Method: getLogs polling every ${POLL_INTERVAL_MS / 1000}s`);

  // Snapshot starting block so we only look at blocks from now forward
  let fromBlock: bigint;
  try {
    fromBlock = await publicClient.getBlockNumber();
  } catch {
    fromBlock = 0n;
  }

  return new Promise((resolve) => {
    let resolved = false;

    const finish = () => {
      if (resolved) return;
      resolved = true;
      clearInterval(pollInterval);
      clearTimeout(timer);
      console.log(`[monitor] Window closed — ${events.length} organic event(s) detected`);
      resolve(events);
    };

    const timer = setTimeout(finish, timeoutMs);

    // ── Polling loop ────────────────────────────────────────────────────────
    const poll = async () => {
      if (resolved) return;

      let toBlock: bigint;
      try {
        toBlock = await publicClient.getBlockNumber();
      } catch {
        return; // skip this poll on RPC error
      }

      if (toBlock < fromBlock) return;

      // ── Check LoanAccepted logs ──────────────────────────────────────────
      for (const loanId of loanIds) {
        const key = `loan-${loanId}`;
        if (filled.has(key)) continue;

        // Primary: try getLogs
        let lenderFound: string | null = null;
        let txHash = '';
        let blockNum = 0n;

        try {
          const logs = await publicClient.getLogs({
            address: loanEngine,
            event: LOAN_ABI[0],
            args: { loanId },
            fromBlock,
            toBlock,
          });
          if (logs.length > 0) {
            lenderFound = logs[0].args.lender as string;
            txHash = logs[0].transactionHash ?? '';
            blockNum = logs[0].blockNumber ?? 0n;
          }
        } catch {
          // getLogs failed — fall back to contract state read
        }

        // Fallback: read lender from contract state
        if (!lenderFound) {
          try {
            const loan = await publicClient.readContract({
              address: loanEngine, abi: LOAN_READ_ABI,
              functionName: 'loans', args: [loanId],
            }) as any[];
            const lender = loan[1] as string;
            if (lender.toLowerCase() !== ZERO_ADDR) {
              lenderFound = lender;
            }
          } catch {}
        }

        if (lenderFound && lenderFound.toLowerCase() !== ZERO_ADDR) {
          filled.add(key);
          console.log(`[monitor] 🎉 Loan #${loanId} funded by ${lenderFound.slice(0, 10)}...`);
          events.push({ type: 'loan', id: Number(loanId), participant: lenderFound, txHash, blockNumber: blockNum });
        }
      }

      // ── Check OptionBought logs ──────────────────────────────────────────
      for (const optionId of optionIds) {
        const key = `option-${optionId}`;
        if (filled.has(key)) continue;

        let buyerFound: string | null = null;
        let txHash = '';
        let blockNum = 0n;

        try {
          const logs = await publicClient.getLogs({
            address: callVault,
            event: OPTION_ABI[0],
            args: { optionId },
            fromBlock,
            toBlock,
          });
          if (logs.length > 0) {
            buyerFound = logs[0].args.buyer as string;
            txHash = logs[0].transactionHash ?? '';
            blockNum = logs[0].blockNumber ?? 0n;
          }
        } catch {}

        // Fallback: read buyer from contract state
        if (!buyerFound) {
          try {
            const opt = await publicClient.readContract({
              address: callVault, abi: OPTION_READ_ABI,
              functionName: 'options', args: [optionId],
            }) as any[];
            const buyer = opt[1] as string;
            if (buyer.toLowerCase() !== ZERO_ADDR) {
              buyerFound = buyer;
            }
          } catch {}
        }

        if (buyerFound && buyerFound.toLowerCase() !== ZERO_ADDR) {
          filled.add(key);
          console.log(`[monitor] 🎉 Option #${optionId} bought by ${buyerFound.slice(0, 10)}...`);
          events.push({ type: 'option', id: Number(optionId), participant: buyerFound, txHash, blockNumber: blockNum });
        }
      }

      // Advance fromBlock to avoid re-scanning the same range
      if (toBlock > fromBlock) fromBlock = toBlock + 1n;

      // All deals filled — close early
      if (filled.size >= totalDeals) finish();
    };

    // Initial check immediately, then every POLL_INTERVAL_MS
    poll().catch(() => {});
    const pollInterval = setInterval(() => poll().catch(() => {}), POLL_INTERVAL_MS);
  });
}
