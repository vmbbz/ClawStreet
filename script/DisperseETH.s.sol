// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Script.sol";
import "forge-std/console.sol";

/**
 * @title DisperseETH
 * @notice Sends Base Sepolia test ETH from the deployer wallet to all 5 agent
 *         wallets so they can pay gas for testnet transactions.
 *
 * The deployer must have sufficient ETH balance before running:
 *   Total sent  = (ETH_PER_AGENT * 5)  e.g. 0.05 * 5 = 0.25 ETH
 *   Keep buffer = ~0.05 ETH for deploy gas
 *   Recommended deployer balance: >= 0.35 ETH
 *
 * Usage:
 *   # Dry run (simulation only, no broadcast):
 *   forge script script/DisperseETH.s.sol --rpc-url base_sepolia -vvvv
 *
 *   # Live send:
 *   forge script script/DisperseETH.s.sol \
 *     --rpc-url base_sepolia \
 *     --broadcast \
 *     -vvvv
 *
 * Required .env:
 *   DEPLOYER_PRIVATE_KEY
 *   AGENT1_ADDRESS  through  AGENT5_ADDRESS   (set by setup-agent-wallets.sh)
 *
 * Optional .env overrides (amount in wei):
 *   ETH_AGENT1=50000000000000000    (default 0.05 ETH each)
 *   ETH_AGENT2=50000000000000000
 *   ETH_AGENT3=50000000000000000
 *   ETH_AGENT4=50000000000000000
 *   ETH_AGENT5=50000000000000000
 */
contract DisperseETH is Script {

    // Default: 0.05 ETH per agent (in wei)
    uint256 constant DEFAULT_ETH_PER_AGENT = 0.05 ether;

    function run() external {
        uint256 deployerKey = vm.envUint("DEPLOYER_PRIVATE_KEY");
        address deployer    = vm.addr(deployerKey);

        // ── Load agent addresses ───────────────────────────────────────────────
        address[5] memory agents = [
            _envAddressOr("AGENT1_ADDRESS", address(0)),
            _envAddressOr("AGENT2_ADDRESS", address(0)),
            _envAddressOr("AGENT3_ADDRESS", address(0)),
            _envAddressOr("AGENT4_ADDRESS", address(0)),
            _envAddressOr("AGENT5_ADDRESS", address(0))
        ];

        string[5] memory names = [
            "Agent1 Alpha (Market Maker)",
            "Agent2 Beta  (Arbitrageur)",
            "Agent3 Gamma (Lender)",
            "Agent4 Delta (Borrower)",
            "Agent5 Epsilon (Options Writer)"
        ];

        // ── Load per-agent ETH amounts (or use defaults) ──────────────────────
        uint256[5] memory amounts = [
            _envUintOr("ETH_AGENT1", DEFAULT_ETH_PER_AGENT),
            _envUintOr("ETH_AGENT2", DEFAULT_ETH_PER_AGENT),
            _envUintOr("ETH_AGENT3", DEFAULT_ETH_PER_AGENT),
            _envUintOr("ETH_AGENT4", DEFAULT_ETH_PER_AGENT),
            _envUintOr("ETH_AGENT5", DEFAULT_ETH_PER_AGENT)
        ];

        // ── Pre-flight checks ─────────────────────────────────────────────────
        uint256 totalToSend;
        for (uint256 i; i < 5; i++) {
            if (agents[i] != address(0)) totalToSend += amounts[i];
        }

        uint256 deployerBalance = deployer.balance;

        console.log("=== DisperseETH ===");
        console.log("Deployer:         ", deployer);
        console.log("Deployer balance: ", deployerBalance / 1e15, "mETH");
        console.log("Total to send:    ", totalToSend / 1e15, "mETH");
        console.log("Buffer remaining: ", (deployerBalance > totalToSend)
            ? (deployerBalance - totalToSend) / 1e15
            : 0,
            "mETH"
        );
        console.log("");

        require(
            deployerBalance >= totalToSend + 0.01 ether,
            "DisperseETH: deployer has insufficient ETH (need total + 0.01 ETH buffer)"
        );

        // ── Broadcast ─────────────────────────────────────────────────────────
        vm.startBroadcast(deployerKey);

        for (uint256 i; i < 5; i++) {
            if (agents[i] == address(0)) {
                console.log("  SKIP (not set):", names[i]);
                continue;
            }

            uint256 before = agents[i].balance;

            (bool ok,) = payable(agents[i]).call{value: amounts[i]}("");
            require(ok, string.concat("ETH transfer failed for ", names[i]));

            console.log("  Sent:", names[i]);
            console.log("    To:     ", agents[i]);
            console.log("    Amount: ", amounts[i] / 1e15, "mETH");
            console.log("    Before: ", before / 1e15, "mETH");
            console.log("    After:  ", (before + amounts[i]) / 1e15, "mETH");
        }

        vm.stopBroadcast();

        // ── Summary ───────────────────────────────────────────────────────────
        console.log("");
        console.log("=== ETH Dispersal Complete ===");
        console.log("Total sent:         ", totalToSend / 1e15, "mETH");
        console.log("Deployer remaining: ", (deployer.balance) / 1e15, "mETH");
        console.log("");
        console.log("All agents now have gas for testnet transactions.");
        console.log("Run next: forge script script/DeployAll.s.sol --rpc-url base_sepolia --broadcast --verify");
    }

    function _envAddressOr(string memory key, address fallback_) internal view returns (address) {
        try vm.envAddress(key) returns (address val) { return val; }
        catch { return fallback_; }
    }

    function _envUintOr(string memory key, uint256 fallback_) internal view returns (uint256) {
        try vm.envUint(key) returns (uint256 val) { return val; }
        catch { return fallback_; }
    }
}
