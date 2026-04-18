/**
 * deal-relay.ts — Server-side on-chain execution
 *
 * Two modes:
 * 1. Gas relay  — broadcast a tx on behalf of an external agent
 *                 (they sign an EIP-191 intent, server wallet pays gas)
 * 2. Auto-execute — when an internal agent accepts a bargaining offer,
 *                   create a new on-chain deal at the agreed terms so the
 *                   proposer can fill it immediately
 *
 * Note on msg.sender: The relay broadcasts from the server's RELAYER_PRIVATE_KEY
 * wallet, so on-chain the deal creator/filler is the relayer address, not the
 * external agent. The signature proves intent; this is a known testnet trade-off
 * without EIP-2771 meta-tx support in the contracts.
 */

import 'dotenv/config';
import {
  createPublicClient, createWalletClient, http, parseAbi, parseUnits,
  recoverMessageAddress, type Address,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { baseSepolia } from 'viem/chains';
import { existsSync, readFileSync } from 'fs';
import { resolve } from 'path';

// ─── Contracts ────────────────────────────────────────────────────────────────

const LOAN_ENGINE = '0x96C3291C9b0C34b007893326ee9dcA534BfcFa0c' as Address;
const CALL_VAULT  = '0x69730728a0B19b844bc18888d2317987Bc528baE' as Address;
const MOCK_USDC   = '0xDCf9936b330D6957CaD463f850D1F2B6F1eABc3A' as Address;
const CLAW_TOKEN  = '0xD11fC366828445B874F5202109E5f48C4D14FCe4' as Address;
const MOCK_NFT    = '0x41119aAd1c69dba3934D0A061d312A52B06B27DF' as Address;
const RPC_URL     = process.env.BASE_SEPOLIA_RPC ?? 'https://sepolia.base.org';

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

const ERC20_ABI = parseAbi([
  'function approve(address spender, uint256 amount) external returns (bool)',
  'function allowance(address owner, address spender) external view returns (uint256)',
  'function balanceOf(address) external view returns (uint256)',
]);

const ERC721_ABI = parseAbi([
  'function isApprovedForAll(address owner, address operator) external view returns (bool)',
  'function setApprovalForAll(address operator, bool approved) external',
  'function ownerOf(uint256 tokenId) external view returns (address)',
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

// ─── Relay intent message builder ─────────────────────────────────────────────

export function buildRelayIntentMessage(params: {
  type: string;
  params: Record<string, unknown>;
  timestamp: number;
}): string {
  return [
    'ClawStreet Deal Relay',
    `Type: ${params.type}`,
    `Params: ${JSON.stringify(params.params)}`,
    `Timestamp: ${params.timestamp}`,
  ].join('\n');
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

async function ensureNFTApproval(
  pub: ReturnType<typeof createPublicClient>,
  wal: ReturnType<typeof createWalletClient>,
  nft: Address,
  owner: Address,
  operator: Address,
) {
  const approved = await pub.readContract({
    address: nft, abi: ERC721_ABI, functionName: 'isApprovedForAll', args: [owner, operator],
  }) as boolean;
  if (!approved) {
    const hash = await wal.writeContract({
      address: nft, abi: ERC721_ABI, functionName: 'setApprovalForAll', args: [operator, true],
    });
    await pub.waitForTransactionReceipt({ hash, timeout: 60_000 });
  }
}

async function findOwnedNFT(pub: ReturnType<typeof createPublicClient>, owner: Address): Promise<bigint | null> {
  for (let id = 1n; id <= 20n; id++) {
    try {
      const o = await pub.readContract({
        address: MOCK_NFT, abi: ERC721_ABI, functionName: 'ownerOf', args: [id],
      }) as Address;
      if (o.toLowerCase() === owner.toLowerCase()) return id;
    } catch {}
  }
  return null;
}

// ─── Gas Relay ────────────────────────────────────────────────────────────────

export type RelayType = 'loan_offer' | 'covered_call' | 'accept_loan' | 'buy_option';

export interface RelayRequest {
  from: string;
  type: RelayType;
  params: Record<string, unknown>;
  timestamp: number;
  signature: `0x${string}`;
}

export async function relayDeal(req: RelayRequest): Promise<{
  success: boolean; txHash?: string; dealId?: number; relayedBy?: string; error?: string;
}> {
  // Verify timestamp
  const drift = Math.abs(Math.floor(Date.now() / 1000) - req.timestamp);
  if (drift > 300) return { success: false, error: 'Timestamp drift > 5 min' };

  // Verify EIP-191 signature
  const message = buildRelayIntentMessage({ type: req.type, params: req.params, timestamp: req.timestamp });
  try {
    const recovered = await recoverMessageAddress({ message, signature: req.signature });
    if (recovered.toLowerCase() !== req.from.toLowerCase()) {
      return { success: false, error: 'Signature does not match from address' };
    }
  } catch {
    return { success: false, error: 'Invalid signature' };
  }

  const relayerKey = process.env.RELAYER_PRIVATE_KEY as `0x${string}` | undefined;
  if (!relayerKey) return { success: false, error: 'Relay not configured — RELAYER_PRIVATE_KEY not set' };

  const { account, pub, wal } = makeClients(relayerKey);

  try {
    // ── buy_option ──────────────────────────────────────────────────────────
    if (req.type === 'buy_option') {
      const optionId = BigInt(req.params.optionId as number);
      const optionCount = await pub.readContract({
        address: CALL_VAULT, abi: VAULT_ABI, functionName: 'optionCounter',
      }) as bigint;
      if (optionId >= optionCount) return { success: false, error: `Option #${optionId} does not exist` };

      // Get premium from contract to ensure sufficient USDC
      const opt = await pub.readContract({
        address: CALL_VAULT, abi: VAULT_ABI, functionName: 'options', args: [optionId],
      }) as any[];
      const premium = opt[6] as bigint;

      await ensureERC20Allowance(pub, wal, MOCK_USDC, account.address, CALL_VAULT, premium);

      const hash = await wal.writeContract({
        address: CALL_VAULT, abi: VAULT_ABI, functionName: 'buyOption', args: [optionId],
      });
      await pub.waitForTransactionReceipt({ hash, timeout: 60_000 });
      return { success: true, txHash: hash, dealId: Number(optionId), relayedBy: account.address };
    }

    // ── accept_loan ─────────────────────────────────────────────────────────
    if (req.type === 'accept_loan') {
      const loanId = BigInt(req.params.loanId as number);
      const loanCount = await pub.readContract({
        address: LOAN_ENGINE, abi: LOAN_ABI, functionName: 'loanCounter',
      }) as bigint;
      if (loanId >= loanCount) return { success: false, error: `Loan #${loanId} does not exist` };

      const loan = await pub.readContract({
        address: LOAN_ENGINE, abi: LOAN_ABI, functionName: 'loans', args: [loanId],
      }) as any[];
      if (!loan[9]) return { success: false, error: `Loan #${loanId} is not active` };
      if (loan[1] !== '0x0000000000000000000000000000000000000000') {
        return { success: false, error: `Loan #${loanId} already funded` };
      }
      const principal = loan[4] as bigint;
      await ensureERC20Allowance(pub, wal, MOCK_USDC, account.address, LOAN_ENGINE, principal);

      const hash = await wal.writeContract({
        address: LOAN_ENGINE, abi: LOAN_ABI, functionName: 'acceptLoan', args: [loanId, []],
      });
      await pub.waitForTransactionReceipt({ hash, timeout: 60_000 });
      return { success: true, txHash: hash, dealId: Number(loanId), relayedBy: account.address };
    }

    // ── covered_call ────────────────────────────────────────────────────────
    if (req.type === 'covered_call') {
      const underlying = (req.params.underlying as string ?? CLAW_TOKEN) as Address;
      const amount     = parseUnits(String(req.params.amount ?? 1), 18);
      const strike     = parseUnits(String(req.params.strike), 6);
      const premium    = parseUnits(String(req.params.premium), 6);
      const expiry     = BigInt(Math.floor(Date.now() / 1000) + Number(req.params.expiryDays ?? 7) * 86400);

      await ensureERC20Allowance(pub, wal, underlying, account.address, CALL_VAULT, amount);

      const counterBefore = await pub.readContract({
        address: CALL_VAULT, abi: VAULT_ABI, functionName: 'optionCounter',
      }) as bigint;

      const hash = await wal.writeContract({
        address: CALL_VAULT, abi: VAULT_ABI, functionName: 'writeCoveredCall',
        args: [underlying, amount, strike, expiry, premium],
      });
      await pub.waitForTransactionReceipt({ hash, timeout: 60_000 });
      return { success: true, txHash: hash, dealId: Number(counterBefore), relayedBy: account.address };
    }

    // ── loan_offer ──────────────────────────────────────────────────────────
    if (req.type === 'loan_offer') {
      const nftContract = (req.params.nftContract as string ?? MOCK_NFT) as Address;
      const principal   = parseUnits(String(req.params.principal), 6);
      const interest    = parseUnits(String(req.params.interest), 6);
      const duration    = BigInt(Number(req.params.durationDays ?? 14) * 86400);

      const nftId = await findOwnedNFT(pub, account.address);
      if (!nftId) return { success: false, error: 'Relayer has no available NFT to use as collateral' };

      await ensureNFTApproval(pub, wal, nftContract, account.address, LOAN_ENGINE);

      const counterBefore = await pub.readContract({
        address: LOAN_ENGINE, abi: LOAN_ABI, functionName: 'loanCounter',
      }) as bigint;

      const hash = await wal.writeContract({
        address: LOAN_ENGINE, abi: LOAN_ABI, functionName: 'createLoanOffer',
        args: [nftContract, nftId, principal, interest, duration],
      });
      await pub.waitForTransactionReceipt({ hash, timeout: 60_000 });
      return { success: true, txHash: hash, dealId: Number(counterBefore), relayedBy: account.address };
    }

    return { success: false, error: `Unknown relay type: ${req.type}` };
  } catch (e: any) {
    return { success: false, error: e.shortMessage ?? e.message ?? String(e) };
  }
}

// ─── Auto-Execute from Bargaining ─────────────────────────────────────────────

/**
 * When an internal agent accepts a bargaining offer, create a new on-chain deal
 * at the agreed terms so the proposer can fill it.
 *
 * - Loan accepted → Delta creates new createLoanOffer at agreed principal/interest
 * - Option accepted → Epsilon creates new writeCoveredCall at agreed premium/strike
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

  const { account, pub, wal } = makeClients(agentKey);

  try {
    if (params.dealType === 'option') {
      const premium    = parseUnits(String(params.agreedTerms.premium ?? 40), 6);
      const strike     = parseUnits(String(params.agreedTerms.strike ?? 2000), 6);
      const amount     = parseUnits('1', 18);
      const expiry     = BigInt(Math.floor(Date.now() / 1000) + 7 * 86400);

      await ensureERC20Allowance(pub, wal, CLAW_TOKEN, account.address, CALL_VAULT, amount);

      const counterBefore = await pub.readContract({
        address: CALL_VAULT, abi: VAULT_ABI, functionName: 'optionCounter',
      }) as bigint;

      const hash = await wal.writeContract({
        address: CALL_VAULT, abi: VAULT_ABI, functionName: 'writeCoveredCall',
        args: [CLAW_TOKEN, amount, strike, expiry, premium],
      });
      await pub.waitForTransactionReceipt({ hash, timeout: 60_000 });
      console.log(`[relay] Auto-executed option #${counterBefore} at premium ${params.agreedTerms.premium} USDC`);
      return { success: true, txHash: hash, newDealId: Number(counterBefore) };
    }

    if (params.dealType === 'loan') {
      const principal = parseUnits(String(params.agreedTerms.principal ?? 400), 6);
      const interest  = params.agreedTerms.interestRate
        ? parseUnits(String(Math.round((params.agreedTerms.principal ?? 400) * params.agreedTerms.interestRate / 100)), 6)
        : parseUnits('24', 6);
      const duration  = BigInt(14 * 86400);

      const nftId = await findOwnedNFT(pub, account.address);
      if (!nftId) return { success: false, error: 'No available NFT for auto-executed loan' };

      await ensureNFTApproval(pub, wal, MOCK_NFT, account.address, LOAN_ENGINE);

      const counterBefore = await pub.readContract({
        address: LOAN_ENGINE, abi: LOAN_ABI, functionName: 'loanCounter',
      }) as bigint;

      const hash = await wal.writeContract({
        address: LOAN_ENGINE, abi: LOAN_ABI, functionName: 'createLoanOffer',
        args: [MOCK_NFT, nftId, principal, interest, duration],
      });
      await pub.waitForTransactionReceipt({ hash, timeout: 60_000 });
      console.log(`[relay] Auto-executed loan #${counterBefore} at principal ${params.agreedTerms.principal} USDC`);
      return { success: true, txHash: hash, newDealId: Number(counterBefore) };
    }

    return { success: false, error: 'No applicable terms to auto-execute' };
  } catch (e: any) {
    return { success: false, error: e.shortMessage ?? e.message ?? String(e) };
  }
}
