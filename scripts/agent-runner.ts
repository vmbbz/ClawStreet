// @ts-nocheck
/**
 * scripts/agent-runner.ts
 *
 * Continuous Test Protocol (CTP) — Automation Daemon
 *
 * Cycles through: planning → executing → open_window → monitoring → settling → reporting → idle
 * External agents/humans can participate during the open window via the Market UI.
 *
 * Usage:
 *   npm run runner:once      — one cycle then exit
 *   npm run runner:dev       — cycle every 5min, 60s open window (dev mode)
 *   npm run runner:schedule  — cycle every 1h, 30min open window
 *   npm run runner           — default: 2h interval, 5min open window
 *
 * Flags:
 *   --once           Run one cycle and exit
 *   --interval N     Seconds between cycles (default 7200)
 *   --open-window N  Seconds to wait for external participants (default 300)
 *   --scenario S     Force scenario: loan | option | combined | staking
 *   --dry-run        Plan without executing
 */

import 'dotenv/config';
import { readFileSync, existsSync, writeFileSync, mkdirSync } from 'fs';
import { resolve } from 'path';
import {
  createPublicClient,
  createWalletClient,
  http,
  parseAbi,
  parseUnits,
  formatUnits,
  type Hash,
  type Address,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { baseSepolia } from 'viem/chains';

import {
  writeStatus, writeReport, buildReport, buildInitialStatus,
  type RunnerState, type ScenarioType, type TxRecord, type DealRecord,
  type CycleStatus, type OpenDeal,
} from './lib/reporter.js';
import { watchForParticipation, type ParticipationEvent } from './lib/chain-monitor.js';

// ─── Config ──────────────────────────────────────────────────────────────────

const BASESCAN   = 'https://sepolia.basescan.org';
const RPC_URL    = process.env.VITE_BASE_SEPOLIA_RPC ?? 'https://sepolia.base.org';
const MIN_ETH    = parseUnits('0.002', 18); // abort if any agent below this

const LOAN_ENGINE  = '0x96C3291C9b0C34b007893326ee9dcA534BfcFa0c' as Address;
const CALL_VAULT   = '0x69730728a0B19b844bc18888d2317987Bc528baE' as Address;
const BUNDLE_VAULT = '0x86ef420fD3e27c3Ac896c479B19b6A840b97Bee1' as Address;
const STAKING      = '0xADBf89BA38915B9CF18E0a24Ea3E27F39d920bd3' as Address;
const MOCK_USDC    = '0xDCf9936b330D6957CaD463f850D1F2B6F1eABc3A' as Address;
const TEST_WETH    = (process.env.TEST_WETH_ADDRESS ?? '') as Address;
const PYTH_ORACLE  = '0xA2aa501b19aff244D90cc15a4Cf739D2725B5729' as Address;
const ETH_USD_FEED = '0xff61491a931112ddf1bd8147cd1b641375f79f5825126d665480874634fd0ace';

// ─── Minimal ABIs ─────────────────────────────────────────────────────────────

const ERC20_ABI = parseAbi([
  'function approve(address spender, uint256 amount) external returns (bool)',
  'function balanceOf(address account) external view returns (uint256)',
  'function allowance(address owner, address spender) external view returns (uint256)',
]);

const BUNDLE_VAULT_ABI = parseAbi([
  'function depositBundle(address[] calldata erc20Tokens, uint256[] calldata erc20Amounts, address[] calldata erc721Contracts, uint256[] calldata erc721Ids, string calldata metadataURI) external returns (uint256)',
  'function approve(address to, uint256 tokenId) external',
  'function balanceOf(address owner) external view returns (uint256)',
  'function tokenOfOwnerByIndex(address owner, uint256 index) external view returns (uint256)',
]);

const LOAN_ABI = parseAbi([
  'function createLoanOffer(address nftContract, uint256 nftId, uint256 principal, uint256 interest, uint256 duration) external',
  'function acceptLoan(uint256 loanId, bytes[] calldata priceUpdateData) external payable',
  'function repayLoan(uint256 loanId) external',
  'function loanCounter() external view returns (uint256)',
  'function loans(uint256 loanId) external view returns (address borrower, address lender, address nftContract, uint256 nftId, uint256 principal, uint256 interest, uint256 duration, uint256 startTime, uint256 healthSnapshot, bool active, bool repaid)',
]);

const CALL_VAULT_ABI = parseAbi([
  'function writeCoveredCall(address underlying, uint256 amount, uint256 strike, uint256 expiry, uint256 premium) external returns (uint256)',
  'function buyOption(uint256 optionId) external',
  'function optionCounter() external view returns (uint256)',
  'function options(uint256 optionId) external view returns (address writer, address buyer, address underlying, uint256 amount, uint256 strike, uint256 expiry, uint256 premium, bool exercised, bool active)',
]);

const STAKING_ABI = parseAbi([
  'function stake(uint256 amount) external',
  'function claimRevenue() external',
  'function pendingRevenue(address staker) external view returns (uint256)',
  'function positions(address staker) external view returns (uint256 staked, uint256 stakedAt, uint256 rewardDebt, uint256 passId, bool hasPass)',
]);

const PYTH_ABI = parseAbi([
  'function getUpdateFee(bytes[] calldata updateData) external view returns (uint256 feeAmount)',
]);

// ─── CLI arg parsing ──────────────────────────────────────────────────────────

function getArg(flag: string, defaultVal: string): string {
  const idx = process.argv.indexOf(flag);
  return idx !== -1 ? (process.argv[idx + 1] ?? defaultVal) : defaultVal;
}

const DRY_RUN      = process.argv.includes('--dry-run');
const ONCE         = process.argv.includes('--once');
const INTERVAL_S   = parseInt(getArg('--interval', '7200'), 10);
const OPEN_WIN_S   = parseInt(getArg('--open-window', '300'), 10);
const FORCED_SCEN  = getArg('--scenario', '') as ScenarioType | '';

// ─── Load agent wallets ───────────────────────────────────────────────────────

function loadAgentKeys(): Record<string, string> {
  const path = resolve(process.cwd(), '.env.agents');
  if (!existsSync(path)) {
    console.error('❌ .env.agents not found');
    process.exit(1);
  }
  const keys: Record<string, string> = {};
  for (const line of readFileSync(path, 'utf-8').split('\n')) {
    if (line.startsWith('#') || !line.includes('=')) continue;
    const [k, v] = line.trim().split('=');
    keys[k] = v;
  }
  return keys;
}

// ─── Pyth VAA ────────────────────────────────────────────────────────────────

async function fetchPythVAA(): Promise<`0x${string}`[]> {
  try {
    const res = await fetch(
      `https://hermes.pyth.network/v2/updates/price/latest?ids[]=${ETH_USD_FEED}&encoding=hex`
    );
    const data = await res.json() as { binary?: { data: string[] } };
    return (data.binary?.data ?? []).map(d => `0x${d}` as `0x${string}`);
  } catch {
    return [];
  }
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

async function waitAndLog(
  publicClient: ReturnType<typeof createPublicClient>,
  hash: Hash,
  label: string,
  agentName: string,
  txs: TxRecord[],
) {
  console.log(`  ⏳ ${label}`);
  const receipt = await publicClient.waitForTransactionReceipt({ hash, timeout: 90_000 });
  const ok = receipt.status === 'success';
  console.log(`  ${ok ? '✅' : '❌'} ${label}`);
  console.log(`     ${BASESCAN}/tx/${hash}`);
  txs.push({
    hash,
    label,
    agent: agentName,
    gasUsed: receipt.gasUsed?.toString() ?? '0',
    basescanUrl: `${BASESCAN}/tx/${hash}`,
  });
  if (!ok) throw new Error(`Transaction failed: ${label}`);
  return receipt;
}

async function getEthBalances(
  publicClient: ReturnType<typeof createPublicClient>,
  addresses: Record<string, Address>
): Promise<Record<string, bigint>> {
  const out: Record<string, bigint> = {};
  for (const [name, addr] of Object.entries(addresses)) {
    out[name] = await publicClient.getBalance({ address: addr });
  }
  return out;
}

function formatEthStr(wei: bigint): string {
  const str = wei.toString().padStart(19, '0');
  const int = str.slice(0, -18) || '0';
  const dec = str.slice(-18).replace(/0+$/, '').slice(0, 6);
  return dec ? `${int}.${dec}` : int;
}

function section(title: string) {
  console.log(`\n${'─'.repeat(60)}\n  ${title}\n${'─'.repeat(60)}`);
}

// ─── Scenario selection ───────────────────────────────────────────────────────

function pickScenario(loanCount: bigint, optionCount: bigint): ScenarioType {
  if (FORCED_SCEN) return FORCED_SCEN as ScenarioType;
  // Alternate to keep variety
  const cycle = Number((loanCount + optionCount) % 3n);
  return cycle === 0 ? 'combined' : cycle === 1 ? 'loan' : 'option';
}

// ─── BundleVault helpers ──────────────────────────────────────────────────────

async function ensureERC20Allowance(
  publicClient: ReturnType<typeof createPublicClient>,
  wallet: ReturnType<typeof createWalletClient>,
  token: Address,
  owner: Address,
  spender: Address,
  amount: bigint,
  label: string,
  agentName: string,
  txs: TxRecord[],
) {
  const allowance = await publicClient.readContract({
    address: token, abi: ERC20_ABI, functionName: 'allowance', args: [owner, spender],
  }) as bigint;
  if (allowance < amount) {
    const h = await wallet.writeContract({
      address: token, abi: ERC20_ABI,
      functionName: 'approve', args: [spender, amount * 10n],
    }) as Hash;
    await waitAndLog(publicClient, h, label, agentName, txs);
  }
}

async function depositAndGetBundleId(
  publicClient: ReturnType<typeof createPublicClient>,
  wallet: ReturnType<typeof createWalletClient>,
  owner: Address,
  wethAmount: bigint,
  agentName: string,
  txs: TxRecord[],
): Promise<bigint | null> {
  // Approve tWETH to BundleVault
  await ensureERC20Allowance(
    publicClient, wallet, TEST_WETH, owner, BUNDLE_VAULT, wethAmount,
    `${agentName}: approve tWETH → BundleVault`, agentName, txs,
  );

  // Deposit into BundleVault
  const depositHash = await wallet.writeContract({
    address: BUNDLE_VAULT, abi: BUNDLE_VAULT_ABI,
    functionName: 'depositBundle',
    args: [[TEST_WETH], [wethAmount], [], [], ''],
  }) as Hash;
  await waitAndLog(publicClient, depositHash, `${agentName}: depositBundle (${formatUnits(wethAmount, 18)} tWETH)`, agentName, txs);

  // Resolve new bundle ID
  const bal = await publicClient.readContract({
    address: BUNDLE_VAULT, abi: BUNDLE_VAULT_ABI, functionName: 'balanceOf', args: [owner],
  }) as bigint;
  if (bal === 0n) return null;

  const bundleId = await publicClient.readContract({
    address: BUNDLE_VAULT, abi: BUNDLE_VAULT_ABI,
    functionName: 'tokenOfOwnerByIndex', args: [owner, bal - 1n],
  }) as bigint;
  return bundleId;
}


// ─── Core cycle ───────────────────────────────────────────────────────────────

async function runCycle(
  publicClient: ReturnType<typeof createPublicClient>,
  wallets: Record<string, ReturnType<typeof createWalletClient>>,
  accounts: Record<string, { address: Address }>,
  status: CycleStatus,
  nextScheduledAt: string,
) {
  const cycleId = new Date().toISOString();
  const startedAt = Date.now();
  const txs: TxRecord[] = [];
  const deals: DealRecord[] = [];

  console.log(`\n${'═'.repeat(60)}`);
  console.log(`  🦞 CTP Cycle starting — ${cycleId}`);
  console.log(`${'═'.repeat(60)}`);

  // ── PLANNING ────────────────────────────────────────────────────────────────

  status.state = 'planning';
  status.cycleId = cycleId;
  status.transactions = txs;
  writeStatus(status);

  const agentAddresses = {
    Alpha:   accounts.alpha.address,
    Beta:    accounts.beta.address,
    Gamma:   accounts.gamma.address,
    Delta:   accounts.delta.address,
    Epsilon: accounts.epsilon.address,
  };

  const ethBefore = await getEthBalances(publicClient, agentAddresses);

  // Update ETH budget display
  status.ethBudget = Object.fromEntries(
    Object.entries(ethBefore).map(([k, v]) => [k, formatEthStr(v)])
  );
  writeStatus(status);

  // Budget check
  for (const [name, bal] of Object.entries(ethBefore)) {
    if (bal < MIN_ETH) {
      const msg = `${name} ETH too low (${formatEthStr(bal)} ETH < 0.002 ETH minimum). Top up agents.`;
      console.warn(`  ⚠️  ${msg}`);
      status.state = 'idle';
      status.lastError = msg;
      writeStatus(status);
      return;
    }
  }

  const loanCount   = await publicClient.readContract({ address: LOAN_ENGINE,  abi: LOAN_ABI,      functionName: 'loanCounter' }) as bigint;
  const optionCount = await publicClient.readContract({ address: CALL_VAULT,   abi: CALL_VAULT_ABI, functionName: 'optionCounter' }) as bigint;

  const scenario = pickScenario(loanCount, optionCount);
  status.scenario = scenario;

  console.log(`\n  Scenario: ${scenario.toUpperCase()}`);
  console.log(`  Current loans: ${loanCount} | options: ${optionCount}`);

  if (DRY_RUN) {
    console.log('\n  DRY RUN — would execute:', scenario, 'scenario');
    status.state = 'idle';
    writeStatus(status);
    return;
  }

  // ── EXECUTING ────────────────────────────────────────────────────────────────

  status.state = 'executing';
  writeStatus(status);

  const priceVAA = await fetchPythVAA();
  let pythFee = 0n;
  if (priceVAA.length > 0) {
    try {
      pythFee = await publicClient.readContract({
        address: PYTH_ORACLE, abi: PYTH_ABI,
        functionName: 'getUpdateFee', args: [priceVAA],
      }) as bigint;
    } catch { pythFee = 100n; }
  }

  const openLoanIds: bigint[]   = [];
  const openOptionIds: bigint[] = [];
  let usdcVolume = 0n;

  // ── Loan scenario ─────────────────────────────────────────────────────────

  if (scenario === 'loan' || scenario === 'combined') {
    section('LOAN — Creating open listing (BundleVault)');

    if (!TEST_WETH) {
      console.warn('  ⚠️  TEST_WETH_ADDRESS not set — skipping loan scenario. Deploy TestTokens first.');
    } else {
      const wethAmount = parseUnits('0.5', 18);
      const deltaWeth  = await publicClient.readContract({
        address: TEST_WETH, abi: ERC20_ABI,
        functionName: 'balanceOf', args: [accounts.delta.address],
      }) as bigint;

      if (deltaWeth < wethAmount) {
        console.warn(`  ⚠️  Delta has insufficient tWETH (${formatUnits(deltaWeth, 18)}). Requesting from faucet...`);
        // Self-faucet: spawn faucet script
        const { execSync } = await import('child_process');
        try {
          execSync(`npx tsx scripts/faucet-weth.ts --to ${accounts.delta.address}`, { stdio: 'inherit' });
        } catch {
          console.warn('  ⚠️  Faucet call failed — check TEST_WETH_ADDRESS and AGENT1_PRIVATE_KEY');
        }
      }

      const bundleId = await depositAndGetBundleId(
        publicClient, wallets.delta, accounts.delta.address,
        wethAmount, 'BorrowerAgent_Delta', txs,
      );

      if (bundleId === null) {
        console.warn('  ⚠️  BundleVault deposit failed — skipping loan creation');
      } else {
        // Approve bundle NFT to LoanEngine
        const approveH = await wallets.delta.writeContract({
          address: BUNDLE_VAULT, abi: BUNDLE_VAULT_ABI,
          functionName: 'approve', args: [LOAN_ENGINE, bundleId],
        }) as Hash;
        await waitAndLog(publicClient, approveH, `Delta: approve BundleNFT #${bundleId} → LoanEngine`, 'BorrowerAgent_Delta', txs);

        const principal = parseUnits('400', 6);
        const interest  = parseUnits('24', 6);
        const h = await wallets.delta.writeContract({
          address: LOAN_ENGINE, abi: LOAN_ABI,
          functionName: 'createLoanOffer',
          args: [BUNDLE_VAULT, bundleId, principal, interest, BigInt(14 * 86400)],
        }) as Hash;
        await waitAndLog(publicClient, h, `Delta: createLoanOffer (BundleNFT #${bundleId}, 400 USDC, 14d)`, 'BorrowerAgent_Delta', txs);
        const newLoanId = loanCount;
        openLoanIds.push(newLoanId);
        usdcVolume += principal;
        console.log(`  → Loan #${newLoanId} open for external funding at /market`);
      }
    }
  }

  // ── Option scenario ───────────────────────────────────────────────────────

  if (scenario === 'option' || scenario === 'combined') {
    section('OPTION — Creating open listing (tWETH underlying)');

    if (!TEST_WETH) {
      console.warn('  ⚠️  TEST_WETH_ADDRESS not set — skipping option scenario. Deploy TestTokens first.');
    } else {
      const underlying = TEST_WETH;
      const amount     = parseUnits('0.5', 18); // 0.5 tWETH
      const premium    = parseUnits('40', 6);
      const strike     = parseUnits('2000', 6);
      const expiry     = BigInt(Math.floor(Date.now() / 1000) + 7 * 86400);

      // Check tWETH balance and auto-faucet if needed
      const epsilonWeth = await publicClient.readContract({
        address: TEST_WETH, abi: ERC20_ABI,
        functionName: 'balanceOf', args: [accounts.epsilon.address],
      }) as bigint;
      if (epsilonWeth < amount) {
        console.warn(`  ⚠️  Epsilon has insufficient tWETH (${formatUnits(epsilonWeth, 18)}). Requesting from faucet...`);
        const { execSync } = await import('child_process');
        try {
          execSync(`npx tsx scripts/faucet-weth.ts --to ${accounts.epsilon.address}`, { stdio: 'inherit' });
        } catch {
          console.warn('  ⚠️  Faucet call failed — check TEST_WETH_ADDRESS and AGENT1_PRIVATE_KEY');
        }
      }

      // Approve tWETH to CallVault
      const allowance = await publicClient.readContract({
        address: underlying, abi: ERC20_ABI,
        functionName: 'allowance', args: [accounts.epsilon.address, CALL_VAULT],
      }) as bigint;
      if (allowance < amount) {
        const h = await wallets.epsilon.writeContract({
          address: underlying, abi: ERC20_ABI,
          functionName: 'approve', args: [CALL_VAULT, parseUnits('5', 18)],
        }) as Hash;
        await waitAndLog(publicClient, h, 'Epsilon: approve tWETH → CallVault', 'HedgeAgent_Epsilon', txs);
      }

      const h = await wallets.epsilon.writeContract({
        address: CALL_VAULT, abi: CALL_VAULT_ABI,
        functionName: 'writeCoveredCall',
        args: [underlying, amount, strike, expiry, premium],
      }) as Hash;
      await waitAndLog(publicClient, h, `Epsilon: writeCoveredCall (0.5 tWETH, strike 2000 USDC, 7d, premium 40 USDC)`, 'HedgeAgent_Epsilon', txs);

      const newOptionId = optionCount;
      openOptionIds.push(newOptionId);
      usdcVolume += premium;
      console.log(`  → Option #${newOptionId} open for external purchase at /market`);
    }
  }

  // ── Staking scenario ─────────────────────────────────────────────────────

  if (scenario === 'staking') {
    section('STAKING — Claim revenue');

    const pending = await publicClient.readContract({
      address: STAKING, abi: STAKING_ABI,
      functionName: 'pendingRevenue',
      args: [accounts.alpha.address],
    }) as bigint;

    if (pending > 0n) {
      const h = await wallets.alpha.writeContract({
        address: STAKING, abi: STAKING_ABI,
        functionName: 'claimRevenue',
      }) as Hash;
      await waitAndLog(publicClient, h, `Alpha: claimRevenue (${formatUnits(pending, 6)} USDC pending)`, 'LiquidityAgent_Alpha', txs);
      usdcVolume += pending;
    } else {
      console.log('  → No pending revenue for Alpha — staking scenario skipped');
    }
  }

  // ── OPEN WINDOW ──────────────────────────────────────────────────────────────

  const windowEndsAt = new Date(Date.now() + OPEN_WIN_S * 1000).toISOString();
  const openDeals: OpenDeal[] = [
    ...openLoanIds.map(id => ({ type: 'loan' as const,   id: Number(id), windowEndsAt })),
    ...openOptionIds.map(id => ({ type: 'option' as const, id: Number(id), windowEndsAt })),
  ];

  status.state = 'open_window';
  status.openDeals = openDeals;
  writeStatus(status);

  if (openDeals.length > 0) {
    console.log(`\n${'═'.repeat(60)}`);
    console.log(`  🟡 OPEN WINDOW ACTIVE — ${OPEN_WIN_S}s for external participation`);
    for (const d of openDeals) {
      console.log(`  • ${d.type.toUpperCase()} #${d.id} — open at /market`);
    }
    console.log(`${'═'.repeat(60)}`);
  }

  // ── MONITORING ───────────────────────────────────────────────────────────────

  status.state = 'monitoring';
  writeStatus(status);

  const organicEvents: ParticipationEvent[] = await watchForParticipation(
    openLoanIds,
    openOptionIds,
    OPEN_WIN_S * 1000,
    publicClient,
    LOAN_ENGINE,
    CALL_VAULT,
  );

  const organicLoanIds   = new Set(organicEvents.filter(e => e.type === 'loan').map(e => e.id));
  const organicOptionIds = new Set(organicEvents.filter(e => e.type === 'option').map(e => e.id));

  // ── SETTLING ─────────────────────────────────────────────────────────────────

  status.state = 'settling';
  status.openDeals = [];
  writeStatus(status);

  // Loan terms for PnL — read from contract state
  const loanPrincipal = parseUnits('400', 6);
  const loanInterest  = parseUnits('24', 6);
  const optionPremium = parseUnits('40', 6);
  const optionStrike  = parseUnits('2000', 6);

  // Auto-settle unfunded loans
  for (const loanId of openLoanIds) {
    if (organicLoanIds.has(Number(loanId))) {
      const lenderAddr = organicEvents.find(e => e.type === 'loan' && e.id === Number(loanId))?.participant ?? '';
      console.log(`  Loan #${loanId} — filled organically, skipping auto-settle`);
      deals.push({
        type: 'loan', id: Number(loanId),
        openWindowSeconds: OPEN_WIN_S,
        organicParticipation: true,
        outcome: 'funded-by-external',
        principalUsdc: formatUnits(loanPrincipal, 6),
        interestUsdc: formatUnits(loanInterest, 6),
        participants: [
          { role: 'borrower', address: accounts.delta.address, isAgent: true, agentName: 'BorrowerAgent_Delta',
            pnlUsdc: `+${formatUnits(loanPrincipal, 6)}`, pnlNote: `Received ${formatUnits(loanPrincipal, 6)} USDC principal (owes back +${formatUnits(loanInterest, 6)} interest)` },
          { role: 'lender', address: lenderAddr, isAgent: false,
            pnlUsdc: `+${formatUnits(loanInterest, 6)}`, pnlNote: `Earns ${formatUnits(loanInterest, 6)} USDC interest on repayment (pending)` },
        ],
      });
      continue;
    }

    console.log(`  Loan #${loanId} — not filled, Gamma auto-settling`);
    try {
      const usdcAllowance = await publicClient.readContract({
        address: MOCK_USDC, abi: ERC20_ABI,
        functionName: 'allowance', args: [accounts.gamma.address, LOAN_ENGINE],
      }) as bigint;
      if (usdcAllowance < parseUnits('1000', 6)) {
        const h = await wallets.gamma.writeContract({
          address: MOCK_USDC, abi: ERC20_ABI,
          functionName: 'approve', args: [LOAN_ENGINE, parseUnits('10000', 6)],
        }) as Hash;
        await waitAndLog(publicClient, h, 'Gamma: approve USDC → LoanEngine', 'LendingAgent_Gamma', txs);
      }

      const h = await wallets.gamma.writeContract({
        address: LOAN_ENGINE, abi: LOAN_ABI,
        functionName: 'acceptLoan', args: [loanId, priceVAA],
        value: pythFee,
      }) as Hash;
      await waitAndLog(publicClient, h, `Gamma: acceptLoan #${loanId} [AUTO-SETTLE]`, 'LendingAgent_Gamma', txs);

      deals.push({
        type: 'loan', id: Number(loanId),
        openWindowSeconds: OPEN_WIN_S,
        organicParticipation: false,
        outcome: 'funded-by-automation',
        principalUsdc: formatUnits(loanPrincipal, 6),
        interestUsdc: formatUnits(loanInterest, 6),
        participants: [
          { role: 'borrower', address: accounts.delta.address, isAgent: true, agentName: 'BorrowerAgent_Delta',
            pnlUsdc: `+${formatUnits(loanPrincipal, 6)}`, pnlNote: `Received ${formatUnits(loanPrincipal, 6)} USDC principal` },
          { role: 'lender', address: accounts.gamma.address, isAgent: true, agentName: 'LendingAgent_Gamma',
            pnlUsdc: `+${formatUnits(loanInterest, 6)}`, pnlNote: `Earns ${formatUnits(loanInterest, 6)} USDC interest (pending repayment)` },
        ],
      });
    } catch (e) {
      console.warn(`  ⚠️  Auto-settle loan #${loanId} failed:`, (e as Error).message);
      deals.push({ type: 'loan', id: Number(loanId), openWindowSeconds: OPEN_WIN_S, organicParticipation: false, outcome: 'expired', participants: [] });
    }
  }

  // Auto-settle unfunded options
  for (const optionId of openOptionIds) {
    if (organicOptionIds.has(Number(optionId))) {
      const buyerAddr = organicEvents.find(e => e.type === 'option' && e.id === Number(optionId))?.participant ?? '';
      console.log(`  Option #${optionId} — bought organically, skipping auto-settle`);
      deals.push({
        type: 'option', id: Number(optionId),
        openWindowSeconds: OPEN_WIN_S,
        organicParticipation: true,
        outcome: 'bought-by-external',
        premiumUsdc: formatUnits(optionPremium, 6),
        strikeUsdc: formatUnits(optionStrike, 6),
        participants: [
          { role: 'writer', address: accounts.epsilon.address, isAgent: true, agentName: 'HedgeAgent_Epsilon',
            pnlUsdc: `+${formatUnits(optionPremium, 6)}`, pnlNote: `Collected ${formatUnits(optionPremium, 6)} USDC premium upfront` },
          { role: 'buyer', address: buyerAddr, isAgent: false,
            pnlUsdc: `-${formatUnits(optionPremium, 6)}`, pnlNote: `Paid ${formatUnits(optionPremium, 6)} USDC premium. Profits if ETH > $${formatUnits(optionStrike, 6)} at expiry` },
        ],
      });
      continue;
    }

    console.log(`  Option #${optionId} — not bought, Beta auto-settling`);
    try {
      const usdcAllowance = await publicClient.readContract({
        address: MOCK_USDC, abi: ERC20_ABI,
        functionName: 'allowance', args: [accounts.beta.address, CALL_VAULT],
      }) as bigint;
      if (usdcAllowance < optionPremium) {
        const h = await wallets.beta.writeContract({
          address: MOCK_USDC, abi: ERC20_ABI,
          functionName: 'approve', args: [CALL_VAULT, parseUnits('500', 6)],
        }) as Hash;
        await waitAndLog(publicClient, h, 'Beta: approve USDC → CallVault', 'ArbitrageAgent_Beta', txs);
      }

      const h = await wallets.beta.writeContract({
        address: CALL_VAULT, abi: CALL_VAULT_ABI,
        functionName: 'buyOption', args: [optionId],
      }) as Hash;
      await waitAndLog(publicClient, h, `Beta: buyOption #${optionId} [AUTO-SETTLE]`, 'ArbitrageAgent_Beta', txs);

      deals.push({
        type: 'option', id: Number(optionId),
        openWindowSeconds: OPEN_WIN_S,
        organicParticipation: false,
        outcome: 'bought-by-automation',
        premiumUsdc: formatUnits(optionPremium, 6),
        strikeUsdc: formatUnits(optionStrike, 6),
        participants: [
          { role: 'writer', address: accounts.epsilon.address, isAgent: true, agentName: 'HedgeAgent_Epsilon',
            pnlUsdc: `+${formatUnits(optionPremium, 6)}`, pnlNote: `Collected ${formatUnits(optionPremium, 6)} USDC premium upfront` },
          { role: 'buyer', address: accounts.beta.address, isAgent: true, agentName: 'ArbitrageAgent_Beta',
            pnlUsdc: `-${formatUnits(optionPremium, 6)}`, pnlNote: `Paid ${formatUnits(optionPremium, 6)} USDC premium. Profits if ETH > $${formatUnits(optionStrike, 6)}` },
        ],
      });
    } catch (e) {
      console.warn(`  ⚠️  Auto-settle option #${optionId} failed:`, (e as Error).message);
      deals.push({ type: 'option', id: Number(optionId), openWindowSeconds: OPEN_WIN_S, organicParticipation: false, outcome: 'expired', participants: [] });
    }
  }

  // ── REPORTING ────────────────────────────────────────────────────────────────

  status.state = 'reporting';
  writeStatus(status);

  const ethAfter = await getEthBalances(publicClient, agentAddresses);

  const report = buildReport({
    cycleId,
    scenario,
    status: deals.some(d => d.outcome === 'expired') ? 'partial' : 'complete',
    startedAt,
    transactions: txs,
    deals,
    ethBefore,
    ethAfter,
    usdcVolume,
    nextScheduledAt,
  });

  writeReport(report);

  console.log(`\n${'═'.repeat(60)}`);
  console.log(`  ✅ CTP Cycle complete — ${report.durationSeconds}s`);
  console.log(`  Scenario: ${scenario} | TXs: ${txs.length} | Deals: ${deals.length}`);
  console.log(`  Organic participants: ${report.organicParticipants} | Auto: ${report.automatedParticipants}`);
  console.log(`  ETH spent: ${report.totalEthSpent} | USDC volume: ${report.usdcVolume}`);
  console.log(`  Next cycle: ${nextScheduledAt}`);
  console.log(`${'═'.repeat(60)}\n`);
}

// ─── Main ────────────────────────────────────────────────────────────────────

async function main() {
  console.log('\n🦞 ClawStreet — Continuous Test Protocol (CTP)');
  console.log(`   RPC:         ${RPC_URL}`);
  console.log(`   Interval:    ${INTERVAL_S}s`);
  console.log(`   Open window: ${OPEN_WIN_S}s`);
  console.log(`   Mode:        ${ONCE ? 'once' : 'recurring'}${DRY_RUN ? ' (DRY RUN)' : ''}`);
  if (FORCED_SCEN) console.log(`   Scenario:    ${FORCED_SCEN} (forced)`);

  const keys = loadAgentKeys();
  const alpha   = privateKeyToAccount(keys['AGENT1_PRIVATE_KEY'] as `0x${string}`);
  const beta    = privateKeyToAccount(keys['AGENT2_PRIVATE_KEY'] as `0x${string}`);
  const gamma   = privateKeyToAccount(keys['AGENT3_PRIVATE_KEY'] as `0x${string}`);
  const delta   = privateKeyToAccount(keys['AGENT4_PRIVATE_KEY'] as `0x${string}`);
  const epsilon = privateKeyToAccount(keys['AGENT5_PRIVATE_KEY'] as `0x${string}`);

  const transport = http(RPC_URL);
  const publicClient = createPublicClient({ chain: baseSepolia, transport });
  const accounts = { alpha, beta, gamma, delta, epsilon };

  const wallets = {
    alpha:   createWalletClient({ account: alpha,   chain: baseSepolia, transport }),
    beta:    createWalletClient({ account: beta,    chain: baseSepolia, transport }),
    gamma:   createWalletClient({ account: gamma,   chain: baseSepolia, transport }),
    delta:   createWalletClient({ account: delta,   chain: baseSepolia, transport }),
    epsilon: createWalletClient({ account: epsilon, chain: baseSepolia, transport }),
  };

  // Ensure logs dir exists
  mkdirSync(resolve(process.cwd(), 'logs/reports'), { recursive: true });

  const status = buildInitialStatus();
  writeStatus(status);

  const executeCycle = async () => {
    const nextAt = ONCE
      ? new Date().toISOString()
      : new Date(Date.now() + INTERVAL_S * 1000).toISOString();

    try {
      await runCycle(publicClient, wallets, accounts, status, nextAt);
    } catch (e) {
      console.error('[runner] Cycle failed:', (e as Error).message);
      status.state = 'idle';
      status.lastError = (e as Error).message;
      writeStatus(status);
    }

    status.state = 'idle';
    status.openDeals = [];
    status.nextScheduledAt = nextAt;
    writeStatus(status);
  };

  if (ONCE) {
    await executeCycle();
    process.exit(0);
  }

  // Run immediately, then on interval
  await executeCycle();
  const interval = setInterval(executeCycle, INTERVAL_S * 1000);

  // Graceful shutdown
  process.on('SIGINT', () => {
    console.log('\n[runner] Shutting down...');
    clearInterval(interval);
    status.state = 'idle';
    writeStatus(status);
    process.exit(0);
  });

  console.log(`[runner] Scheduler active — next cycle in ${INTERVAL_S}s. Ctrl+C to stop.`);
}

main().catch(e => {
  console.error('❌ Runner crashed:', e);
  process.exit(1);
});
