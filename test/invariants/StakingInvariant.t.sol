// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Test.sol";
import "forge-std/StdInvariant.sol";
import "forge-std/Base.sol";
import "forge-std/StdCheats.sol";
import "forge-std/StdUtils.sol";
import { ClawToken } from "../../contracts/ClawToken.sol";
import { ClawStreetStaking } from "../../contracts/ClawStreetStaking.sol";

// ─── MockUSDC ──────────────────────────────────────────────────────────────────

contract MockUSDC {
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;
    uint8 public decimals = 6;

    function mint(address to, uint256 amount) external {
        balanceOf[to] += amount;
    }

    function transfer(address to, uint256 amount) external returns (bool) {
        require(balanceOf[msg.sender] >= amount, "insufficient");
        balanceOf[msg.sender] -= amount;
        balanceOf[to] += amount;
        return true;
    }

    function transferFrom(address from, address to, uint256 amount) external returns (bool) {
        require(balanceOf[from] >= amount, "insufficient");
        require(allowance[from][msg.sender] >= amount, "allowance");
        allowance[from][msg.sender] -= amount;
        balanceOf[from] -= amount;
        balanceOf[to] += amount;
        return true;
    }

    function approve(address spender, uint256 amount) external returns (bool) {
        allowance[msg.sender][spender] = amount;
        return true;
    }
}

// ─── Handler ───────────────────────────────────────────────────────────────────

contract StakingHandler is CommonBase, StdCheats, StdUtils {
    ClawStreetStaking public staking;
    ClawToken         public claw;
    MockUSDC          public usdc;

    address[] public actors;

    // Ghost variables — track expected protocol state
    uint256 public ghost_totalStaked;
    uint256 public ghost_totalFeesNotified;

    address internal constant OWNER = address(0xdead);

    constructor(ClawStreetStaking _staking, ClawToken _claw, MockUSDC _usdc) {
        staking = _staking;
        claw    = _claw;
        usdc    = _usdc;

        for (uint256 i = 0; i < 5; i++) {
            actors.push(address(uint160(0x1000 + i)));
        }
    }

    function stake(uint96 rawAmount, uint256 actorSeed) external {
        address actor  = actors[actorSeed % actors.length];
        uint256 amount = bound(rawAmount, 1e18, 10_000e18);

        vm.prank(OWNER);
        claw.mint(actor, amount);

        vm.startPrank(actor);
        claw.approve(address(staking), amount);
        staking.stake(amount);
        vm.stopPrank();

        ghost_totalStaked += amount;
    }

    function unstake(uint256 actorSeed) external {
        address actor = actors[actorSeed % actors.length];
        (uint256 stakedAmt, uint256 stakedAt,,,) = staking.positions(actor);
        if (stakedAmt == 0) return;
        if (block.timestamp < stakedAt + staking.LOCK_PERIOD()) return;

        vm.prank(actor);
        staking.unstake();

        ghost_totalStaked -= stakedAmt;
    }

    function notifyFee(uint64 rawFee) external {
        uint256 fee = bound(rawFee, 1_000, 100_000e6);

        // Pre-fund the staking contract with USDC (simulates loan contract transfer)
        usdc.mint(address(staking), fee);

        // Handler is authorised as feeNotifier
        staking.notifyFee(fee);

        ghost_totalFeesNotified += fee;
    }

    function claimRevenue(uint256 actorSeed) external {
        address actor = actors[actorSeed % actors.length];
        (uint256 stakedAmt,,,,) = staking.positions(actor);
        if (stakedAmt == 0) return;

        vm.prank(actor);
        staking.claimRevenue();
    }

    function warpTime(uint32 rawSecs) external {
        uint256 secs = bound(rawSecs, 1, 45 days);
        vm.warp(block.timestamp + secs);
    }

    function getActors() external view returns (address[] memory) {
        return actors;
    }
}

// ─── Invariant Test ────────────────────────────────────────────────────────────

contract StakingInvariantTest is Test {
    StakingHandler    public handler;
    ClawStreetStaking public staking;
    ClawToken         public claw;
    MockUSDC          public usdc;

    address constant OWNER = address(0xdead);

    function setUp() public {
        vm.startPrank(OWNER);
        claw = new ClawToken(OWNER);
        vm.stopPrank();

        usdc = new MockUSDC();

        staking = new ClawStreetStaking(address(claw), address(usdc), OWNER);

        handler = new StakingHandler(staking, claw, usdc);

        // Authorise handler as fee notifier
        vm.prank(OWNER);
        staking.setFeeNotifier(address(handler), true);

        targetContract(address(handler));

        bytes4[] memory selectors = new bytes4[](5);
        selectors[0] = StakingHandler.stake.selector;
        selectors[1] = StakingHandler.unstake.selector;
        selectors[2] = StakingHandler.notifyFee.selector;
        selectors[3] = StakingHandler.claimRevenue.selector;
        selectors[4] = StakingHandler.warpTime.selector;
        targetSelector(FuzzSelector({ addr: address(handler), selectors: selectors }));
    }

    /// @notice totalStaked must equal the sum of all actor position balances.
    function invariant_totalStaked_equalsPositionSum() public view {
        address[] memory a = handler.getActors();
        uint256 sum;
        for (uint256 i; i < a.length; i++) {
            (uint256 s,,,,) = staking.positions(a[i]);
            sum += s;
        }
        assertEq(staking.totalStaked(), sum, "totalStaked != sum of positions");
    }

    /// @notice Ghost tracker matches on-chain totalStaked (no phantom minting).
    function invariant_ghostTotalStaked_matchesOnChain() public view {
        assertEq(handler.ghost_totalStaked(), staking.totalStaked(), "ghost_totalStaked mismatch");
    }

    /// @notice USDC balance in contract is always >= sum of all pending revenues (no over-promise).
    function invariant_noInflation_usdcGeqPending() public view {
        address[] memory a = handler.getActors();
        uint256 totalPending;
        for (uint256 i; i < a.length; i++) {
            totalPending += staking.pendingRevenue(a[i]);
        }
        assertGe(
            usdc.balanceOf(address(staking)),
            totalPending,
            "USDC balance < total pending revenue (inflation)"
        );
    }

    /// @notice hasPass is true iff staked > 0 (NFT lifecycle matches position lifecycle).
    function invariant_hasPass_iff_staked() public view {
        address[] memory a = handler.getActors();
        for (uint256 i; i < a.length; i++) {
            (uint256 s,,, uint256 passId, bool hasPass) = staking.positions(a[i]);
            if (s > 0) {
                assertTrue(hasPass, "Staker missing ClawPass");
            } else {
                assertFalse(hasPass, "Unstaked actor still has pass flag");
                assertEq(passId, 0, "passId should be 0 when unstaked");
            }
        }
    }

    /// @notice When a staker holds a ClawPass, the NFT owner on-chain is that staker.
    function invariant_nftOwner_matchesStaker() public view {
        address[] memory a = handler.getActors();
        for (uint256 i; i < a.length; i++) {
            (uint256 s,,, uint256 passId, bool hasPass) = staking.positions(a[i]);
            if (hasPass && s > 0) {
                assertEq(staking.ownerOf(passId), a[i], "NFT owner != staker");
            }
        }
    }

    /// @notice rewardDebt never exceeds the global accumulator (cannot earn from the future).
    function invariant_rewardDebt_leq_accumulator() public view {
        address[] memory a = handler.getActors();
        uint256 accumulator = staking.revenuePerShareAccumulated();
        for (uint256 i; i < a.length; i++) {
            (,, uint256 rewardDebt,,) = staking.positions(a[i]);
            assertLe(rewardDebt, accumulator, "rewardDebt > accumulator");
        }
    }

    /// @notice unallocatedFees never exceeds the USDC balance held by the contract.
    function invariant_unallocatedFees_leq_usdcBalance() public view {
        assertLe(
            staking.unallocatedFees(),
            usdc.balanceOf(address(staking)),
            "unallocatedFees > USDC balance"
        );
    }
}
