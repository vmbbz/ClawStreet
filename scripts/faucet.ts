// @ts-nocheck
/**
 * scripts/faucet.ts
 * Backend faucet — mints 1000 MockUSDC to a given address using Alpha's wallet (owner).
 * Called by the server: tsx scripts/faucet.ts --to 0xABC...
 */

import 'dotenv/config';
import { readFileSync, existsSync } from 'fs';
import { resolve } from 'path';
import { createPublicClient, createWalletClient, http, parseAbi, parseUnits, type Address } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { baseSepolia } from 'viem/chains';

const MOCK_USDC   = '0xDCf9936b330D6957CaD463f850D1F2B6F1eABc3A' as Address;
const RPC_URL     = process.env.VITE_BASE_SEPOLIA_RPC ?? 'https://sepolia.base.org';
const AMOUNT_USDC = 1000; // human-readable units

const USDC_ABI = parseAbi([
  'function mintHuman(address to, uint256 humanAmount) external',
  'function balanceOf(address account) external view returns (uint256)',
]);

function getArg(flag: string): string | null {
  const idx = process.argv.indexOf(flag);
  return idx !== -1 ? (process.argv[idx + 1] ?? null) : null;
}

async function main() {
  const toAddr = getArg('--to');
  if (!toAddr || !/^0x[0-9a-fA-F]{40}$/.test(toAddr)) {
    console.error('Usage: tsx scripts/faucet.ts --to 0x<address>');
    process.exit(1);
  }

  const keyFile = resolve(process.cwd(), '.env.agents');
  if (!existsSync(keyFile)) {
    console.error('❌ .env.agents not found');
    process.exit(1);
  }
  const keys: Record<string, string> = {};
  for (const line of readFileSync(keyFile, 'utf-8').split('\n')) {
    if (line.startsWith('#') || !line.includes('=')) continue;
    const [k, v] = line.trim().split('=');
    keys[k] = v;
  }

  const alpha = privateKeyToAccount(keys['AGENT1_PRIVATE_KEY'] as `0x${string}`);
  const transport = http(RPC_URL);
  const publicClient = createPublicClient({ chain: baseSepolia, transport });
  const wallet = createWalletClient({ account: alpha, chain: baseSepolia, transport });

  const hash = await wallet.writeContract({
    address: MOCK_USDC,
    abi: USDC_ABI,
    functionName: 'mintHuman',
    args: [toAddr as Address, BigInt(AMOUNT_USDC)],
  });

  const receipt = await publicClient.waitForTransactionReceipt({ hash, timeout: 60_000 });
  if (receipt.status !== 'success') {
    console.error('❌ Mint failed');
    process.exit(1);
  }

  console.log(JSON.stringify({ success: true, txHash: hash, amount: AMOUNT_USDC, to: toAddr }));
}

main().catch(e => {
  console.error(JSON.stringify({ success: false, error: String(e) }));
  process.exit(1);
});
