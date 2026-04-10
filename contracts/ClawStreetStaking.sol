// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC721/ERC721.sol";
import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "@openzeppelin/contracts/utils/math/Math.sol";

/**
 * @title ClawStreetStaking
 * @notice Stake $CLAW → receive a ClawPass ERC-721 (governance + revenue share).
 *
 * Mechanics:
 *  - `stake(amount)` — locks CLAW for LOCK_PERIOD. Mints one ClawPass NFT per staker
 *    (subsequent stakes top-up the existing position; lock restarts).
 *  - `unstake()` — burns the ClawPass and returns CLAW after LOCK_PERIOD.
 *  - `notifyFee(amount)` — called by ClawStreetLoan when broker fees are collected.
 *    Updates the global revenue-per-share accumulator.
 *  - `claimRevenue()` — pulls staker's accrued USDC share.
 *
 * Revenue distribution:
 *  Uses a "reward-per-share" accumulator (ERC-4626-style) so each staker earns
 *  proportional to their staked CLAW relative to the total staked at the time
 *  fees were notified.
 *
 *  revenuePerShareAccumulated += feeAmount * PRECISION / totalStaked
 *  stakerDebt[staker] = revenuePerShareAccumulated   (updated on stake/claim)
 *  pending = staked[staker] * (accumulator - stakerDebt[staker]) / PRECISION
 *
 * ClawPass NFT:
 *  - Soul-bound (non-transferable) for MVP — transfer restricted to address(0) (mint/burn only).
 *  - One pass per staker. tokenId == staker's passId stored in passOf mapping.
 *  - Metadata URI set by owner (IPFS).
 */
contract ClawStreetStaking is ERC721, Ownable, ReentrancyGuard {
    // ─── Constants ────────────────────────────────────────────────────────────
    uint256 public constant LOCK_PERIOD = 30 days;
    uint256 private constant PRECISION = 1e18;

    // ─── State ────────────────────────────────────────────────────────────────
    IERC20 public immutable clawToken;
    IERC20 public immutable revenueToken; // USDC (6 decimals)

    // Authorised callers that can notify fees (ClawStreetLoan, CallVault in future)
    mapping(address => bool) public feeNotifiers;

    // Global revenue accumulator (scaled by PRECISION)
    uint256 public revenuePerShareAccumulated;

    // Per-staker state
    struct Position {
        uint256 staked;       // CLAW staked (18 decimals)
        uint256 stakedAt;     // last stake timestamp (lock restarts on top-up)
        uint256 rewardDebt;   // accumulator snapshot at last stake/claim
        uint256 passId;       // ClawPass NFT token ID (0 = not minted yet)
        bool hasPass;
    }

    mapping(address => Position) public positions;

    uint256 public totalStaked;
    uint256 public nextPassId = 1; // start from 1 so hasPass=false can use 0 safely

    string public baseTokenURI;

    // ─── Events ───────────────────────────────────────────────────────────────
    event Staked(address indexed staker, uint256 amount, uint256 totalStaked);
    event Unstaked(address indexed staker, uint256 amount);
    event RevenueClaimed(address indexed staker, uint256 amount);
    event FeeNotified(address indexed notifier, uint256 amount);
    event FeeNotifierSet(address indexed notifier, bool enabled);
    event BaseURIUpdated(string newURI);

    // ─── Constructor ──────────────────────────────────────────────────────────
    constructor(
        address _clawToken,
        address _revenueToken,
        address _owner
    ) ERC721("ClawPass", "CLAWPASS") Ownable(_owner) {
        clawToken = IERC20(_clawToken);
        revenueToken = IERC20(_revenueToken);
    }

    // ─── Admin ────────────────────────────────────────────────────────────────

    /**
     * @notice Authorise or revoke a contract that can call notifyFee.
     *         Set ClawStreetLoan address here after deployment.
     */
    function setFeeNotifier(address notifier, bool enabled) external onlyOwner {
        feeNotifiers[notifier] = enabled;
        emit FeeNotifierSet(notifier, enabled);
    }

    function setBaseURI(string calldata uri) external onlyOwner {
        baseTokenURI = uri;
        emit BaseURIUpdated(uri);
    }

    // ─── Revenue accounting ───────────────────────────────────────────────────

    /**
     * @notice Called by ClawStreetLoan (or other fee sources) when USDC fees land.
     *         The caller must have already transferred `amount` USDC to this contract.
     */
    function notifyFee(uint256 amount) external {
        require(feeNotifiers[msg.sender], "Not authorised fee notifier");
        require(amount > 0, "Zero fee");

        if (totalStaked == 0) {
            // No stakers — fees accumulate in contract, claimable later
            return;
        }

        revenuePerShareAccumulated += (amount * PRECISION) / totalStaked;
        emit FeeNotified(msg.sender, amount);
    }

    // ─── Staking ──────────────────────────────────────────────────────────────

    /**
     * @notice Stake CLAW. If caller already has a position, tops it up and restarts lock.
     *         Mints a ClawPass NFT on first stake.
     * @param amount CLAW amount (18 decimals).
     */
    function stake(uint256 amount) external nonReentrant {
        require(amount > 0, "Cannot stake 0");

        Position storage pos = positions[msg.sender];

        // Settle any pending revenue before changing balance
        _settleRevenue(msg.sender);

        // Pull CLAW from caller
        require(clawToken.transferFrom(msg.sender, address(this), amount), "Transfer failed");

        pos.staked += amount;
        pos.stakedAt = block.timestamp; // restart lock on top-up
        pos.rewardDebt = revenuePerShareAccumulated;
        totalStaked += amount;

        // Mint ClawPass on first stake
        if (!pos.hasPass) {
            uint256 passId = nextPassId++;
            pos.passId = passId;
            pos.hasPass = true;
            _safeMint(msg.sender, passId);
        }

        emit Staked(msg.sender, amount, totalStaked);
    }

    /**
     * @notice Unstake all CLAW. Burns ClawPass. Lock period must have elapsed.
     */
    function unstake() external nonReentrant {
        Position storage pos = positions[msg.sender];
        require(pos.staked > 0, "Nothing staked");
        require(block.timestamp >= pos.stakedAt + LOCK_PERIOD, "Still locked");

        // Settle revenue first
        _settleRevenue(msg.sender);

        uint256 amount = pos.staked;

        // Burn pass
        uint256 passId = pos.passId;
        pos.staked = 0;
        pos.hasPass = false;
        pos.passId = 0;
        totalStaked -= amount;

        _burn(passId);

        require(clawToken.transfer(msg.sender, amount), "CLAW return failed");
        emit Unstaked(msg.sender, amount);
    }

    /**
     * @notice Claim accrued USDC revenue share without unstaking.
     */
    function claimRevenue() external nonReentrant {
        require(positions[msg.sender].staked > 0, "Nothing staked");
        _settleRevenue(msg.sender);
    }

    // ─── Views ────────────────────────────────────────────────────────────────

    /**
     * @notice Pending USDC revenue for a staker (not yet claimed).
     */
    function pendingRevenue(address staker) external view returns (uint256) {
        Position storage pos = positions[staker];
        if (pos.staked == 0) return 0;
        uint256 diff = revenuePerShareAccumulated - pos.rewardDebt;
        return (pos.staked * diff) / PRECISION;
    }

    /**
     * @notice Seconds remaining in the lock period for a staker. 0 if unlocked.
     */
    function lockRemaining(address staker) external view returns (uint256) {
        Position storage pos = positions[staker];
        if (pos.staked == 0) return 0;
        uint256 unlockAt = pos.stakedAt + LOCK_PERIOD;
        if (block.timestamp >= unlockAt) return 0;
        return unlockAt - block.timestamp;
    }

    // ─── Internal ─────────────────────────────────────────────────────────────

    function _settleRevenue(address staker) internal {
        Position storage pos = positions[staker];
        if (pos.staked == 0) return;

        uint256 diff = revenuePerShareAccumulated - pos.rewardDebt;
        if (diff == 0) return;

        uint256 pending = (pos.staked * diff) / PRECISION;
        pos.rewardDebt = revenuePerShareAccumulated;

        if (pending > 0) {
            require(revenueToken.transfer(staker, pending), "Revenue transfer failed");
            emit RevenueClaimed(staker, pending);
        }
    }

    // ─── ERC-721 overrides (soul-bound) ───────────────────────────────────────

    /**
     * @dev Block all transfers except mint (from == 0) and burn (to == 0).
     *      ClawPass is soul-bound: it tracks the staker, not a tradeable asset.
     */
    function transferFrom(address from, address to, uint256 tokenId) public override {
        require(from == address(0) || to == address(0), "ClawPass: non-transferable");
        super.transferFrom(from, to, tokenId);
    }

    function safeTransferFrom(address from, address to, uint256 tokenId, bytes memory data) public override {
        require(from == address(0) || to == address(0), "ClawPass: non-transferable");
        super.safeTransferFrom(from, to, tokenId, data);
    }

    function _baseURI() internal view override returns (string memory) {
        return baseTokenURI;
    }
}
