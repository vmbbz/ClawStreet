// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Script.sol";
import "forge-std/console.sol";
import { MockUSDC } from "../contracts/MockUSDC.sol";

/**
 * @title DeployMockUSDC
 * @notice Deploys MockUSDC and immediately disperses USDC to all 5 agent wallets
 *         plus the deployer. Run this BEFORE DeployClawStreet so you can set
 *         USDC_ADDRESS in .env.
 *
 * ── Quick start ───────────────────────────────────────────────────────────────
 *
 *   # 1. Set agent addresses in .env.agents (run scripts/setup-agent-wallets.sh first)
 *   # 2. Set DEPLOYER_PRIVATE_KEY in .env
 *
 *   # Dry run (no broadcast):
 *   forge script script/DeployMockUSDC.s.sol --rpc-url base_sepolia -vvvv
 *
 *   # Live deploy + verify:
 *   forge script script/DeployMockUSDC.s.sol \
 *     --rpc-url base_sepolia \
 *     --broadcast \
 *     --verify \
 *     -vvvv
 *
 * ── Required .env variables ───────────────────────────────────────────────────
 *   DEPLOYER_PRIVATE_KEY   — deployer EOA
 *
 * ── Optional .env variables (agent funding) ──────────────────────────────────
 *   AGENT1_ADDRESS  through  AGENT5_ADDRESS
 *   If not set, only the deployer is funded.
 *
 * ── Disbursement amounts ──────────────────────────────────────────────────────
 *   Deployer:            10,000,000 USDC  (treasury / top-up reserve)
 *   Agent 1 Alpha:           1,000 USDC  (market maker)
 *   Agent 2 Beta:              500 USDC  (arbitrageur)
 *   Agent 3 Gamma (lender):  2,000 USDC  (funds loans)
 *   Agent 4 Delta (borrower):  500 USDC  (repayment buffer)
 *   Agent 5 Epsilon:         1,000 USDC  (options writer)
 */
contract DeployMockUSDC is Script {

    // ── Disbursement amounts (human USDC, multiplied by 1e6 in contract) ──────
    uint256 constant DEPLOYER_AMOUNT = 10_000_000;   // 10M USDC — treasury
    uint256 constant AGENT1_AMOUNT   =      1_000;
    uint256 constant AGENT2_AMOUNT   =        500;
    uint256 constant AGENT3_AMOUNT   =      2_000;   // lender — needs most
    uint256 constant AGENT4_AMOUNT   =        500;
    uint256 constant AGENT5_AMOUNT   =      1_000;

    function run() external {
        uint256 deployerKey = vm.envUint("DEPLOYER_PRIVATE_KEY");
        address deployer    = vm.addr(deployerKey);

        // ── Load agent addresses (optional — zero address if not set) ──────────
        address agent1 = _envAddressOr("AGENT1_ADDRESS", address(0));
        address agent2 = _envAddressOr("AGENT2_ADDRESS", address(0));
        address agent3 = _envAddressOr("AGENT3_ADDRESS", address(0));
        address agent4 = _envAddressOr("AGENT4_ADDRESS", address(0));
        address agent5 = _envAddressOr("AGENT5_ADDRESS", address(0));

        console.log("=== DeployMockUSDC ===");
        console.log("Deployer:  ", deployer);
        console.log("Chain ID:  ", block.chainid);
        console.log("");

        vm.startBroadcast(deployerKey);

        // ── 1. Deploy MockUSDC ─────────────────────────────────────────────────
        MockUSDC usdc = new MockUSDC(deployer);
        console.log("MockUSDC deployed:", address(usdc));
        console.log("");

        // ── 2. Fund deployer (treasury reserve) ───────────────────────────────
        usdc.mintHuman(deployer, DEPLOYER_AMOUNT);
        console.log("Funded deployer:  ", deployer);
        console.log("  Amount:         ", DEPLOYER_AMOUNT, "USDC");
        console.log("");

        // ── 3. Fund each agent (skips zero addresses) ─────────────────────────
        _fundAgent(usdc, "Agent1 Alpha (Market Maker)",      agent1, AGENT1_AMOUNT);
        _fundAgent(usdc, "Agent2 Beta  (Arbitrageur)",       agent2, AGENT2_AMOUNT);
        _fundAgent(usdc, "Agent3 Gamma (Lender)",            agent3, AGENT3_AMOUNT);
        _fundAgent(usdc, "Agent4 Delta (Borrower)",          agent4, AGENT4_AMOUNT);
        _fundAgent(usdc, "Agent5 Epsilon (Options Writer)",  agent5, AGENT5_AMOUNT);

        vm.stopBroadcast();

        // ── 4. Print summary ──────────────────────────────────────────────────
        console.log("");
        console.log("=== Deployment Complete ===");
        console.log("MockUSDC address:  ", address(usdc));
        console.log("Total supply:      ", usdc.totalSupply() / 1e6, "USDC");
        console.log("");
        console.log("Next steps:");
        console.log("  1. Set USDC_ADDRESS=", address(usdc), "in .env");
        console.log("  2. Set MOCK_USDC_ADDRESS=", address(usdc), "in .env");
        console.log("  3. Run DeployClawStreet.s.sol");
    }

    // ─── Internal helpers ─────────────────────────────────────────────────────

    function _fundAgent(
        MockUSDC usdc,
        string memory name,
        address agent,
        uint256 humanAmount
    ) internal {
        if (agent == address(0)) {
            console.log("  SKIP (not set):", name);
            return;
        }
        usdc.mintHuman(agent, humanAmount);
        console.log("  Funded", name);
        console.log("    Address:", agent);
        console.log("    Amount: ", humanAmount, "USDC");
    }

    /// @dev Try reading an env var as address; return `fallback_` if not set or empty.
    function _envAddressOr(string memory key, address fallback_) internal view returns (address) {
        try vm.envAddress(key) returns (address val) {
            return val;
        } catch {
            return fallback_;
        }
    }
}
