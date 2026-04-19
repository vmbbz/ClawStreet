import { parseAbi } from 'viem';

// ─── Contract addresses — Base Sepolia ───────────────────────────────────────
// ClawToken ($STREET) + Staking redeployed 2026-04-12 for STREET symbol
export const CONTRACT_ADDRESSES = {
  LOAN_ENGINE:  '0x96C3291C9b0C34b007893326ee9dcA534BfcFa0c' as const,
  CALL_VAULT:   '0x69730728a0B19b844bc18888d2317987Bc528baE' as const,
  BUNDLE_VAULT: '0x86ef420fD3e27c3Ac896c479B19b6A840b97Bee1' as const,
  CLAW_TOKEN:   '0xD11fC366828445B874F5202109E5f48C4D14FCe4' as const,
  STAKING:      '0xADBf89BA38915B9CF18E0a24Ea3E27F39d920bd3' as const,
  MOCK_USDC:    '0xDCf9936b330D6957CaD463f850D1F2B6F1eABc3A' as const,
  MOCK_NFT:     '0x41119aAd1c69dba3934D0A061d312A52B06B27DF' as const,
};

// ─── Test tokens (deployed by script/DeployTestTokens.s.sol) ─────────────────
// Deployed 2026-04-18 on Base Sepolia — verified on Basescan
export const TEST_TOKENS = {
  WETH: '0xE93695aE429a2C156F216Bc615E9Dd8d1A9794dE' as `0x${string}`,  // TestWETH — maps to ETH/USD Pyth feed
  WBTC: '0xCd1CA9D5612B0Eaefa6388129366226d9715161A' as `0x${string}`,  // TestWBTC — maps to BTC/USD Pyth feed
  LINK: '0xD14135bcdFE39097122830E1F989cc6e11074B96' as `0x${string}`,  // TestLINK — maps to LINK/USD Pyth feed
};

// ─── Pyth price feed IDs (same on all networks incl. Base Sepolia) ────────────
export const PYTH_FEEDS = {
  ETH_USD:  '0xff61491a931112ddf1bd8147cd1b641375f79f5825126d665480874634fd0ace',
  BTC_USD:  '0xe62df6c8b4a85fe1a67db44dc12de5db330f7ac66b72dc658afedf0f4a415b43',
  LINK_USD: '0x8ac0c70fff57e9aefdf5edf44b51d62c2d433653cbb2cf5cc06bb115af04d221',
} as const;

// ─── Map token address → Pyth feed ID (UI price display only) ─────────────────
// Populated lazily once TEST_TOKENS are deployed
export const TOKEN_PRICE_FEEDS: Record<string, string> = {};
// e.g. TOKEN_PRICE_FEEDS[TEST_TOKENS.WETH] = PYTH_FEEDS.ETH_USD
// (set via runtime helper below to handle empty addresses gracefully)

export function registerTokenFeed(tokenAddress: string, feedId: string) {
  if (tokenAddress && tokenAddress.length === 42) {
    TOKEN_PRICE_FEEDS[tokenAddress.toLowerCase()] = feedId;
  }
}

// Auto-register once addresses are filled in
if (TEST_TOKENS.WETH) registerTokenFeed(TEST_TOKENS.WETH, PYTH_FEEDS.ETH_USD);
if (TEST_TOKENS.WBTC) registerTokenFeed(TEST_TOKENS.WBTC, PYTH_FEEDS.BTC_USD);
if (TEST_TOKENS.LINK) registerTokenFeed(TEST_TOKENS.LINK, PYTH_FEEDS.LINK_USD);

// ─── Token metadata (symbol + icon via Trust Wallet Assets CDN) ───────────────
// Maps testnet address → canonical mainnet address for icon lookup
interface TokenMeta { symbol: string; canonical: string }
const TOKEN_METADATA: Record<string, TokenMeta> = {
  [TEST_TOKENS.WETH.toLowerCase()]: { symbol: 'WETH', canonical: '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2' },
  [TEST_TOKENS.WBTC.toLowerCase()]: { symbol: 'WBTC', canonical: '0x2260FAC5E5542a773Aa44fBCfeDf7C193bc2C599' },
  [TEST_TOKENS.LINK.toLowerCase()]: { symbol: 'LINK', canonical: '0x514910771AF9Ca656af840dff83E8264EcF986CA' },
};

/** Returns the human-readable symbol for a known testnet token, else a truncated address. */
export function getTokenSymbol(address: string): string {
  return TOKEN_METADATA[address.toLowerCase()]?.symbol
    ?? `${address.slice(0, 6)}…${address.slice(-4)}`;
}

/** Returns a token icon URL from Trust Wallet Assets CDN (10k+ tokens). Falls back gracefully. */
export function getTokenIconUrl(address: string): string {
  const canonical = TOKEN_METADATA[address.toLowerCase()]?.canonical ?? address;
  // Checksum not required — Trust Wallet Assets CDN handles case-insensitive lookup
  return `https://raw.githubusercontent.com/trustwallet/assets/master/blockchains/ethereum/assets/${canonical}/logo.png`;
}

// ─── Known agent registry ─────────────────────────────────────────────────────
// Used by Profile.tsx to distinguish agents from human users
export type AgentInfo = {
  name: string;
  role: string;
  address: `0x${string}`;
  createdAt: string;
};

export const KNOWN_AGENTS: AgentInfo[] = [
  { name: 'LiquidityAgent_Alpha',  role: 'Market Maker',   address: '0xD1E84c88734013613230678B8E000dE53e4957dC', createdAt: '2026-04-12' },
  { name: 'ArbitrageAgent_Beta',   role: 'Arbitrageur',    address: '0xBaf9d5E05d82bEA9B971B54AD148904ae25876b2', createdAt: '2026-04-12' },
  { name: 'LendingAgent_Gamma',    role: 'Lender',         address: '0x37D57004FdeBd029d9fcB1Cc88e275fEafA89353', createdAt: '2026-04-17' },
  { name: 'BorrowerAgent_Delta',   role: 'Borrower',       address: '0x5159345B9944Ab14D05c18853923070D3EBF60ad', createdAt: '2026-04-17' },
  { name: 'HedgeAgent_Epsilon',    role: 'Options Writer', address: '0x4EED792404bbC7bC98648EbE653E38995B8e3DfB', createdAt: '2026-04-17' },
];

export function getAgentInfo(address: string): AgentInfo | null {
  const lower = address.toLowerCase();
  return KNOWN_AGENTS.find(a => a.address.toLowerCase() === lower) ?? null;
}

// Base Sepolia explorer
export const BASESCAN = 'https://sepolia.basescan.org';

// ─── ClawStreetLoan ABI ───────────────────────────────────────────────────────
// FIX: getHealthScore takes 4 params — (nftContract, nftId, principal, borrower)
export const clawStreetLoanABI = parseAbi([
  // Write functions
  'function createLoanOffer(address nftContract, uint256 nftId, uint256 principal, uint256 interest, uint256 duration) external',
  'function cancelLoanOffer(uint256 loanId) external',
  'function acceptLoan(uint256 loanId, bytes[] calldata priceUpdateData) external payable',
  'function repayLoan(uint256 loanId) external',
  'function claimDefault(uint256 loanId) external',
  'function setStakingContract(address _stakingContract) external',
  'function setReputationOracle(address _reputationOracle) external',
  'function withdrawFees(address to) external',
  'function pause() external',
  'function unpause() external',
  // Read functions
  'function loans(uint256 loanId) external view returns (address borrower, address lender, address nftContract, uint256 nftId, uint256 principal, uint256 interest, uint256 duration, uint256 startTime, uint256 healthSnapshot, bool active, bool repaid)',
  'function loanCounter() external view returns (uint256)',
  'function getHealthScore(address nftContract, uint256 nftId, uint256 principal, address borrower) external view returns (uint256)',
  'function suggestLTV(uint256 health) external pure returns (uint256)',
  'function feeToken() external view returns (address)',
  'function paused() external view returns (bool)',
  // Events
  'event LoanCreated(uint256 indexed loanId, address indexed borrower, uint256 principal, uint256 health)',
  'event LoanAccepted(uint256 indexed loanId, address indexed lender)',
  'event LoanRepaid(uint256 indexed loanId)',
  'event LoanDefaulted(uint256 indexed loanId)',
  'event LoanCancelled(uint256 indexed loanId)',
  'event FeeCollected(uint256 amount)',
  'event FeesWithdrawn(address indexed to, uint256 amount)',
  'event StakingContractSet(address indexed stakingContract)',
]);

// ─── ClawStreetCallVault ABI ──────────────────────────────────────────────────
export const clawStreetCallVaultABI = parseAbi([
  // Write functions
  'function writeCoveredCall(address underlying, uint256 amount, uint256 strike, uint256 expiry, uint256 premium) external returns (uint256)',
  'function cancelOption(uint256 optionId) external',
  'function buyOption(uint256 optionId) external',
  'function exercise(uint256 optionId) external',
  'function reclaimUnderlying(uint256 optionId) external',
  // Read functions
  'function options(uint256 optionId) external view returns (address writer, address buyer, address underlying, uint256 amount, uint256 strike, uint256 expiry, uint256 premium, bool exercised, bool active)',
  'function optionCounter() external view returns (uint256)',
  'function premiumToken() external view returns (address)',
  // Events
  'event OptionWritten(uint256 indexed optionId, address indexed writer, uint256 amount, uint256 strike, uint256 premium)',
  'event OptionBought(uint256 indexed optionId, address indexed buyer)',
  'event OptionExercised(uint256 indexed optionId, address indexed buyer)',
  'event OptionCancelled(uint256 indexed optionId)',
  'event UnderlyingReclaimed(uint256 indexed optionId)',
]);

// ─── ClawStreetBundleVault ABI ────────────────────────────────────────────────
export const clawStreetBundleVaultABI = parseAbi([
  'function depositBundle(address[] calldata erc20Tokens, uint256[] calldata erc20Amounts, address[] calldata erc721Contracts, uint256[] calldata erc721Ids, string calldata metadataURI) external returns (uint256)',
  'function withdrawBundle(uint256 tokenId) external',
  'function ownerOf(uint256 tokenId) external view returns (address)',
  'event BundleDeposited(uint256 indexed tokenId, address indexed owner)',
  'event BundleWithdrawn(uint256 indexed tokenId, address indexed to)',
]);

// ─── ClawToken ($STREET) ABI ──────────────────────────────────────────────────
export const clawTokenABI = parseAbi([
  'function mint(address to, uint256 amount) external',
  'function burn(uint256 amount) external',
  'function totalSupply() external view returns (uint256)',
  'function balanceOf(address account) external view returns (uint256)',
  'function transfer(address to, uint256 amount) external returns (bool)',
  'function approve(address spender, uint256 amount) external returns (bool)',
  'function allowance(address owner, address spender) external view returns (uint256)',
  'function transferFrom(address from, address to, uint256 amount) external returns (bool)',
  'function name() external view returns (string)',
  'function symbol() external view returns (string)',
  'function decimals() external view returns (uint8)',
  'function MAX_SUPPLY() external view returns (uint256)',
  'function owner() external view returns (address)',
  'event Minted(address indexed to, uint256 amount)',
  'event Transfer(address indexed from, address indexed to, uint256 value)',
  'event Approval(address indexed owner, address indexed spender, uint256 value)',
]);

// ─── ClawStreetStaking ABI ────────────────────────────────────────────────────
export const clawStreetStakingABI = parseAbi([
  // Write functions
  'function stake(uint256 amount) external',
  'function unstake() external',
  'function claimRevenue() external',
  'function notifyFee(uint256 amount) external',
  'function setFeeNotifier(address notifier, bool enabled) external',
  'function setBaseURI(string calldata uri) external',
  // Read functions
  'function positions(address staker) external view returns (uint256 staked, uint256 stakedAt, uint256 rewardDebt, uint256 passId, bool hasPass)',
  'function totalStaked() external view returns (uint256)',
  'function revenuePerShareAccumulated() external view returns (uint256)',
  'function pendingRevenue(address staker) external view returns (uint256)',
  'function lockRemaining(address staker) external view returns (uint256)',
  'function feeNotifiers(address notifier) external view returns (bool)',
  'function clawToken() external view returns (address)',
  'function revenueToken() external view returns (address)',
  // ERC-721 (ClawPass NFT)
  'function ownerOf(uint256 tokenId) external view returns (address)',
  'function balanceOf(address owner) external view returns (uint256)',
  'function name() external view returns (string)',
  'function symbol() external view returns (string)',
  // Events
  'event Staked(address indexed staker, uint256 amount, uint256 totalStaked)',
  'event Unstaked(address indexed staker, uint256 amount)',
  'event RevenueClaimed(address indexed staker, uint256 amount)',
  'event FeeNotified(address indexed notifier, uint256 amount)',
  'event FeeNotifierSet(address indexed notifier, bool enabled)',
]);

// ─── Standard ERC ABIs ────────────────────────────────────────────────────────
export const erc20ABI = parseAbi([
  'function approve(address spender, uint256 amount) external returns (bool)',
  'function allowance(address owner, address spender) external view returns (uint256)',
  'function balanceOf(address account) external view returns (uint256)',
  'function transfer(address to, uint256 amount) external returns (bool)',
  'function decimals() external view returns (uint8)',
  'function symbol() external view returns (string)',
]);

export const erc721ABI = parseAbi([
  'function approve(address to, uint256 tokenId) external',
  'function setApprovalForAll(address operator, bool approved) external',
  'function getApproved(uint256 tokenId) external view returns (address)',
  'function isApprovedForAll(address owner, address operator) external view returns (bool)',
  'function ownerOf(uint256 tokenId) external view returns (address)',
  'function balanceOf(address owner) external view returns (uint256)',
]);
