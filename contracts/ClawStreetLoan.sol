// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/access/AccessControlUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/utils/PausableUpgradeable.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

import "@openzeppelin/contracts/token/ERC721/IERC721.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/utils/math/Math.sol";

import "@pythnetwork/pyth-sdk-solidity/IPyth.sol";
import "@pythnetwork/pyth-sdk-solidity/PythStructs.sol";
import "./interfaces/IAgentReputation.sol";

interface IClawStreetStaking {
    function notifyFee(uint256 amount) external;
}

interface IClawStreetBundleVault {
    function getBundleContent(uint256 tokenId) external view returns (
        address[] memory erc20Tokens,
        uint256[] memory erc20Amounts,
        address[] memory erc721Contracts,
        uint256[] memory erc721Ids
    );
    function withdrawBundle(uint256 tokenId) external;
}

interface IERC20Decimals {
    function decimals() external view returns (uint8);
}

contract ClawStreetLoan is
    Initializable,
    UUPSUpgradeable,
    AccessControlUpgradeable,
    PausableUpgradeable,
    ReentrancyGuard
{
    using SafeERC20 for IERC20;

    bytes32 public constant ADMIN_ROLE = keccak256("ADMIN_ROLE");
    bytes32 public constant UPGRADER_ROLE = keccak256("UPGRADER_ROLE");

    struct Loan {
        address borrower;
        address lender;
        address nftContract;
        uint256 nftId;
        uint256 principal;      // in feeToken decimals (e.g. 6 for USDC)
        uint256 interest;       // absolute interest amount
        uint256 duration;       // in seconds
        uint256 startTime;
        uint256 healthSnapshot; // recorded at creation for LTV calc
        bool active;
        bool repaid;
    }

    mapping(uint256 => Loan) public loans;
    uint256 public loanCounter;

    uint256 public constant BROKER_FEE_BPS = 100; // 1%
    uint256 public constant MIN_DURATION = 1 hours;
    IERC20 public feeToken;
    IPyth public pythOracle;
    bytes32 public priceFeedId; // e.g. ETH/USD or collection-specific
    IAgentReputation public reputationOracle;
    IClawStreetStaking public stakingContract; // receives fee notifications

    // Bundle-aware collateral support
    address public bundleVault;
    mapping(address => bytes32) public tokenPriceFeeds; // ERC20 token → Pyth feed ID

    // Events for indexing + frontend
    event StakingContractSet(address indexed stakingContract);
    event FeesWithdrawn(address indexed to, uint256 amount);
    event LoanCreated(uint256 indexed loanId, address indexed borrower, uint256 principal, uint256 health);
    event LoanAccepted(uint256 indexed loanId, address indexed lender);
    event LoanRepaid(uint256 indexed loanId);
    event LoanDefaulted(uint256 indexed loanId);
    event LoanCancelled(uint256 indexed loanId);
    event FeeCollected(uint256 amount);

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        _disableInitializers();
    }

    function initialize(
        address _feeToken,
        address _pythOracle,
        bytes32 _priceFeedId
    ) public initializer {

        __AccessControl_init();
        __Pausable_init();

        _grantRole(DEFAULT_ADMIN_ROLE, msg.sender);
        _grantRole(ADMIN_ROLE, msg.sender);
        _grantRole(UPGRADER_ROLE, msg.sender);

        feeToken = IERC20(_feeToken);
        pythOracle = IPyth(_pythOracle);
        priceFeedId = _priceFeedId;
    }

    // ── Internal price helpers ────────────────────────────────────────────────

    /// @dev Normalize a Pyth price struct to 6-decimal USDC units.
    function _normalizePrice(PythStructs.Price memory p) internal pure returns (uint256) {
        if (p.price <= 0) return 0;
        if (p.expo < 0) {
            uint256 d = uint256(uint32(-p.expo));
            if (d > 6) return uint256(uint64(p.price)) / (10 ** (d - 6));
            else return uint256(uint64(p.price)) * (10 ** (6 - d));
        } else {
            return uint256(uint64(p.price)) * (10 ** (6 + uint32(p.expo)));
        }
    }

    /// @dev Sum USD value (USDC 6-decimal) of all ERC20s in a BundleVault bundle.
    function _getBundleValue(uint256 nftId) internal view returns (uint256 totalValue) {
        (address[] memory tokens, uint256[] memory amounts,,) =
            IClawStreetBundleVault(bundleVault).getBundleContent(nftId);

        for (uint256 i = 0; i < tokens.length; i++) {
            bytes32 feedId = tokenPriceFeeds[tokens[i]];
            if (feedId == bytes32(0)) continue; // unmapped token — skip conservatively

            PythStructs.Price memory p = pythOracle.getPriceUnsafe(feedId);
            uint256 unitPrice = _normalizePrice(p); // price per whole token in USDC-6
            if (unitPrice == 0) continue;

            // amounts[i] is in token's native decimals — normalize using decimals()
            uint8 dec = IERC20Decimals(tokens[i]).decimals();
            uint256 tokenValue = (amounts[i] * unitPrice) / (10 ** dec);
            totalValue += tokenValue;
        }
    }

    // Health score using Pyth (0-100). Higher = healthier collateral.
    // For Bundle NFTs: sums value of each ERC20 using per-token price feeds.
    function getHealthScore(address nftContract, uint256 nftId, uint256 principal, address borrower) public view returns (uint256) {
        if (principal == 0) return 0;

        // ── Collateral valuation ────────────────────────────────────────────
        uint256 collateralValue;
        if (nftContract == bundleVault && bundleVault != address(0)) {
            // Bundle: sum all ERC20 assets using per-token Pyth feeds
            collateralValue = _getBundleValue(nftId);
        } else {
            // Single-asset NFT: use the global priceFeedId (e.g., ETH/USD floor)
            PythStructs.Price memory price = pythOracle.getPriceUnsafe(priceFeedId);
            if (price.price <= 0) return 0;
            collateralValue = _normalizePrice(price);
        }

        if (collateralValue == 0) return 0;

        // EMA price for volatility discount — still uses global feed for discount signal
        PythStructs.Price memory emaPrice = pythOracle.getEmaPriceUnsafe(priceFeedId);

        // LTV in basis points (10000 = 100%)
        uint256 ltvBps = (principal * 10000) / collateralValue;

        // Base Score: Max 100. Safe LTV threshold = 5000 (50%). Penalty = 2 points per 100 bps over 50%.
        uint256 baseScore = 100;
        if (ltvBps > 5000) {
            uint256 excess = ltvBps - 5000;
            uint256 penalty = (excess * 2) / 100;
            if (penalty >= 100) {
                baseScore = 0;
            } else {
                baseScore = 100 - penalty;
            }
        }

        // Volatility Discount
        // Uses global priceFeedId as market-wide volatility signal (works for both bundle and single-asset).
        // If spot < EMA by more than 5%, apply 10% discount.
        PythStructs.Price memory spotForVol = pythOracle.getPriceUnsafe(priceFeedId);
        uint256 discountMultiplier = 100; // 1.0x
        if (emaPrice.price > 0 && spotForVol.price > 0) {
            uint256 spot = uint256(uint64(spotForVol.price));
            uint256 ema = uint256(uint64(emaPrice.price));
            if (spot < ema) {
                uint256 dropBps = ((ema - spot) * 10000) / ema;
                if (dropBps > 500) { // 5% drop
                    discountMultiplier = 90; // 0.9x
                }
            }
        }

        // Reputation Multiplier
        uint256 repMultiplier = 100; // 1.0x
        if (address(reputationOracle) != address(0)) {
            uint256 score = reputationOracle.getAgentScore(borrower);
            if (score > 800) {
                repMultiplier = 110; // 1.10x
            } else if (score < 500) {
                repMultiplier = 90; // 0.90x
            }
        }

        // Final Score
        uint256 finalScore = (baseScore * discountMultiplier * repMultiplier) / 10000;
        return Math.min(100, finalScore);
    }

    // Suggested max LTV based on health (70% base, tighter on low health).
    // Formula: 9000 - (100 - health) * 200 bps.
    // Breakeven at health == 55 → 0 bps. Below 55 → 0 bps (no borrowing).
    // Reverts for health > 100 (getHealthScore already clamps to 100).
    function suggestLTV(uint256 health) public pure returns (uint256) {
        require(health <= 100, "Health out of range");
        if (health < 55) return 0;
        return Math.min(7000, 9000 - (100 - health) * 200);
    }

    function createLoanOffer(
        address nftContract,
        uint256 nftId,
        uint256 principal,
        uint256 interest,
        uint256 duration
    ) external nonReentrant whenNotPaused {
        require(principal > 0, "Principal must be > 0");
        require(duration >= MIN_DURATION, "Duration too short");

        // Escrow the NFT
        IERC721(nftContract).transferFrom(msg.sender, address(this), nftId);

        uint256 health = getHealthScore(nftContract, nftId, principal, msg.sender);
        uint256 loanId = loanCounter++;

        loans[loanId] = Loan({
            borrower: msg.sender,
            lender: address(0),
            nftContract: nftContract,
            nftId: nftId,
            principal: principal,
            interest: interest,
            duration: duration,
            startTime: 0,
            healthSnapshot: health,
            active: true,
            repaid: false
        });

        emit LoanCreated(loanId, msg.sender, principal, health);
    }

    function cancelLoanOffer(uint256 loanId) external nonReentrant whenNotPaused {
        Loan storage loan = loans[loanId];
        require(loan.active && loan.lender == address(0), "Cannot cancel active or funded loan");
        require(msg.sender == loan.borrower, "Not borrower");

        // Return NFT to borrower
        IERC721(loan.nftContract).transferFrom(address(this), loan.borrower, loan.nftId);

        loan.active = false;
        emit LoanCancelled(loanId);
    }

    function acceptLoan(uint256 loanId, bytes[] calldata priceUpdateData) external payable nonReentrant whenNotPaused {
        Loan storage loan = loans[loanId];
        require(loan.active && loan.lender == address(0), "Loan not available");
        require(msg.sender != loan.borrower, "Cannot lend to self");

        // Optional: update Pyth price for fresh health (pay oracle fee if needed)
        if (priceUpdateData.length > 0) {
            uint oracleFee = pythOracle.getUpdateFee(priceUpdateData);
            require(msg.value >= oracleFee, "Insufficient fee for Pyth");
            pythOracle.updatePriceFeeds{value: oracleFee}(priceUpdateData);

            // Refund excess ETH
            if (msg.value > oracleFee) {
                (bool success, ) = msg.sender.call{value: msg.value - oracleFee}("");
                require(success, "Refund failed");
            }
        }

        uint256 fee = (loan.principal * BROKER_FEE_BPS) / 10000;
        uint256 netPrincipal = loan.principal - fee;

        // Transfer net principal to borrower
        require(feeToken.transferFrom(msg.sender, loan.borrower, netPrincipal), "Principal transfer failed");
        require(feeToken.transferFrom(msg.sender, address(this), fee), "Fee transfer failed");

        loan.lender = msg.sender;
        loan.startTime = block.timestamp;

        // Forward fee to staking contract for revenue distribution.
        // Fee is already held in this contract; transfer directly then notify.
        if (address(stakingContract) != address(0) && fee > 0) {
            require(feeToken.transfer(address(stakingContract), fee), "Fee transfer to staking failed");
            stakingContract.notifyFee(fee);
        }

        emit LoanAccepted(loanId, msg.sender);
        emit FeeCollected(fee);
    }

    function repayLoan(uint256 loanId) external nonReentrant whenNotPaused {
        Loan storage loan = loans[loanId];
        require(loan.active && !loan.repaid, "Invalid loan state");
        require(msg.sender == loan.borrower, "Only borrower can repay");

        uint256 totalRepay = loan.principal + loan.interest;

        // Transfer repayment from borrower
        require(feeToken.transferFrom(loan.borrower, loan.lender, totalRepay), "Repayment failed");

        // Return NFT to borrower
        IERC721(loan.nftContract).transferFrom(address(this), loan.borrower, loan.nftId);

        loan.repaid = true;
        loan.active = false;

        emit LoanRepaid(loanId);
    }

    function claimDefault(uint256 loanId) external nonReentrant whenNotPaused {
        Loan storage loan = loans[loanId];
        require(loan.active && !loan.repaid, "Invalid loan");
        require(loan.lender != address(0), "Loan not funded");
        require(block.timestamp > loan.startTime + loan.duration, "Not yet defaulted");

        if (loan.nftContract == bundleVault && bundleVault != address(0)) {
            // Bundle collateral: auto-unwrap and distribute proportionally
            _settleDefaultBundle(loan);
        } else {
            // Standard NFT: lender receives the whole NFT as-is
            IERC721(loan.nftContract).transferFrom(address(this), loan.lender, loan.nftId);
        }

        loan.active = false;
        emit LoanDefaulted(loanId);
    }

    /// @dev Proportional bundle default settlement.
    ///      Captures bundle contents and value BEFORE calling withdrawBundle (which deletes storage).
    ///      If bundleValue <= debt: lender gets everything (full default).
    ///      If bundleValue > debt: each ERC20 split pro-rata; ERC721s in bundle go to lender.
    function _settleDefaultBundle(Loan storage loan) internal {
        uint256 debt = loan.principal + loan.interest;

        // Read contents and value BEFORE withdrawBundle() burns the NFT and deletes storage
        (
            address[] memory tokens,
            uint256[] memory amounts,
            address[] memory nfts721,
            uint256[] memory nft721Ids
        ) = IClawStreetBundleVault(bundleVault).getBundleContent(loan.nftId);

        uint256 bundleValue = _getBundleValue(loan.nftId);

        // Pull all underlying assets into this contract (burns the Bundle NFT)
        IClawStreetBundleVault(bundleVault).withdrawBundle(loan.nftId);

        if (bundleValue == 0 || bundleValue <= debt) {
            // Full default: lender receives 100% of all assets
            for (uint256 i = 0; i < tokens.length; i++) {
                IERC20(tokens[i]).safeTransfer(loan.lender, amounts[i]);
            }
            for (uint256 i = 0; i < nfts721.length; i++) {
                IERC721(nfts721[i]).transferFrom(address(this), loan.lender, nft721Ids[i]);
            }
        } else {
            // Partial default: lender's entitlement = debt / bundleValue fraction of each ERC20
            // WAD (1e18) precision prevents rounding loss on small amounts
            uint256 lenderFractionWad = (debt * 1e18) / bundleValue;

            for (uint256 i = 0; i < tokens.length; i++) {
                uint256 lenderAmt   = (amounts[i] * lenderFractionWad) / 1e18;
                uint256 borrowerAmt = amounts[i] - lenderAmt; // remainder — no dust loss

                if (lenderAmt > 0)   IERC20(tokens[i]).safeTransfer(loan.lender,   lenderAmt);
                if (borrowerAmt > 0) IERC20(tokens[i]).safeTransfer(loan.borrower, borrowerAmt);
            }
            // ERC721s inside bundle: non-divisible — go to lender (conservative)
            for (uint256 i = 0; i < nfts721.length; i++) {
                IERC721(nfts721[i]).transferFrom(address(this), loan.lender, nft721Ids[i]);
            }
        }
    }

    // Admin functions
    function pause() external onlyRole(ADMIN_ROLE) {
        _pause();
    }

    function unpause() external onlyRole(ADMIN_ROLE) {
        _unpause();
    }

    function setReputationOracle(address _reputationOracle) external onlyRole(ADMIN_ROLE) {
        reputationOracle = IAgentReputation(_reputationOracle);
    }

    /**
     * @notice Set the staking contract that receives broker fee notifications.
     *         Call after deploying ClawStreetStaking.
     */
    function setStakingContract(address _stakingContract) external onlyRole(ADMIN_ROLE) {
        stakingContract = IClawStreetStaking(_stakingContract);
        emit StakingContractSet(_stakingContract);
    }

    /// @notice Set the BundleVault address so the loan engine can read bundle contents.
    function setBundleVault(address _bundleVault) external onlyRole(ADMIN_ROLE) {
        bundleVault = _bundleVault;
    }

    /// @notice Map an ERC20 token address to its Pyth price feed ID.
    ///         Must be set for each token used in bundle collateral.
    function setTokenPriceFeed(address token, bytes32 feedId) external onlyRole(ADMIN_ROLE) {
        tokenPriceFeeds[token] = feedId;
    }

    /**
     * @notice Emergency fee sweep — pulls any USDC sitting in this contract
     *         that was NOT forwarded to the staking contract (e.g., before staking
     *         was configured, or if notifyFee path was skipped).
     * @param to Treasury or multisig address to receive the fees.
     */
    function withdrawFees(address to) external onlyRole(ADMIN_ROLE) {
        require(to != address(0), "Zero address");
        uint256 balance = feeToken.balanceOf(address(this));
        require(balance > 0, "No fees to withdraw");
        require(feeToken.transfer(to, balance), "Transfer failed");
        emit FeesWithdrawn(to, balance);
    }

    function _authorizeUpgrade(address newImplementation) internal override onlyRole(UPGRADER_ROLE) {}
}
