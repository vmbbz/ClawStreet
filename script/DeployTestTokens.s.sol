// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Script.sol";
import "forge-std/console.sol";
import "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import "@openzeppelin/contracts/access/Ownable.sol";

/**
 * @title TestToken
 * @notice Generic mintable ERC-20 (18 decimals) for Base Sepolia testing.
 *         Each token is semantically mapped to a real Pyth price feed in the
 *         frontend (src/config/contracts.ts TOKEN_PRICE_FEEDS).
 *
 *  Token      Pyth Feed (display only — no on-chain oracle)
 *  TestWETH → ETH/USD  0xff61491a931112ddf1bd8147cd1b641375f79f5825126d665480874634fd0ace
 *  TestWBTC → BTC/USD  0xe62df6c8b4a85fe1a67db44dc12de5db330f7ac66b72dc658afedf0f4a415b43
 *  TestLINK → LINK/USD 0x8ac0c70fff57e9aefdf5edf44b51d62c2d433653cbb2cf5cc06bb115af04d221
 */
contract TestToken is ERC20, Ownable {
    constructor(string memory name_, string memory symbol_, address owner_)
        ERC20(name_, symbol_)
        Ownable(owner_)
    {}

    function mint(address to, uint256 amount) external onlyOwner {
        _mint(to, amount);
    }

    function mintHuman(address to, uint256 humanAmount) external onlyOwner {
        _mint(to, humanAmount * 1e18);
    }

    function disperseEqual(address[] calldata recipients, uint256 amountEach) external onlyOwner {
        for (uint256 i; i < recipients.length; i++) {
            if (recipients[i] != address(0)) _mint(recipients[i], amountEach);
        }
    }
}

/**
 * @title DeployTestTokens
 * @notice Deploys TestWETH, TestWBTC, and TestLINK to Base Sepolia, then
 *         optionally distributes them to the 5 agent wallets.
 *
 * Usage:
 *   forge script script/DeployTestTokens.s.sol \
 *     --rpc-url base_sepolia \
 *     --broadcast --verify -vvvv
 *
 * Required .env:
 *   DEPLOYER_PRIVATE_KEY
 *
 * Optional .env (skipped if not set):
 *   AGENT1_ADDRESS through AGENT5_ADDRESS
 */
contract DeployTestTokens is Script {

    // Distribution amounts (18 decimals, human-readable × 1e18)
    uint256 constant WETH_AGENT  = 5 * 1e18;     // 5 TestWETH each
    uint256 constant WBTC_AGENT  = 1 * 1e17;     // 0.1 TestWBTC each
    uint256 constant LINK_AGENT  = 100 * 1e18;   // 100 TestLINK each

    function run() external {
        uint256 deployerKey = vm.envUint("DEPLOYER_PRIVATE_KEY");
        address deployer    = vm.addr(deployerKey);

        address agent1 = _envAddressOr("AGENT1_ADDRESS", address(0));
        address agent2 = _envAddressOr("AGENT2_ADDRESS", address(0));
        address agent3 = _envAddressOr("AGENT3_ADDRESS", address(0));
        address agent4 = _envAddressOr("AGENT4_ADDRESS", address(0));
        address agent5 = _envAddressOr("AGENT5_ADDRESS", address(0));

        console.log("\n=================================================");
        console.log("Deploy Test Tokens (TestWETH / TestWBTC / TestLINK)");
        console.log("=================================================");
        console.log("Deployer:", deployer);

        vm.startBroadcast(deployerKey);

        // Deploy
        TestToken weth = new TestToken("Test Wrapped Ether",   "tWETH", deployer);
        TestToken wbtc = new TestToken("Test Wrapped Bitcoin",  "tWBTC", deployer);
        TestToken link = new TestToken("Test Chainlink Token",  "tLINK", deployer);

        console.log("\n[1/3] TestWETH:", address(weth));
        console.log("[2/3] TestWBTC:", address(wbtc));
        console.log("[3/3] TestLINK:", address(link));

        // Distribute to agents
        address[5] memory agents = [agent1, agent2, agent3, agent4, agent5];
        string[5] memory names   = ["Agent1_Alpha", "Agent2_Beta", "Agent3_Gamma", "Agent4_Delta", "Agent5_Epsilon"];

        console.log("\n-- Distributing to agents --");
        for (uint256 i; i < 5; i++) {
            if (agents[i] == address(0)) {
                console.log("  SKIP (not set):", names[i]);
                continue;
            }
            weth.mint(agents[i], WETH_AGENT);
            wbtc.mint(agents[i], WBTC_AGENT);
            link.mint(agents[i], LINK_AGENT);
            console.log(string.concat("  Funded ", names[i], ": 5 tWETH, 0.1 tWBTC, 100 tLINK"));
        }

        vm.stopBroadcast();

        console.log("\n=================================================");
        console.log("DONE — add these to src/config/contracts.ts:");
        console.log("=================================================");
        console.log("TEST_TOKENS.WETH:", address(weth));
        console.log("TEST_TOKENS.WBTC:", address(wbtc));
        console.log("TEST_TOKENS.LINK:", address(link));
        console.log("");
        console.log("Verify at: https://sepolia.basescan.org");
    }

    function _envAddressOr(string memory key, address fallback_) internal view returns (address) {
        try vm.envAddress(key) returns (address val) { return val; }
        catch { return fallback_; }
    }
}
