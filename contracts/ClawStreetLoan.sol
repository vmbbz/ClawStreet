// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/access/AccessControlUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/utils/PausableUpgradeable.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

import "@openzeppelin/contracts/token/ERC721/IERC721.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/utils/math/Math.sol";

import "@pythnetwork/pyth-sdk-solidity/IPyth.sol";
import "@pythnetwork/pyth-sdk-solidity/PythStructs.sol";
import "./interfaces/IAgentReputation.sol";

interface IClawStreetStaking {
    function notifyFee(uint256 amount) external;
}

contract ClawStreetLoan is
    Initializable,
    UUPSUpgradeable,
    AccessControlUpgradeable,
    PausableUpgradeable,
    ReentrancyGuard
{
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

    // Health score using Pyth (0-100). Higher = healthier collateral.
    function getHealthScore(address nftContract, uint256 nftId, uint256 principal, address borrower) public view returns (uint256) {
        // In production: fetch latest price + volatility via Pyth updateData
        PythStructs.Price memory price = pythOracle.getPriceUnsafe(priceFeedId);
        PythStructs.Price memory emaPrice = pythOracle.getEmaPriceUnsafe(priceFeedId);

        if (price.price <= 0 || principal == 0) {
            return 0;
        }

        // Normalize price to 6 decimals (assuming principal is 6 decimals)
        uint256 collateralValue;
        if (price.expo < 0) {
            uint256 decimals = uint256(uint32(-price.expo));
            if (decimals > 6) {
                collateralValue = uint256(uint64(price.price)) / (10 ** (decimals - 6));
            } else {
                collateralValue = uint256(uint64(price.price)) * (10 ** (6 - decimals));
            }
        } else {
            collateralValue = uint256(uint64(price.price)) * (10 ** (6 + uint32(price.expo)));
        }

        if (collateralValue == 0) return 0;

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
        // If spot < EMA by more than 5%, apply 10% discount
        uint256 discountMultiplier = 100; // 1.0x
        if (emaPrice.price > 0) {
            uint256 spot = uint256(uint64(price.price));
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

        // Lender claims the NFT
        IERC721(loan.nftContract).transferFrom(address(this), loan.lender, loan.nftId);

        loan.active = false;

        emit LoanDefaulted(loanId);
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
