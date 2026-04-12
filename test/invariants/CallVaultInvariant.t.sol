// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Test.sol";
import "forge-std/StdInvariant.sol";
import "forge-std/Base.sol";
import "forge-std/StdCheats.sol";
import "forge-std/StdUtils.sol";
import { ERC1967Proxy } from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";
import { ClawStreetCallVault } from "../../contracts/ClawStreetCallVault.sol";

// ─── MockToken ─────────────────────────────────────────────────────────────────

contract MockToken {
    string  public name;
    string  public symbol;
    uint8   public decimals;
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    constructor(string memory _name, string memory _symbol, uint8 _decimals) {
        name     = _name;
        symbol   = _symbol;
        decimals = _decimals;
    }

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

contract CallVaultHandler is CommonBase, StdCheats, StdUtils {
    ClawStreetCallVault public vault;
    MockToken           public underlying;
    MockToken           public usdc;

    address[] public writers;
    address[] public buyers;

    uint256[] public optionIds;
    mapping(uint256 => bool) public isActive;
    mapping(uint256 => bool) public isBought;
    mapping(uint256 => bool) public isExercised;
    mapping(uint256 => bool) public isCancelled;   // pre-buy cancel by writer
    mapping(uint256 => bool) public isReclaimed;   // post-expiry reclaim by writer

    // Ghost: underlying that should be locked in the vault
    uint256 public ghost_totalUnderlyingLocked;

    constructor(ClawStreetCallVault _vault, MockToken _underlying, MockToken _usdc) {
        vault      = _vault;
        underlying = _underlying;
        usdc       = _usdc;

        for (uint256 i; i < 3; i++) {
            writers.push(address(uint160(0x100 + i)));
            buyers.push(address(uint160(0x200 + i)));
        }
    }

    // ── Actions ────────────────────────────────────────────────────────────────

    function writeOption(
        uint96 rawAmount,
        uint96 rawStrike,
        uint96 rawPremium,
        uint32 rawExpiry,
        uint256 writerSeed
    ) external {
        address writer  = writers[writerSeed % writers.length];
        uint256 amount  = bound(rawAmount,  1e15,  100e18);
        uint256 strike  = bound(rawStrike,  1e6,   1_000_000e6);
        uint256 premium = bound(rawPremium, 1e6,   10_000e6);
        uint256 expiry  = block.timestamp + bound(rawExpiry, 1 hours, 30 days);

        underlying.mint(writer, amount);

        vm.startPrank(writer);
        underlying.approve(address(vault), amount);
        uint256 optId = vault.writeCoveredCall(address(underlying), amount, strike, expiry, premium);
        vm.stopPrank();

        optionIds.push(optId);
        isActive[optId] = true;
        ghost_totalUnderlyingLocked += amount;
    }

    function buyOption(uint256 optionSeed, uint256 buyerSeed) external {
        if (optionIds.length == 0) return;
        uint256 optId = optionIds[optionSeed % optionIds.length];
        if (!isActive[optId] || isBought[optId] || isCancelled[optId] || isExercised[optId]) return;

        (,,,,,uint256 expiry, uint256 premium,,) = vault.options(optId);
        if (block.timestamp >= expiry) return;

        address buyer = buyers[buyerSeed % buyers.length];
        usdc.mint(buyer, premium);

        vm.startPrank(buyer);
        usdc.approve(address(vault), premium);
        vault.buyOption(optId);
        vm.stopPrank();

        isBought[optId] = true;
    }

    function exerciseOption(uint256 optionSeed) external {
        if (optionIds.length == 0) return;
        uint256 optId = optionIds[optionSeed % optionIds.length];
        if (!isActive[optId] || !isBought[optId] || isExercised[optId] || isCancelled[optId]) return;

        (,address buyer,, uint256 amount, uint256 strike, uint256 expiry,,,) = vault.options(optId);
        if (block.timestamp >= expiry) return;

        usdc.mint(buyer, strike);

        vm.startPrank(buyer);
        usdc.approve(address(vault), strike);
        vault.exercise(optId);
        vm.stopPrank();

        isExercised[optId]  = true;
        isActive[optId]     = false;
        ghost_totalUnderlyingLocked -= amount;
    }

    function reclaimOption(uint256 optionSeed) external {
        if (optionIds.length == 0) return;
        uint256 optId = optionIds[optionSeed % optionIds.length];
        if (!isActive[optId] || isExercised[optId] || isCancelled[optId] || isReclaimed[optId]) return;

        (address writer,,, uint256 amount,, uint256 expiry,,,) = vault.options(optId);
        if (block.timestamp <= expiry) return;

        vm.prank(writer);
        vault.reclaimUnderlying(optId);

        isActive[optId]   = false;
        isReclaimed[optId] = true;
        ghost_totalUnderlyingLocked -= amount;
    }

    function cancelOption(uint256 optionSeed) external {
        if (optionIds.length == 0) return;
        uint256 optId = optionIds[optionSeed % optionIds.length];
        if (!isActive[optId] || isBought[optId] || isExercised[optId] || isCancelled[optId]) return;

        (address writer,,, uint256 amount,,,,, ) = vault.options(optId);

        vm.prank(writer);
        vault.cancelOption(optId);

        isActive[optId]    = false;
        isCancelled[optId] = true;
        ghost_totalUnderlyingLocked -= amount;
    }

    function warpTime(uint32 rawSecs) external {
        uint256 secs = bound(rawSecs, 1, 31 days);
        vm.warp(block.timestamp + secs);
    }

    function getOptionIds() external view returns (uint256[] memory) {
        return optionIds;
    }
}

// ─── Invariant Test ────────────────────────────────────────────────────────────

contract CallVaultInvariantTest is Test {
    CallVaultHandler    public handler;
    ClawStreetCallVault public vault;
    MockToken           public underlying;
    MockToken           public usdc;

    // Track last optionCounter to check monotonicity
    uint256 internal lastCounter;

    function setUp() public {
        underlying = new MockToken("Wrapped ETH", "WETH", 18);
        usdc       = new MockToken("USD Coin",    "USDC",  6);

        address admin = address(0xAD);
        vm.startPrank(admin);
        ClawStreetCallVault impl = new ClawStreetCallVault();
        bytes memory init = abi.encodeCall(ClawStreetCallVault.initialize, (address(usdc)));
        ERC1967Proxy proxy = new ERC1967Proxy(address(impl), init);
        vault = ClawStreetCallVault(address(proxy));
        vm.stopPrank();

        handler = new CallVaultHandler(vault, underlying, usdc);

        targetContract(address(handler));

        bytes4[] memory selectors = new bytes4[](6);
        selectors[0] = CallVaultHandler.writeOption.selector;
        selectors[1] = CallVaultHandler.buyOption.selector;
        selectors[2] = CallVaultHandler.exerciseOption.selector;
        selectors[3] = CallVaultHandler.reclaimOption.selector;
        selectors[4] = CallVaultHandler.cancelOption.selector;
        selectors[5] = CallVaultHandler.warpTime.selector;
        targetSelector(FuzzSelector({ addr: address(handler), selectors: selectors }));
    }

    /// @notice Vault's underlying balance >= total underlying locked in active options.
    function invariant_vaultUnderlyingGeqActiveLocked() public view {
        uint256[] memory ids = handler.getOptionIds();
        uint256 locked;
        for (uint256 i; i < ids.length; i++) {
            (,,,uint256 amount,,,,, bool active) = vault.options(ids[i]);
            if (active) locked += amount;
        }
        assertGe(
            underlying.balanceOf(address(vault)),
            locked,
            "Vault underlying balance < active locked amount"
        );
    }

    /// @notice Ghost tracker matches on-chain vault underlying balance exactly.
    function invariant_ghostLocked_matchesVaultBalance() public view {
        assertEq(
            underlying.balanceOf(address(vault)),
            handler.ghost_totalUnderlyingLocked(),
            "ghost_totalUnderlyingLocked != actual vault balance"
        );
    }

    /// @notice An exercised option is never marked active.
    function invariant_exercised_implies_notActive() public view {
        uint256[] memory ids = handler.getOptionIds();
        for (uint256 i; i < ids.length; i++) {
            (,,,,,,,bool exercised, bool active) = vault.options(ids[i]);
            if (exercised) {
                assertFalse(active, "Exercised option is still marked active");
            }
        }
    }

    /// @notice An active option always has a non-zero expiry (sanity on write path).
    function invariant_activeOption_hasExpiry() public view {
        uint256[] memory ids = handler.getOptionIds();
        for (uint256 i; i < ids.length; i++) {
            (,,,,, uint256 expiry,,, bool active) = vault.options(ids[i]);
            if (active) {
                assertGt(expiry, 0, "Active option has zero expiry");
            }
        }
    }

    /// @notice optionCounter is monotonically non-decreasing.
    function invariant_optionCounter_monotonic() public {
        uint256 current = vault.optionCounter();
        assertGe(current, lastCounter, "optionCounter decreased");
        lastCounter = current;
    }

    /// @notice cancelOption can only be called before the option is bought.
    ///         isCancelled and isBought must be mutually exclusive.
    function invariant_cancelOnlyBeforeBuy() public view {
        uint256[] memory ids = handler.getOptionIds();
        for (uint256 i; i < ids.length; i++) {
            assertFalse(
                handler.isCancelled(ids[i]) && handler.isBought(ids[i]),
                "isCancelled and isBought are both true for the same option"
            );
        }
    }
}
