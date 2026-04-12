// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Script.sol";
import "forge-std/console.sol";
import { MockUSDC } from "../contracts/MockUSDC.sol";

/**
 * @title DisperseUSDC
 * @notice Top-up all agent wallets with fresh MockUSDC at any time.
 *         Use this after running test scenarios that spend balances.
 *
 * Usage:
 *   forge script script/DisperseUSDC.s.sol \
 *     --rpc-url base_sepolia \
 *     --broadcast \
 *     -vvvv
 *
 * Required .env:
 *   DEPLOYER_PRIVATE_KEY
 *   MOCK_USDC_ADDRESS      — from DeployMockUSDC output
 *   AGENT1_ADDRESS  ..  AGENT5_ADDRESS
 *
 * Optional .env override — set custom per-agent top-up amounts:
 *   TOPUP_AGENT1=1000    (default 1000)
 *   TOPUP_AGENT2=500     (default 500)
 *   TOPUP_AGENT3=2000    (default 2000)
 *   TOPUP_AGENT4=500     (default 500)
 *   TOPUP_AGENT5=1000    (default 1000)
 */
contract DisperseUSDC is Script {

    function run() external {
        uint256 deployerKey  = vm.envUint("DEPLOYER_PRIVATE_KEY");
        address deployer     = vm.addr(deployerKey);
        address usdcAddress  = vm.envAddress("MOCK_USDC_ADDRESS");

        MockUSDC usdc = MockUSDC(usdcAddress);

        console.log("=== DisperseUSDC Top-Up ===");
        console.log("MockUSDC:  ", usdcAddress);
        console.log("Deployer:  ", deployer);
        console.log("Supply before:", usdc.totalSupply() / 1e6, "USDC");
        console.log("");

        vm.startBroadcast(deployerKey);

        _topUp(usdc, "AGENT1_ADDRESS", "Agent1 Alpha",   "TOPUP_AGENT1",  1_000);
        _topUp(usdc, "AGENT2_ADDRESS", "Agent2 Beta",    "TOPUP_AGENT2",    500);
        _topUp(usdc, "AGENT3_ADDRESS", "Agent3 Gamma",   "TOPUP_AGENT3",  2_000);
        _topUp(usdc, "AGENT4_ADDRESS", "Agent4 Delta",   "TOPUP_AGENT4",    500);
        _topUp(usdc, "AGENT5_ADDRESS", "Agent5 Epsilon", "TOPUP_AGENT5",  1_000);

        vm.stopBroadcast();

        console.log("");
        console.log("Supply after: ", usdc.totalSupply() / 1e6, "USDC");
        console.log("Done.");
    }

    function _topUp(
        MockUSDC usdc,
        string memory addrKey,
        string memory name,
        string memory amountKey,
        uint256 defaultAmount
    ) internal {
        address agent = _envAddressOr(addrKey, address(0));
        if (agent == address(0)) {
            console.log("  SKIP:", name, "(address not set)");
            return;
        }

        uint256 amount = _envUintOr(amountKey, defaultAmount);
        uint256 before = usdc.balanceHuman(agent);

        usdc.mintHuman(agent, amount);

        console.log("  Topped up:", name);
        console.log("    Address:", agent);
        console.log("    Before: ", before, "USDC");
        console.log("    Minted: ", amount, "USDC");
        console.log("    After:  ", usdc.balanceHuman(agent), "USDC");
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
