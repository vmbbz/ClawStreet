// @ts-nocheck
/**
 * deal-relay.ts — Internal agent auto-execution
 *
 * When an internal agent accepts a bargaining offer, auto-creates a new on-chain
 * deal at the agreed terms so the proposer can fill it immediately.
 *
 * Loan flow: deposit tWETH into BundleVault → receive Bundle NFT → createLoanOffer
 * Option flow: writeCoveredCall using tWETH as the underlying asset
 *
 * Note: The public gas relay API has been removed. External agents call contracts
 * directly with their own wallets. See AgentAPI for the Direct Contract Call guide.
 */

import 'dotenv/config';
import {
  createPublicClient, createWalletClient, http, parseAbi, parseUnits,
  type Address,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { baseSepolia } from 'viem/chains';
import { existsSync, readFileSync } from 'fs';
import { resolve } from 'path';

// ─── Contracts ────────────────────────────────────────────────────────────────

const LOAN_ENGINE  = '0x96C3291C9b0C34b007893326ee9dcA534BfcFa0c' as Address;
const CALL_VAULT   = '0x69730728a0B19b844bc18888d2317987Bc528baE' as Address;
const BUNDLE_VAULT = '0x86ef420fD3e27c3Ac896c479B19b6A840b97Bee1' as Address;
const RPC_URL      = process.env.BASE_SEPOLIA_RPC ?? 'https://sepolia.base.org';

const LOAN_ABI = parseAbi([
  'function createLoanOffer(address nftContract, uint256 nftId, uint256 principal, uint256 interest, uint256 duration) external',
  'function acceptLoan(uint256 loanId, bytes[] calldata priceUpdateData) external payable',
  'function loanCounter() external view returns (uint256)',
  'function loans(uint256 loanId) external view returns (address borrower, address lender, address nftContract, uint256 nftId, uint256 principal, uint256 interest, uint256 duration, uint256 startTime, uint256 healthSnapshot, bool active, bool repaid)',
]);

const VAULT_ABI = parseAbi([
  'function writeCoveredCall(address underlying, uint256 amount, uint256 strike, uint256 expiry, uint256 premium) external returns (uint256)',
  'function buyOption(uint256 optionId) external',
  'function optionCounter() external view returns (uint256)',
  'function options(uint256 optionId) external view returns (address writer, address buyer, address underlying, uint256 amount, uint256 strike, uint256 expiry, uint256 premium, bool exercised, bool active)',
]);

const BUNDLE_VAULT_ABI = parseAbi([
  'function depositBundle(address[] calldata erc20Tokens, uint256[] calldata erc20Amounts, address[] calldata erc721Contracts, uint256[] calldata erc721Ids, string calldata metadataURI) external returns (uint256)',
  'function approve(address to, uint256 tokenId) external',
  'event BundleDeposited(uint256 indexed tokenId, address indexed owner)',
]);

const ERC20_ABI = parseAbi([
  'function approve(address spender, uint256 amount) external returns (bool)',
  'function allowance(address owner, address spender) external view returns (uint256)',
  'function balanceOf(address) external view returns (uint256)',
]);

// ─── Internal agent addresses (from server.ts DEV_AGENTS) ────────────────────

const INTERNAL_AGENT_KEY_MAP: Record<string, string> = {
  '0xd1e84c88734013613230678b8e000de53e4957dc': 'AGENT1_PRIVATE_KEY', // Alpha
  '0xbaf9d5e05d82bea9b971b54ad148904ae25876b2': 'AGENT2_PRIVATE_KEY', // Beta
  '0x37d57004fdebd029d9fcb1cc88e275feafa89353': 'AGENT3_PRIVATE_KEY', // Gamma
  '0x5159345b9944ab14d05c18853923070d3ebf60ad': 'AGENT4_PRIVATE_KEY', // Delta
  '0x4eed792404bbc7bc98648ebe653e38995b8e3dfb': 'AGENT5_PRIVATE_KEY', // Epsilon
};

export function loadInternalAgentKeys(): Record<string, `0x${string}`> {
  const path = resolve(process.cwd(), '.env.agents');
  if (!existsSync(path)) return {};
  const raw: Record<string, string> = {};
  for (const line of readFileSync(path, 'utf-8').split('\n')) {
    if (line.startsWith('#') || !line.includes('=')) continue;
    const [k, v] = line.trim().split('=');
    raw[k] = v;
  }
  const result: Record<string, `0x${string}`> = {};
  for (const [addr, keyName] of Object.entries(INTERNAL_AGENT_KEY_MAP)) {
    const key = raw[keyName];
    if (key) result[addr] = key as `0x${string}`;
  }
  return result;
}

export function isInternalAgent(address: string): boolean {
  return address.toLowerCase() in INTERNAL_AGENT_KEY_MAP;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeClients(privateKey: `0x${string}`) {
  const account   = privateKeyToAccount(privateKey);
  const transport = http(RPC_URL);
  const pub = createPublicClient({ chain: baseSepolia, transport });
  const wal = createWalletClient({ account, chain: baseSepolia, transport });
  return { account, pub, wal };
}

async function ensureERC20Allowance(
  pub: ReturnType<typeof createPublicClient>,
  wal: ReturnType<typeof createWalletClient>,
  token: Address,
  owner: Address,
  spender: Address,
  amount: bigint,
) {
  const allowance = await pub.readContract({
    address: token, abi: ERC20_ABI, functionName: 'allowance', args: [owner, spender],
  }) as bigint;
  if (allowance < amount) {
    const hash = await wal.writeContract({
      address: token, abi: ERC20_ABI, functionName: 'approve', args: [spender, amount * 10n],
    });
    await pub.waitForTransactionReceipt({ hash, timeout: 60_000 });
  }
}

// ─── Auto-Execute from Bargaining ─────────────────────────────────────────────

/**
 * When an internal agent accepts a bargaining offer, create a new on-chain deal
 * at the agreed terms so the proposer can fill it.
 *
 * - Loan accepted → Delta deposits tWETH into BundleVault → createLoanOffer with Bundle NFT
 * - Option accepted → Epsilon writes a new covered call using tWETH as underlying
 *
 * Requires TEST_WETH_ADDRESS to be set in .env (after DeployTestTokens.s.sol is run).
 */
export async function autoExecuteAcceptedOffer(params: {
  acceptingAgentAddress: string;
  dealType: 'loan' | 'option';
  agreedTerms: {
    principal?: number;
    interestRate?: number;
    premium?: number;
    strike?: number;
  };
}): Promise<{ success: boolean; newDealId?: number; txHash?: string; error?: string }> {
  const agentKeys = loadInternalAgentKeys();
  const agentKey  = agentKeys[params.acceptingAgentAddress.toLowerCase()];
  if (!agentKey) {
    return { success: false, error: 'No server-side key for this agent — cannot auto-execute' };
  }

  const TEST_WETH = process.env.TEST_WETH_ADDRESS as Address | undefined;
  if (!TEST_WETH) {
    return { success: false, error: 'TEST_WETH_ADDRESS not configured — deploy test tokens first (forge script script/DeployTestTokens.s.sol)' };
  }

  const { account, pub, wal } = makeClients(agentKey);

  try {
    if (params.dealType === 'option') {
      const premium = parseUnits(String(params.agreedTerms.premium ?? 40), 6);
      const strike  = parseUnits(String(params.agreedTerms.strike ?? 2000), 6);
      const amount  = parseUnits('0.5', 18); // 0.5 tWETH as underlying
      const expiry  = BigInt(Math.floor(Date.now() / 1000) + 7 * 86400);

      await ensureERC20Allowance(pub, wal, TEST_WETH, account.address, CALL_VAULT, amount);

      const counterBefore = await pub.readContract({
        address: CALL_VAULT, abi: VAULT_ABI, functionName: 'optionCounter',
      }) as bigint;

      const hash = await wal.writeContract({
        address: CALL_VAULT, abi: VAULT_ABI, functionName: 'writeCoveredCall',
        args: [TEST_WETH, amount, strike, expiry, premium],
      });
      await pub.waitForTransactionReceipt({ hash, timeout: 60_000 });
      console.log(`[relay] Auto-executed option #${counterBefore} at premium ${params.agreedTerms.premium} USDC (0.5 tWETH underlying)`);
      return { success: true, txHash: hash, newDealId: Number(counterBefore) };
    }

    if (params.dealType === 'loan') {
      const principal  = parseUnits(String(params.agreedTerms.principal ?? 400), 6);
      const interest   = params.agreedTerms.interestRate
        ? parseUnits(String(Math.round((params.agreedTerms.principal ?? 400) * params.agreedTerms.interestRate / 100)), 6)
        : parseUnits('24', 6);
      const duration   = BigInt(14 * 86400);
      const wethAmount = parseUnits('0.5', 18); // 0.5 tWETH per bundle

      // Step 1: Approve tWETH to BundleVault
      await ensureERC20Allowance(pub, wal, TEST_WETH, account.address, BUNDLE_VAULT, wethAmount);

      // Step 2: Simulate to capture returned tokenId, then execute deposit
      const { result: bundleId } = await pub.simulateContract({
        address: BUNDLE_VAULT, abi: BUNDLE_VAULT_ABI, functionName: 'depositBundle',
        args: [[TEST_WETH], [wethAmount], [], [], ''],
        account: account.address,
      }) as { result: bigint };

      const depositHash = await wal.writeContract({
        address: BUNDLE_VAULT, abi: BUNDLE_VAULT_ABI, functionName: 'depositBundle',
        args: [[TEST_WETH], [wethAmount], [], [], ''],
      });
      await pub.waitForTransactionReceipt({ hash: depositHash, timeout: 60_000 });

      // Step 4: Approve Bundle NFT to LoanEngine
      const approveHash = await wal.writeContract({
        address: BUNDLE_VAULT, abi: BUNDLE_VAULT_ABI, functionName: 'approve',
        args: [LOAN_ENGINE, bundleId],
      });
      await pub.waitForTransactionReceipt({ hash: approveHash, timeout: 60_000 });

      // Step 5: Create loan offer using Bundle NFT as collateral
      const counterBefore = await pub.readContract({
        address: LOAN_ENGINE, abi: LOAN_ABI, functionName: 'loanCounter',
      }) as bigint;

      const hash = await wal.writeContract({
        address: LOAN_ENGINE, abi: LOAN_ABI, functionName: 'createLoanOffer',
        args: [BUNDLE_VAULT, bundleId, principal, interest, duration],
      });
      await pub.waitForTransactionReceipt({ hash, timeout: 60_000 });
      console.log(`[relay] Auto-executed loan #${counterBefore} at principal ${params.agreedTerms.principal} USDC (bundleId ${bundleId})`);
      return { success: true, txHash: hash, newDealId: Number(counterBefore) };
    }

    return { success: false, error: 'No applicable terms to auto-execute' };
  } catch (e: any) {
    return { success: false, error: e.shortMessage ?? e.message ?? String(e) };
  }
}