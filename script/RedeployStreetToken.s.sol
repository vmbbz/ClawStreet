// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Script.sol";
import "forge-std/console.sol";
import "../contracts/ClawToken.sol";
import "../contracts/ClawStreetStaking.sol";

/**
 * @title RedeployStreetToken
 * @notice Redeploys only ClawToken (new symbol: STREET) + ClawStreetStaking.
 *         All other contracts (Loan, CallVault, BundleVault, MockUSDC, MockNFT)
 *         are unaffected and keep their existing addresses.
 *
 * Usage:
 *   forge script script/RedeployStreetToken.s.sol \
 *     --rpc-url base_sepolia --broadcast --verify -vvvv
 */
contract RedeployStreetToken is Script {
    function run() external {
        uint256 deployerKey  = vm.envUint("DEPLOYER_PRIVATE_KEY");
        address deployer     = vm.addr(deployerKey);
        address mockUsdc     = vm.envAddress("MOCK_USDC_ADDRESS");

        console.log("=================================================");
        console.log("  RedeployStreetToken - Base Sepolia");
        console.log("=================================================");
        console.log("  Deployer:  ", deployer);
        console.log("  MockUSDC:  ", mockUsdc);
        console.log("");

        vm.startBroadcast(deployerKey);

        // 1. Deploy new ClawToken with symbol STREET
        console.log("[1/2] Deploy ClawToken ($STREET)");
        ClawToken clawToken = new ClawToken(deployer);
        console.log("  ClawToken: ", address(clawToken));

        // 2. Deploy new ClawStreetStaking with new token address
        console.log("[2/2] Deploy ClawStreetStaking");
        ClawStreetStaking staking = new ClawStreetStaking(
            address(clawToken),
            mockUsdc,
            deployer
        );
        console.log("  Staking:   ", address(staking));

        // 3. Mint initial treasury allocation to deployer
        clawToken.mint(deployer, 50_000_000 * 1e18);
        console.log("  Minted 50M $STREET to deployer");

        vm.stopBroadcast();

        console.log("");
        console.log("=================================================");
        console.log("  UPDATE THESE IN src/config/contracts.ts + .env:");
        console.log("  CLAW_TOKEN_ADDRESS=", address(clawToken));
        console.log("  STAKING_ADDRESS=   ", address(staking));
        console.log("=================================================");
    }
}
