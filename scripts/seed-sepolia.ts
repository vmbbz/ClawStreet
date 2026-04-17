// @ts-nocheck — viem walletClient.writeContract type inference quirk in dev scripts
/**
 * scripts/seed-sepolia.ts
 *
 * Fires real Base Sepolia transactions from agent wallets to create
 * meaningful on-chain state that the ClawStreet UI can read and display.
 *
 * After running this script, /market and /portfolio will show real data
 * instead of mock placeholders.
 *
 * Prerequisites:
 *   1. Run: bash scripts/setup-agent-wallets.sh   (creates .env.agents)
 *   2. Run: bash scripts/bootstrap.sh              (deploys contracts + funds agents)
 *   3. Run: forge script script/DeployTestTokens.s.sol --broadcast
 *            then add TEST_WETH_ADDRESS, TEST_WBTC_ADDRESS, TEST_LINK_ADDRESS to .env
 *   4. Run: npm run seed
 *
 * Usage:
 *   npm run seed           — execute all seeding transactions
 *   npm run seed:check     — dry run (print plan without executing)
 *   npm run seed -- --only loans    — only seed loans
 *   npm run seed -- --only options  — only seed options
 *   npm run seed -- --only staking  — only seed staking
 *   npm run seed -- --only bundles  — only seed bundles
 */

import 'dotenv/config';
import { readFileSync, existsSync } from 'fs';
import { resolve } from 'path';
import {
  createPublicClient,
  createWalletClient,
  http,
  parseUnits,
  formatUnits,
  parseAbi,
  type Hash,
  type Address,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { baseSepolia } from 'viem/chains';

// ─── Config ──────────────────────────────────────────────────────────────────

const BASESCAN = 'https://sepolia.basescan.org';
const RPC_URL = process.env.VITE_BASE_SEPOLIA_RPC ?? 'https://sepolia.base.org';

const DRY_RUN = process.argv.includes('--dry-run');
const ONLY = (() => {
  const idx = process.argv.indexOf('--only');
  return idx !== -1 ? process.argv[idx + 1] : null;
})();

// ─── Contract addresses ───────────────────────────────────────────────────────

const LOAN_ENGINE  = '0x96C3291C9b0C34b007893326ee9dcA534BfcFa0c' as Address;
const CALL_VAULT   = '0x69730728a0B19b844bc18888d2317987Bc528baE' as Address;
const BUNDLE_VAULT = '0x86ef420fD3e27c3Ac896c479B19b6A840b97Bee1' as Address;
const CLAW_TOKEN   = '0xD11fC366828445B874F5202109E5f48C4D14FCe4' as Address;
const STAKING      = '0xADBf89BA38915B9CF18E0a24Ea3E27F39d920bd3' as Address;
const MOCK_USDC    = '0xDCf9936b330D6957CaD463f850D1F2B6F1eABc3A' as Address;
const MOCK_NFT     = '0x41119aAd1c69dba3934D0A061d312A52B06B27DF' as Address;

const TEST_WETH = (process.env.TEST_WETH_ADDRESS ?? '') as Address;
const TEST_WBTC = (process.env.TEST_WBTC_ADDRESS ?? '') as Address;

// ─── ABIs (minimal) ───────────────────────────────────────────────────────────

const ERC20_ABI = parseAbi([
  'function approve(address spender, uint256 amount) external returns (bool)',
  'function balanceOf(address account) external view returns (uint256)',
  'function allowance(address owner, address spender) external view returns (uint256)',
]);

const ERC721_ABI = parseAbi([
  'function setApprovalForAll(address operator, bool approved) external',
  'function approve(address to, uint256 tokenId) external',
  'function ownerOf(uint256 tokenId) external view returns (address)',
]);

const LOAN_ABI = parseAbi([
  'function createLoanOffer(address nftContract, uint256 nftId, uint256 principal, uint256 interest, uint256 duration) external',
  'function acceptLoan(uint256 loanId, bytes[] calldata priceUpdateData) external payable',
  'function loanCounter() external view returns (uint256)',
]);

const CALL_VAULT_ABI = parseAbi([
  'function writeCoveredCall(address underlying, uint256 amount, uint256 strike, uint256 expiry, uint256 premium) external returns (uint256)',
  'function buyOption(uint256 optionId) external',
  'function optionCounter() external view returns (uint256)',
]);

const BUNDLE_VAULT_ABI = parseAbi([
  'function depositBundle(address[] calldata erc20Tokens, uint256[] calldata erc20Amounts, address[] calldata erc721Contracts, uint256[] calldata erc721Ids, string calldata metadataURI) external returns (uint256)',
]);

const STAKING_ABI = parseAbi([
  'function stake(uint256 amount) external',
  'function positions(address staker) external view returns (uint256 staked, uint256 stakedAt, uint256 rewardDebt, uint256 passId, bool hasPass)',
]);

// ─── Load agent keys ─────────────────────────────────────────────────────────

function loadAgentKeys(): Record<string, string> {
  const envAgentsPath = resolve(process.cwd(), '.env.agents');
  if (!existsSync(envAgentsPath)) {
    console.error('❌ .env.agents not found. Run: bash scripts/setup-agent-wallets.sh');
    process.exit(1);
  }

  const content = readFileSync(envAgentsPath, 'utf-8');
  const keys: Record<string, string> = {};
  for (const line of content.split('\n')) {
    if (line.startsWith('#') || !line.includes('=')) continue;
    const [k, v] = line.trim().split('=');
    keys[k] = v;
  }
  return keys;
}

// ─── Pyth VAA fetcher ────────────────────────────────────────────────────────

const ETH_USD_FEED = '0xff61491a931112ddf1bd8147cd1b641375f79f5825126d665480874634fd0ace';
const PYTH_ORACLE  = '0xA2aa501b19aff244D90cc15a4Cf739D2725B5729' as Address;

const PYTH_ABI = parseAbi([
  'function getUpdateFee(bytes[] calldata updateData) external view returns (uint256 feeAmount)',
]);

async function fetchPythVAA(): Promise<`0x${string}`[]> {
  try {
    const res = await fetch(
      `https://hermes.pyth.network/v2/updates/price/latest?ids[]=${ETH_USD_FEED}&encoding=hex`
    );
    const data = await res.json() as { binary?: { data: string[] } };
    return (data.binary?.data ?? []).map(d => `0x${d}` as `0x${string}`);
  } catch (e) {
    console.warn('⚠️  Pyth VAA fetch failed — using empty array (loan acceptance may fail):', e);
    return [];
  }
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function txLink(hash: Hash) {
  return `${BASESCAN}/tx/${hash}`;
}

async function waitAndLog(
  publicClient: ReturnType<typeof createPublicClient>,
  hash: Hash,
  label: string
) {
  console.log(`  ⏳ ${label} — waiting for confirmation...`);
  const receipt = await publicClient.waitForTransactionReceipt({ hash, timeout: 60_000 });
  const status = receipt.status === 'success' ? '✅' : '❌';
  console.log(`  ${status} ${label}`);
  console.log(`     ${txLink(hash)}`);
  if (receipt.status !== 'success') throw new Error(`Transaction failed: ${hash}`);
  return receipt;
}

function section(title: string) {
  console.log(`\n${'─'.repeat(60)}`);
  console.log(`  ${title}`);
  console.log('─'.repeat(60));
}

// ─── Main ────────────────────────────────────────────────────────────────────

async function main() {
  console.log('\n🦞 ClawStreet — Base Sepolia Seed Script');
  console.log(`   RPC: ${RPC_URL}`);
  if (DRY_RUN) console.log('   MODE: DRY RUN (no transactions will be sent)');
  if (ONLY) console.log(`   ONLY: ${ONLY}`);

  const agentKeys = loadAgentKeys();

  // Create accounts
  const alpha   = privateKeyToAccount(agentKeys['AGENT1_PRIVATE_KEY'] as `0x${string}`);  // LiquidityAgent
  const beta    = privateKeyToAccount(agentKeys['AGENT2_PRIVATE_KEY'] as `0x${string}`);  // ArbitrageAgent
  const gamma   = privateKeyToAccount(agentKeys['AGENT3_PRIVATE_KEY'] as `0x${string}`);  // LendingAgent
  const delta   = privateKeyToAccount(agentKeys['AGENT4_PRIVATE_KEY'] as `0x${string}`);  // BorrowerAgent
  const epsilon = privateKeyToAccount(agentKeys['AGENT5_PRIVATE_KEY'] as `0x${string}`);  // HedgeAgent

  const transport = http(RPC_URL);
  const publicClient = createPublicClient({ chain: baseSepolia, transport });

  const wallets = {
    alpha:   createWalletClient({ account: alpha,   chain: baseSepolia, transport }),
    beta:    createWalletClient({ account: beta,    chain: baseSepolia, transport }),
    gamma:   createWalletClient({ account: gamma,   chain: baseSepolia, transport }),
    delta:   createWalletClient({ account: delta,   chain: baseSepolia, transport }),
    epsilon: createWalletClient({ account: epsilon, chain: baseSepolia, transport }),
  };

  console.log('\n📋 Agent Addresses:');
  console.log(`   Alpha   (Market Maker):   ${alpha.address}`);
  console.log(`   Beta    (Arbitrageur):    ${beta.address}`);
  console.log(`   Gamma   (Lender):         ${gamma.address}`);
  console.log(`   Delta   (Borrower):       ${delta.address}`);
  console.log(`   Epsilon (Options Writer): ${epsilon.address}`);

  // Check current counters
  const loanCounter   = await publicClient.readContract({ address: LOAN_ENGINE,  abi: LOAN_ABI,      functionName: 'loanCounter' });
  const optionCounter = await publicClient.readContract({ address: CALL_VAULT,   abi: CALL_VAULT_ABI, functionName: 'optionCounter' });

  console.log(`\n📊 Current on-chain state:`);
  console.log(`   Loans:   ${loanCounter}`);
  console.log(`   Options: ${optionCounter}`);

  if (DRY_RUN) {
    console.log('\n✅ Dry run complete. Run without --dry-run to execute transactions.');
    console.log('\nPlanned transactions:');
    console.log('  [LOANS]   Delta: createLoanOffer(MockNFT #1, 500 USDC, 14d, 30 USDC)');
    console.log('  [LOANS]   Gamma: approve USDC → acceptLoan(loanId, pythVAA)');
    console.log('  [LOANS]   Delta: createLoanOffer(MockNFT #2, 300 USDC, 30d, 21 USDC) [unfunded]');
    if (TEST_WETH) {
      console.log('  [BUNDLE]  Delta: approve TestWETH → approve MockNFT → depositBundle');
      console.log('  [LOANS]   Delta: createLoanOffer(BundleNFT, 800 USDC, 21d, 56 USDC) [unfunded]');
    }
    console.log('  [OPTIONS] Epsilon: approve TestWETH/STREET → writeCoveredCall(TestWETH, 1 ETH, $2000, 7d, 50 USDC)');
    console.log('  [OPTIONS] Beta: approve USDC → buyOption(optionId)');
    console.log('  [STAKING] Alpha: approve STREET → stake(10,000 STREET)');
    return;
  }

  // ── Fetch Pyth VAA upfront ────────────────────────────────────────────────
  console.log('\n🔮 Fetching Pyth price update (ETH/USD)...');
  const priceVAA = await fetchPythVAA();
  console.log(`   VAA bytes: ${priceVAA.length > 0 ? priceVAA[0].slice(0, 20) + '...' : 'none (empty)'}`);

  // Query actual Pyth update fee (avoids "Insufficient fee for Pyth" revert)
  let pythFee = 0n;
  if (priceVAA.length > 0) {
    try {
      pythFee = await publicClient.readContract({
        address: PYTH_ORACLE, abi: PYTH_ABI,
        functionName: 'getUpdateFee',
        args: [priceVAA],
      });
      console.log(`   Pyth update fee: ${pythFee} wei`);
    } catch {
      pythFee = 100n; // fallback: 100 wei covers typical 10 wei fee
      console.warn(`   ⚠️  Could not query Pyth fee — using ${pythFee} wei fallback`);
    }
  }

  const results: { label: string; hash: Hash }[] = [];

  // ── LOANS ─────────────────────────────────────────────────────────────────

  if (!ONLY || ONLY === 'loans') {
    section('LOANS');

    // Re-read loanCounter (may have changed since script started)
    const currentLoanCount = await publicClient.readContract({ address: LOAN_ENGINE, abi: LOAN_ABI, functionName: 'loanCounter' });
    let nextLoanId = currentLoanCount;
    let h: Hash;

    // Grant LoanEngine operator approval for all Delta's NFTs upfront (simpler + avoids tokenId-level race conditions)
    const isApprovedForAll = await publicClient.readContract({
      address: MOCK_NFT,
      abi: parseAbi(['function isApprovedForAll(address owner, address operator) external view returns (bool)']),
      functionName: 'isApprovedForAll',
      args: [delta.address, LOAN_ENGINE],
    });
    if (!isApprovedForAll) {
      console.log('\n  → Setting LoanEngine as operator for all Delta NFTs...');
      const hApprAll = await wallets.delta.writeContract({
        address: MOCK_NFT, abi: ERC721_ABI,
        functionName: 'setApprovalForAll',
        args: [LOAN_ENGINE, true],
      });
      await waitAndLog(publicClient, hApprAll, 'Delta: setApprovalForAll(LoanEngine, true)');
      results.push({ label: 'Delta: setApprovalForAll', hash: hApprAll });
    } else {
      console.log('\n  → LoanEngine already approved for all Delta NFTs');
    }

    // ── Loan 0: Delta creates (NFT #1, 500 USDC, 14d), Gamma funds it ───────
    console.log(`\n[1/3] Loan #0 (NFT #1, 500 USDC, 14d) — current counter: ${currentLoanCount}`);
    if (currentLoanCount === 0n) {
      // Need to create it (no token-level approve needed — setApprovalForAll handles it)

      h = await wallets.delta.writeContract({
        address: LOAN_ENGINE, abi: LOAN_ABI,
        functionName: 'createLoanOffer',
        args: [MOCK_NFT, 1n, parseUnits('500', 6), parseUnits('30', 6), BigInt(14 * 86400)],
      });
      await waitAndLog(publicClient, h, 'Delta: createLoanOffer #0 (500 USDC, 14d)');
      results.push({ label: 'Delta: createLoanOffer #0', hash: h });
      nextLoanId = 1n;
    } else {
      console.log('  ⏭️  Loan #0 already created — skipping createLoanOffer');
    }

    // Check if loan #0 is still unfunded (lender == 0x0)
    const loan0 = await publicClient.readContract({ address: LOAN_ENGINE, abi: parseAbi(['function loans(uint256 loanId) external view returns (address borrower, address lender, address nftContract, uint256 nftId, uint256 principal, uint256 interest, uint256 duration, uint256 startTime, uint256 healthSnapshot, bool active, bool repaid)']), functionName: 'loans', args: [0n] });
    const loan0Lender = (loan0 as any)[1] as string;
    const loan0Active = (loan0 as any)[9] as boolean;

    if (loan0Active && loan0Lender === '0x0000000000000000000000000000000000000000') {
      console.log('\n   Loan #0 is unfunded — Gamma will fund it');
      h = await wallets.gamma.writeContract({
        address: MOCK_USDC, abi: ERC20_ABI,
        functionName: 'approve',
        args: [LOAN_ENGINE, parseUnits('1000', 6)],
      });
      await waitAndLog(publicClient, h, 'Gamma: approve 1000 USDC → LoanEngine');
      results.push({ label: 'Gamma: approve USDC', hash: h });

      h = await wallets.gamma.writeContract({
        address: LOAN_ENGINE, abi: LOAN_ABI,
        functionName: 'acceptLoan',
        args: [0n, priceVAA],
        value: pythFee,
      });
      await waitAndLog(publicClient, h, 'Gamma: acceptLoan #0 ✨ ACTIVE LOAN CREATED');
      results.push({ label: 'Gamma: acceptLoan #0', hash: h });
    } else {
      console.log('  ⏭️  Loan #0 already funded or inactive — skipping acceptLoan');
    }

    // ── Loan 1: Delta creates (NFT #2, 300 USDC, 30d), unfunded ─────────────
    console.log('\n[2/3] Loan #1 (NFT #2, 300 USDC, 30d) — open listing');
    if (nextLoanId <= 1n) {
      h = await wallets.delta.writeContract({
        address: LOAN_ENGINE, abi: LOAN_ABI,
        functionName: 'createLoanOffer',
        args: [MOCK_NFT, 2n, parseUnits('300', 6), parseUnits('21', 6), BigInt(30 * 86400)],
      });
      await waitAndLog(publicClient, h, 'Delta: createLoanOffer #1 (300 USDC, 30d)');
      results.push({ label: 'Delta: createLoanOffer #1', hash: h });
      nextLoanId = 2n;
    } else {
      console.log('  ⏭️  Loan #1 already created — skipping');
    }

    // ── Loan 2: Delta creates (NFT #3, 750 USDC, 21d), unfunded ─────────────
    console.log('\n[3/3] Loan #2 (NFT #3, 750 USDC, 21d) — open listing');
    try {
      if (nextLoanId <= 2n) {
      h = await wallets.delta.writeContract({
        address: LOAN_ENGINE, abi: LOAN_ABI,
        functionName: 'createLoanOffer',
        args: [MOCK_NFT, 3n, parseUnits('750', 6), parseUnits('45', 6), BigInt(21 * 86400)],
      });
      await waitAndLog(publicClient, h, 'Delta: createLoanOffer #2 (750 USDC, 21d)');
      results.push({ label: 'Delta: createLoanOffer #2', hash: h });
      } else {
        console.log('  ⏭️  Loan #2 already created — skipping');
      }
    } catch (e) {
      console.warn('  ⚠️  Loan #2 skipped (NFT #3 may not be available):', (e as Error).message);
    }
  }

  // ── BUNDLE + BUNDLED LOAN ─────────────────────────────────────────────────

  if (!ONLY || ONLY === 'bundles') {
    if (!TEST_WETH) {
      console.log('\n⚠️  Skipping bundle seeding — TEST_WETH_ADDRESS not set in .env');
      console.log('   Deploy test tokens first: forge script script/DeployTestTokens.s.sol --broadcast');
    } else {
      section('BUNDLE VAULT');

      console.log('\n[1/2] Delta → bundle [0.5 TestWETH + MockNFT #4] into BundleVault');

      let h: Hash;
      // Approve TestWETH to BundleVault
      h = await wallets.delta.writeContract({
        address: TEST_WETH, abi: ERC20_ABI,
        functionName: 'approve',
        args: [BUNDLE_VAULT, parseUnits('0.5', 18)],
      });
      await waitAndLog(publicClient, h, 'Delta: approve 0.5 tWETH → BundleVault');
      results.push({ label: 'Delta: approve tWETH', hash: h });

      // Approve NFT #4 to BundleVault
      h = await wallets.delta.writeContract({
        address: MOCK_NFT, abi: ERC721_ABI,
        functionName: 'approve',
        args: [BUNDLE_VAULT, 4n],
      });
      await waitAndLog(publicClient, h, 'Delta: approve NFT #4 → BundleVault');
      results.push({ label: 'Delta: approve NFT #4 to bundle', hash: h });

      // Deposit bundle
      h = await wallets.delta.writeContract({
        address: BUNDLE_VAULT, abi: BUNDLE_VAULT_ABI,
        functionName: 'depositBundle',
        args: [
          [TEST_WETH],
          [parseUnits('0.5', 18)],
          [MOCK_NFT],
          [4n],
          'ipfs://QmClawStreetBundle001',
        ],
      });
      await waitAndLog(publicClient, h, 'Delta: depositBundle (0.5 tWETH + NFT #4) ✨ BUNDLE NFT CREATED');
      results.push({ label: 'Delta: depositBundle', hash: h });

      console.log('\n[2/2] Delta → createLoanOffer using bundle NFT as collateral');
      // Bundle NFT ID starts at 1 (first deposit)
      // We'll use bundle token ID 1
      h = await wallets.delta.writeContract({
        address: BUNDLE_VAULT, abi: parseAbi(['function approve(address to, uint256 tokenId) external']),
        functionName: 'approve',
        args: [LOAN_ENGINE, 1n],
      });
      await waitAndLog(publicClient, h, 'Delta: approve BundleNFT #1 → LoanEngine');
      results.push({ label: 'Delta: approve bundle NFT', hash: h });

      h = await wallets.delta.writeContract({
        address: LOAN_ENGINE, abi: LOAN_ABI,
        functionName: 'createLoanOffer',
        args: [BUNDLE_VAULT, 1n, parseUnits('800', 6), parseUnits('56', 6), BigInt(21 * 86400)],
      });
      await waitAndLog(publicClient, h, 'Delta: createLoanOffer backed by BundleNFT (800 USDC, 21d)');
      results.push({ label: 'Delta: bundled loan offer', hash: h });
    }
  }

  // ── OPTIONS ───────────────────────────────────────────────────────────────

  if (!ONLY || ONLY === 'options') {
    section('OPTIONS (CallVault)');

    if (!TEST_WETH) {
      console.log('⚠️  TEST_WETH_ADDRESS not set — using STREET token as underlying instead');
    }

    const underlying = TEST_WETH || CLAW_TOKEN;
    const underlyingDecimals = TEST_WETH ? 18 : 18;
    const underlyingName = TEST_WETH ? 'TestWETH' : 'STREET';

    console.log(`\n[1/2] Epsilon → writeCoveredCall(${underlyingName}, 1 token, strike=2000 USDC, 7d, premium=50 USDC)`);

    let h: Hash;
    h = await wallets.epsilon.writeContract({
      address: underlying, abi: ERC20_ABI,
      functionName: 'approve',
      args: [CALL_VAULT, parseUnits('1', underlyingDecimals)],
    });
    await waitAndLog(publicClient, h, `Epsilon: approve 1 ${underlyingName} → CallVault`);
    results.push({ label: `Epsilon: approve ${underlyingName}`, hash: h });

    // approve USDC for premium (CallVault collects USDC premium)
    h = await wallets.epsilon.writeContract({
      address: MOCK_USDC, abi: ERC20_ABI,
      functionName: 'approve',
      args: [CALL_VAULT, parseUnits('100', 6)],
    });
    await waitAndLog(publicClient, h, 'Epsilon: approve USDC → CallVault (for fee)');
    results.push({ label: 'Epsilon: approve USDC for call', hash: h });

    const expiry = BigInt(Math.floor(Date.now() / 1000) + 7 * 86400);
    h = await wallets.epsilon.writeContract({
      address: CALL_VAULT, abi: CALL_VAULT_ABI,
      functionName: 'writeCoveredCall',
      args: [
        underlying,
        parseUnits('1', underlyingDecimals),
        parseUnits('2000', 6),   // strike: 2000 USDC
        expiry,
        parseUnits('50', 6),     // premium: 50 USDC
      ],
    });
    await waitAndLog(publicClient, h, 'Epsilon: writeCoveredCall ✨ OPTION WRITTEN');
    results.push({ label: 'Epsilon: writeCoveredCall', hash: h });

    const option1Id = optionCounter;
    console.log(`\n[2/2] Beta → buyOption(${option1Id}) — 50 USDC premium`);

    h = await wallets.beta.writeContract({
      address: MOCK_USDC, abi: ERC20_ABI,
      functionName: 'approve',
      args: [CALL_VAULT, parseUnits('50', 6)],
    });
    await waitAndLog(publicClient, h, 'Beta: approve 50 USDC → CallVault');
    results.push({ label: 'Beta: approve USDC for option', hash: h });

    h = await wallets.beta.writeContract({
      address: CALL_VAULT, abi: CALL_VAULT_ABI,
      functionName: 'buyOption',
      args: [option1Id],
    });
    await waitAndLog(publicClient, h, `Beta: buyOption #${option1Id} ✨ OPTION SOLD`);
    results.push({ label: `Beta: buyOption #${option1Id}`, hash: h });

    // Second option: Epsilon writes another call — open listing (not bought)
    console.log('\n[BONUS] Epsilon → writeCoveredCall #2 (open listing, not purchased)');
    try {
      h = await wallets.epsilon.writeContract({
        address: underlying, abi: ERC20_ABI,
        functionName: 'approve',
        args: [CALL_VAULT, parseUnits('0.5', underlyingDecimals)],
      });
      await waitAndLog(publicClient, h, `Epsilon: approve 0.5 ${underlyingName} → CallVault`);
      results.push({ label: 'Epsilon: approve second call', hash: h });

      const expiry2 = BigInt(Math.floor(Date.now() / 1000) + 14 * 86400);
      h = await wallets.epsilon.writeContract({
        address: CALL_VAULT, abi: CALL_VAULT_ABI,
        functionName: 'writeCoveredCall',
        args: [
          underlying,
          parseUnits('0.5', underlyingDecimals),
          parseUnits('2500', 6),  // higher strike
          expiry2,
          parseUnits('30', 6),    // lower premium
        ],
      });
      await waitAndLog(publicClient, h, 'Epsilon: writeCoveredCall #2 (open, 14d expiry)');
      results.push({ label: 'Epsilon: writeCoveredCall #2', hash: h });
    } catch (e) {
      console.warn('  ⚠️  Second call option skipped:', (e as Error).message);
    }
  }

  // ── STAKING ───────────────────────────────────────────────────────────────

  if (!ONLY || ONLY === 'staking') {
    section('STAKING');

    console.log('\n[1/1] Alpha → stake 10,000 STREET (gets ClawPass NFT)');

    const stakeAmount = parseUnits('10000', 18);

    const balance = await publicClient.readContract({
      address: CLAW_TOKEN, abi: ERC20_ABI,
      functionName: 'balanceOf',
      args: [alpha.address],
    });
    console.log(`   Alpha STREET balance: ${formatUnits(balance, 18)}`);

    if (balance < stakeAmount) {
      console.warn(`  ⚠️  Alpha has insufficient STREET (${formatUnits(balance, 18)} < 10,000). Skipping stake.`);
    } else {
      let h: Hash;
      h = await wallets.alpha.writeContract({
        address: CLAW_TOKEN, abi: ERC20_ABI,
        functionName: 'approve',
        args: [STAKING, stakeAmount],
      });
      await waitAndLog(publicClient, h, 'Alpha: approve 10,000 STREET → Staking');
      results.push({ label: 'Alpha: approve STREET', hash: h });

      h = await wallets.alpha.writeContract({
        address: STAKING, abi: STAKING_ABI,
        functionName: 'stake',
        args: [stakeAmount],
      });
      await waitAndLog(publicClient, h, 'Alpha: stake 10,000 STREET ✨ CLAWPASS NFT MINTED');
      results.push({ label: 'Alpha: stake STREET', hash: h });
    }
  }

  // ── Summary ───────────────────────────────────────────────────────────────

  const newLoanCounter   = await publicClient.readContract({ address: LOAN_ENGINE, abi: LOAN_ABI, functionName: 'loanCounter' });
  const newOptionCounter = await publicClient.readContract({ address: CALL_VAULT, abi: CALL_VAULT_ABI, functionName: 'optionCounter' });

  console.log('\n' + '═'.repeat(60));
  console.log('  🦞 SEED COMPLETE');
  console.log('═'.repeat(60));
  console.log(`\n  Loans on-chain:   ${loanCounter} → ${newLoanCounter}`);
  console.log(`  Options on-chain: ${optionCounter} → ${newOptionCounter}`);
  console.log(`\n  ${results.length} transactions confirmed:`);
  results.forEach(({ label, hash }) => {
    console.log(`    ✅ ${label}`);
    console.log(`       ${txLink(hash)}`);
  });

  console.log('\n  Next: refresh the ClawStreet UI at /market');
  console.log('  All pages now show real on-chain data.\n');
}

main().catch(e => {
  console.error('\n❌ Seed failed:', e);
  process.exit(1);
});
