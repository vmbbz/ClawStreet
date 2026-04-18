// @ts-nocheck
/**
 * scripts/faucet-link.ts
 * Mints 100 tLINK (TestLINK) to a given address using the owner wallet.
 * Called by the server: tsx scripts/faucet-link.ts --to 0xABC...
 *
 * Pre-requisite: deploy script/DeployTestTokens.s.sol and set TEST_LINK address below.
 */

import 'dotenv/config';
import { createPublicClient, createWalletClient, http, parseAbi, parseUnits, type Address } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { baseSepolia } from 'viem/chains';

const TEST_LINK  = (process.env.TEST_LINK_ADDRESS ?? '') as Address;
const RPC_URL    = process.env.VITE_BASE_SEPOLIA_RPC ?? 'https://sepolia.base.org';
const AMOUNT     = parseUnits('100', 18); // 100 tLINK

const TOKEN_ABI = parseAbi([
  'function mint(address to, uint256 amount) external',
]);

function getArg(flag: string): string | null {
  const idx = process.argv.indexOf(flag);
  return idx !== -1 ? (process.argv[idx + 1] ?? null) : null;
}

async function main() {
  if (!TEST_LINK || TEST_LINK.length !== 42) {
    console.error('❌ TEST_LINK_ADDRESS not set. Deploy test tokens first and set env var.');
    process.exit(1);
  }

  const toAddr = getArg('--to');
  if (!toAddr || !/^0x[0-9a-fA-F]{40}$/.test(toAddr)) {
    console.error('Usage: tsx scripts/faucet-link.ts --to 0x<address>');
    process.exit(1);
  }

  const deployerKey = process.env.DEPLOYER_PRIVATE_KEY;
  if (!deployerKey) {
    console.error('❌ DEPLOYER_PRIVATE_KEY not set in .env');
    process.exit(1);
  }

  const owner = privateKeyToAccount(deployerKey as `0x${string}`);
  const transport = http(RPC_URL);
  const publicClient = createPublicClient({ chain: baseSepolia, transport });
  const wallet = createWalletClient({ account: owner, chain: baseSepolia, transport });

  const hash = await wallet.writeContract({
    address: TEST_LINK,
    abi: TOKEN_ABI,
    functionName: 'mint',
    args: [toAddr as Address, AMOUNT],
  });

  const receipt = await publicClient.waitForTransactionReceipt({ hash, timeout: 60_000 });
  if (receipt.status !== 'success') {
    console.error('❌ Mint failed');
    process.exit(1);
  }

  console.log(JSON.stringify({ success: true, txHash: hash, amount: '100', symbol: 'tLINK', to: toAddr }));
}

main().catch(e => {
  console.error(JSON.stringify({ success: false, error: String(e) }));
  process.exit(1);
});
