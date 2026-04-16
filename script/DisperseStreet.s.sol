// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Script.sol";
import "forge-std/console.sol";
import "../contracts/ClawToken.sol";

/**
 * @title DisperseStreet
 * @notice Mints $STREET to all 5 agent wallets from the deployer (owner).
 *         Amounts mirror the original DeployAll.s.sol allocations.
 */
contract DisperseStreet is Script {
    function run() external {
        uint256 deployerKey = vm.envUint("DEPLOYER_PRIVATE_KEY");
        address deployer    = vm.addr(deployerKey);

        ClawToken street = ClawToken(vm.envAddress("CLAW_TOKEN_ADDRESS"));

        address agent1 = vm.envAddress("AGENT1_ADDRESS");
        address agent2 = vm.envAddress("AGENT2_ADDRESS");
        address agent5 = vm.envAddress("AGENT5_ADDRESS");

        console.log("Dispersing $STREET to agents...");
        console.log("  Token:   ", address(street));
        console.log("  Deployer:", deployer);

        vm.startBroadcast(deployerKey);

        // Market Maker + Arbitrageur + Hedge Writer get STREET
        street.mint(agent1, 100_000 * 1e18); // 100k  - LiquidityAgent_Alpha
        street.mint(agent2,  50_000 * 1e18); // 50k   - ArbitrageAgent_Beta
        street.mint(agent5,  50_000 * 1e18); // 50k   - HedgeAgent_Epsilon

        vm.stopBroadcast();

        console.log("Done.");
        console.log("  Agent1 (Alpha):   100,000 $STREET");
        console.log("  Agent2 (Beta):     50,000 $STREET");
        console.log("  Agent5 (Epsilon):  50,000 $STREET");
    }
}
