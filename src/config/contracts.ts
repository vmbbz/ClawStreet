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

// ─── ClawToken ($CLAW) ABI ────────────────────────────────────────────────────
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
