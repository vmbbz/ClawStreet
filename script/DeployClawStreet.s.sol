// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Script.sol";
import "forge-std/console.sol";

import { ERC1967Proxy } from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";

import { ClawToken } from "../contracts/ClawToken.sol";
import { ClawStreetStaking } from "../contracts/ClawStreetStaking.sol";
import { ClawStreetLoan } from "../contracts/ClawStreetLoan.sol";
import { ClawStreetCallVault } from "../contracts/ClawStreetCallVault.sol";
import { ClawStreetBundleVault } from "../contracts/ClawStreetBundleVault.sol";

/**
 * @title DeployClawStreet
 * @notice Full deployment script for the ClawStreet protocol on Base.
 *
 * Usage:
 *   # Dry run (no broadcast, uses local fork)
 *   forge script script/DeployClawStreet.s.sol --rpc-url base_sepolia -vvvv
 *
 *   # Live deploy to Base Sepolia
 *   forge script script/DeployClawStreet.s.sol \
 *     --rpc-url base_sepolia \
 *     --broadcast \
 *     --verify \
 *     -vvvv
 *
 *   # Live deploy to Base Mainnet
 *   forge script script/DeployClawStreet.s.sol \
 *     --rpc-url base_mainnet \
 *     --broadcast \
 *     --verify \
 *     -vvvv
 *
 * Required .env variables:
 *   DEPLOYER_PRIVATE_KEY   — deployer EOA private key
 *   USDC_ADDRESS           — USDC token address on target network
 *   PYTH_ADDRESS           — Pyth oracle address on target network
 *   PYTH_ETH_USD_FEED_ID   — ETH/USD Pyth price feed ID (bytes32)
 *   BASESCAN_API_KEY       — for contract verification
 *
 * Base Sepolia reference addresses:
 *   USDC:  0x036CbD53842c5426634e7929541eC2318f3dCF7e
 *   Pyth:  0xA2aa501b19aff244D90cc15a4Cf739D2725B5729
 *   ETH/USD feed: 0xff61491a931112ddf1bd8147cd1b641375f79f5825126d665480874634fd0ace
 */
contract DeployClawStreet is Script {
    // ─── Deployment state ────────────────────────────────────────────────────
    ClawToken        public clawToken;
    ClawStreetStaking public staking;
    ClawStreetLoan   public loan;
    ClawStreetCallVault public callVault;
    ClawStreetBundleVault public bundleVault;

    function run() external {
        uint256 deployerKey = vm.envUint("DEPLOYER_PRIVATE_KEY");
        address deployer    = vm.addr(deployerKey);

        address usdcAddress     = vm.envAddress("USDC_ADDRESS");
        address pythAddress     = vm.envAddress("PYTH_ADDRESS");
        bytes32 pythFeedId      = vm.envBytes32("PYTH_ETH_USD_FEED_ID");

        console.log("=== ClawStreet Deployment ===");
        console.log("Deployer:       ", deployer);
        console.log("USDC:           ", usdcAddress);
        console.log("Pyth:           ", pythAddress);
        console.log("Chain ID:       ", block.chainid);

        vm.startBroadcast(deployerKey);

        // ── 1. $CLAW token ────────────────────────────────────────────────────
        clawToken = new ClawToken(deployer);
        console.log("ClawToken:      ", address(clawToken));

        // ── 2. Staking (non-upgradeable — token contracts stay immutable) ─────
        staking = new ClawStreetStaking(
            address(clawToken),
            usdcAddress,
            deployer
        );
        console.log("Staking:        ", address(staking));

        // ── 3. BundleVault (UUPS) ─────────────────────────────────────────────
        ClawStreetBundleVault bundleImpl = new ClawStreetBundleVault();
        bytes memory bundleInit = abi.encodeCall(
            ClawStreetBundleVault.initialize,
            ("ClawStreet Bundle", "CLAWBUNDLE")
        );
        ERC1967Proxy bundleProxy = new ERC1967Proxy(address(bundleImpl), bundleInit);
        bundleVault = ClawStreetBundleVault(address(bundleProxy));
        console.log("BundleVault:    ", address(bundleVault));

        // ── 4. Loan Engine (UUPS) ─────────────────────────────────────────────
        ClawStreetLoan loanImpl = new ClawStreetLoan();
        bytes memory loanInit = abi.encodeCall(
            ClawStreetLoan.initialize,
            (usdcAddress, pythAddress, pythFeedId)
        );
        ERC1967Proxy loanProxy = new ERC1967Proxy(address(loanImpl), loanInit);
        loan = ClawStreetLoan(address(loanProxy));
        console.log("LoanEngine:     ", address(loan));

        // ── 5. CallVault (UUPS) ───────────────────────────────────────────────
        ClawStreetCallVault callImpl = new ClawStreetCallVault();
        bytes memory callInit = abi.encodeCall(
            ClawStreetCallVault.initialize,
            (usdcAddress)
        );
        ERC1967Proxy callProxy = new ERC1967Proxy(address(callImpl), callInit);
        callVault = ClawStreetCallVault(address(callProxy));
        console.log("CallVault:      ", address(callVault));

        // ── 6. Wire up: Loan → Staking (fee routing) ─────────────────────────
        loan.setStakingContract(address(staking));
        console.log("Loan.stakingContract set to staking");

        // ── 7. Authorise Loan as fee notifier on Staking ──────────────────────
        staking.setFeeNotifier(address(loan), true);
        console.log("Staking feeNotifier: LoanEngine authorised");

        // ── 8. Mint initial $CLAW supply to deployer (treasury allocation) ────
        //     50M to deployer — distribute per tokenomics plan
        clawToken.mint(deployer, 50_000_000 * 1e18);
        console.log("Minted 50M CLAW to deployer");

        vm.stopBroadcast();

        // ── Print summary ─────────────────────────────────────────────────────
        console.log("");
        console.log("=== Deployment Complete ===");
        console.log("Add these to src/config/contracts.ts:");
        console.log("  LOAN_ENGINE: ", address(loan));
        console.log("  CALL_VAULT:  ", address(callVault));
        console.log("  BUNDLE_VAULT:", address(bundleVault));
        console.log("  CLAW_TOKEN:  ", address(clawToken));
        console.log("  STAKING:     ", address(staking));
    }
}
