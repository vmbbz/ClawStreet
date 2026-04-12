// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Script.sol";
import "forge-std/console.sol";

import { ERC1967Proxy } from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";

import { MockUSDC }              from "../contracts/MockUSDC.sol";
import { ClawToken }             from "../contracts/ClawToken.sol";
import { ClawStreetStaking }     from "../contracts/ClawStreetStaking.sol";
import { ClawStreetLoan }        from "../contracts/ClawStreetLoan.sol";
import { ClawStreetCallVault }   from "../contracts/ClawStreetCallVault.sol";
import { ClawStreetBundleVault } from "../contracts/ClawStreetBundleVault.sol";
import { ClawStreetTestNFT }     from "./DeployMockNFT.s.sol";

/**
 * @title DeployAll
 * @notice ONE command to deploy the entire ClawStreet testnet stack:
 *
 *   Step 1 — MockUSDC           (mintable USDC stand-in, 6 decimals)
 *   Step 2 — ClawStreetTestNFT  (mintable ERC-721 for loan collateral)
 *   Step 3 — ClawToken          ($CLAW ERC-20, 100M cap)
 *   Step 4 — ClawStreetStaking  (stake CLAW → ClawPass NFT + USDC revenue)
 *   Step 5 — ClawStreetBundleVault (UUPS proxy)
 *   Step 6 — ClawStreetLoan     (UUPS proxy, Pyth oracle)
 *   Step 7 — ClawStreetCallVault (UUPS proxy)
 *   Step 8 — Wire contracts     (setStakingContract, setFeeNotifier)
 *   Step 9 — Mint CLAW treasury (50M to deployer)
 *   Step 10 — Disperse USDC to all agents
 *   Step 11 — Mint test NFTs to borrower agent (Agent4)
 *   Step 12 — Disperse CLAW to staker agents (Alpha, Beta, Epsilon)
 *
 * Usage:
 *   # Dry run
 *   forge script script/DeployAll.s.sol --rpc-url base_sepolia -vvvv
 *
 *   # Live deploy + auto-verify all contracts
 *   forge script script/DeployAll.s.sol \
 *     --rpc-url base_sepolia \
 *     --broadcast \
 *     --verify \
 *     -vvvv
 *
 * Required .env:
 *   DEPLOYER_PRIVATE_KEY
 *   PYTH_ADDRESS          (Base Sepolia: 0xA2aa501b19aff244D90cc15a4Cf739D2725B5729)
 *   PYTH_ETH_USD_FEED_ID  (0xff61491a931112ddf1bd8147cd1b641375f79f5825126d665480874634fd0ace)
 *
 * Optional .env (agent funding — skipped if not set):
 *   AGENT1_ADDRESS  through  AGENT5_ADDRESS
 *
 * After running, copy the printed addresses into:
 *   - src/config/contracts.ts
 *   - config/base-sepolia.json
 *   - .env (USDC_ADDRESS, CLAW_TOKEN_ADDRESS, etc.)
 */
contract DeployAll is Script {

    // ── USDC disbursement amounts (human-readable, auto-scaled ×1e6) ──────────
    uint256 constant USDC_DEPLOYER = 10_000_000;
    uint256 constant USDC_AGENT1   =      1_000;  // market maker
    uint256 constant USDC_AGENT2   =        500;  // arbitrageur
    uint256 constant USDC_AGENT3   =      2_000;  // lender — most important
    uint256 constant USDC_AGENT4   =        500;  // borrower (repayment buffer)
    uint256 constant USDC_AGENT5   =      1_000;  // options writer

    // ── CLAW disbursement amounts (18 decimals) ───────────────────────────────
    uint256 constant CLAW_TREASURY = 50_000_000 * 1e18;
    uint256 constant CLAW_AGENT1   =    100_000 * 1e18;  // staker/market maker
    uint256 constant CLAW_AGENT2   =     50_000 * 1e18;  // arbitrageur
    uint256 constant CLAW_AGENT5   =     50_000 * 1e18;  // options writer/hedger

    // ── Mock NFT count per borrower ───────────────────────────────────────────
    uint256 constant NFT_COUNT_BORROWER = 5;

    function run() external {
        uint256 deployerKey = vm.envUint("DEPLOYER_PRIVATE_KEY");
        address deployer    = vm.addr(deployerKey);
        address pythAddr    = vm.envAddress("PYTH_ADDRESS");
        bytes32 pythFeedId  = vm.envBytes32("PYTH_ETH_USD_FEED_ID");

        // Agent addresses (optional)
        address agent1 = _envAddressOr("AGENT1_ADDRESS", address(0));
        address agent2 = _envAddressOr("AGENT2_ADDRESS", address(0));
        address agent3 = _envAddressOr("AGENT3_ADDRESS", address(0));
        address agent4 = _envAddressOr("AGENT4_ADDRESS", address(0));
        address agent5 = _envAddressOr("AGENT5_ADDRESS", address(0));

        _banner("ClawStreet Full Testnet Deploy");
        console.log("Deployer:  ", deployer);
        console.log("Chain ID:  ", block.chainid);
        console.log("Pyth:      ", pythAddr);

        vm.startBroadcast(deployerKey);

        // ── Step 1: MockUSDC ──────────────────────────────────────────────────
        _step(1, "Deploy MockUSDC");
        MockUSDC usdc = new MockUSDC(deployer);
        console.log("  MockUSDC:", address(usdc));

        // ── Step 2: MockNFT ───────────────────────────────────────────────────
        _step(2, "Deploy ClawStreetTestNFT");
        ClawStreetTestNFT nft = new ClawStreetTestNFT(deployer);
        console.log("  MockNFT: ", address(nft));

        // ── Step 3: ClawToken ─────────────────────────────────────────────────
        _step(3, "Deploy ClawToken ($CLAW)");
        ClawToken claw = new ClawToken(deployer);
        console.log("  ClawToken:", address(claw));

        // ── Step 4: Staking ───────────────────────────────────────────────────
        _step(4, "Deploy ClawStreetStaking");
        ClawStreetStaking staking = new ClawStreetStaking(
            address(claw),
            address(usdc),
            deployer
        );
        console.log("  Staking: ", address(staking));

        // ── Step 5: BundleVault (UUPS) ────────────────────────────────────────
        _step(5, "Deploy ClawStreetBundleVault (UUPS)");
        ClawStreetBundleVault bundleImpl = new ClawStreetBundleVault();
        ERC1967Proxy bundleProxy = new ERC1967Proxy(
            address(bundleImpl),
            abi.encodeCall(ClawStreetBundleVault.initialize, ("ClawStreet Bundle", "CLAWBUNDLE"))
        );
        ClawStreetBundleVault bundleVault = ClawStreetBundleVault(address(bundleProxy));
        console.log("  BundleVault:", address(bundleVault));

        // ── Step 6: LoanEngine (UUPS) ─────────────────────────────────────────
        _step(6, "Deploy ClawStreetLoan (UUPS)");
        ClawStreetLoan loanImpl = new ClawStreetLoan();
        ERC1967Proxy loanProxy = new ERC1967Proxy(
            address(loanImpl),
            abi.encodeCall(ClawStreetLoan.initialize, (address(usdc), pythAddr, pythFeedId))
        );
        ClawStreetLoan loan = ClawStreetLoan(address(loanProxy));
        console.log("  LoanEngine:", address(loan));

        // ── Step 7: CallVault (UUPS) ──────────────────────────────────────────
        _step(7, "Deploy ClawStreetCallVault (UUPS)");
        ClawStreetCallVault callImpl = new ClawStreetCallVault();
        ERC1967Proxy callProxy = new ERC1967Proxy(
            address(callImpl),
            abi.encodeCall(ClawStreetCallVault.initialize, (address(usdc)))
        );
        ClawStreetCallVault callVault = ClawStreetCallVault(address(callProxy));
        console.log("  CallVault: ", address(callVault));

        // ── Step 8: Wire contracts ────────────────────────────────────────────
        _step(8, "Wire contracts (fee routing)");
        loan.setStakingContract(address(staking));
        staking.setFeeNotifier(address(loan), true);
        console.log("  Loan -> Staking fee routing: OK");

        // ── Step 9: Mint CLAW treasury ────────────────────────────────────────
        _step(9, "Mint CLAW treasury (50M to deployer)");
        claw.mint(deployer, CLAW_TREASURY);
        console.log("  Minted 50,000,000 CLAW to deployer");

        // ── Step 10: Disperse USDC ────────────────────────────────────────────
        _step(10, "Disperse MockUSDC to all agents");
        usdc.mintHuman(deployer, USDC_DEPLOYER);
        console.log("  Deployer:          ", USDC_DEPLOYER, "USDC");
        _mintUSDC(usdc, agent1, "Agent1 Alpha",   USDC_AGENT1);
        _mintUSDC(usdc, agent2, "Agent2 Beta",    USDC_AGENT2);
        _mintUSDC(usdc, agent3, "Agent3 Gamma",   USDC_AGENT3);
        _mintUSDC(usdc, agent4, "Agent4 Delta",   USDC_AGENT4);
        _mintUSDC(usdc, agent5, "Agent5 Epsilon", USDC_AGENT5);

        // ── Step 11: Mint test NFTs to borrower (Agent4) ──────────────────────
        _step(11, "Mint test NFTs to borrower agent");
        if (agent4 != address(0)) {
            nft.mintBatch(agent4, NFT_COUNT_BORROWER);
            console.log("  Minted", NFT_COUNT_BORROWER, "NFTs to Agent4 Delta:", agent4);
        } else {
            // Mint to deployer as fallback
            nft.mintBatch(deployer, NFT_COUNT_BORROWER);
            console.log("  Agent4 not set - minted", NFT_COUNT_BORROWER, "NFTs to deployer");
        }

        // ── Step 12: Disperse CLAW to staker agents ───────────────────────────
        _step(12, "Disperse CLAW to staker agents");
        _mintCLAW(claw, agent1, "Agent1 Alpha",   CLAW_AGENT1);
        _mintCLAW(claw, agent2, "Agent2 Beta",    CLAW_AGENT2);
        _mintCLAW(claw, agent5, "Agent5 Epsilon", CLAW_AGENT5);

        vm.stopBroadcast();

        // ── Summary ───────────────────────────────────────────────────────────
        _printSummary(
            address(usdc),
            address(nft),
            address(claw),
            address(staking),
            address(loan),
            address(callVault),
            address(bundleVault)
        );
    }

    // ─── Internal helpers ─────────────────────────────────────────────────────

    function _mintUSDC(MockUSDC usdc, address to, string memory name, uint256 amount) internal {
        if (to == address(0)) {
            console.log("  SKIP (not set):  ", name);
            return;
        }
        usdc.mintHuman(to, amount);
        console.log(string.concat("  Funded ", name, " : ", _toString(amount), " USDC"));
    }

    function _mintCLAW(ClawToken claw, address to, string memory name, uint256 amount) internal {
        if (to == address(0)) {
            console.log("  SKIP (not set):  ", name);
            return;
        }
        claw.mint(to, amount);
        console.log(string.concat("  Funded ", name, " : ", _toString(amount / 1e18), " CLAW"));
    }

    function _step(uint256 n, string memory label) internal pure {
        console.log("");
        console.log(string.concat("[", _toString(n), "/12] ", label));
    }

    function _banner(string memory title) internal pure {
        console.log("");
        console.log("=================================================");
        console.log(title);
        console.log("=================================================");
    }

    function _printSummary(
        address usdc,
        address nft,
        address claw,
        address staking,
        address loan,
        address callVault,
        address bundleVault
    ) internal pure {
        console.log("");
        console.log("=================================================");
        console.log("DEPLOYMENT COMPLETE - copy these addresses:");
        console.log("=================================================");
        console.log("");
        console.log("# .env");
        console.log("MOCK_USDC_ADDRESS=   ", usdc);
        console.log("USDC_ADDRESS=        ", usdc);
        console.log("MOCK_NFT_ADDRESS=    ", nft);
        console.log("CLAW_TOKEN_ADDRESS=  ", claw);
        console.log("STAKING_ADDRESS=     ", staking);
        console.log("LOAN_ENGINE_ADDRESS= ", loan);
        console.log("CALL_VAULT_ADDRESS=  ", callVault);
        console.log("BUNDLE_VAULT_ADDRESS=", bundleVault);
        console.log("");
        console.log("# src/config/contracts.ts");
        console.log("CLAW_TOKEN:   ", claw);
        console.log("STAKING:      ", staking);
        console.log("LOAN_ENGINE:  ", loan);
        console.log("CALL_VAULT:   ", callVault);
        console.log("BUNDLE_VAULT: ", bundleVault);
        console.log("");
        console.log("# config/base-sepolia.json -> deployedContracts");
        console.log("MockUSDC:           ", usdc);
        console.log("ClawToken:          ", claw);
        console.log("ClawStreetStaking:  ", staking);
        console.log("ClawStreetLoan:     ", loan);
        console.log("ClawStreetCallVault:", callVault);
        console.log("ClawStreetBundleVault:", bundleVault);
        console.log("MockNFT:            ", nft);
        console.log("");
        console.log("Verify at: https://sepolia.basescan.org");
    }

    function _envAddressOr(string memory key, address fallback_) internal view returns (address) {
        try vm.envAddress(key) returns (address val) { return val; }
        catch { return fallback_; }
    }

    function _toString(uint256 value) internal pure returns (string memory) {
        if (value == 0) return "0";
        uint256 temp = value;
        uint256 digits;
        while (temp != 0) { digits++; temp /= 10; }
        bytes memory buffer = new bytes(digits);
        while (value != 0) {
            digits--;
            buffer[digits] = bytes1(uint8(48 + uint256(value % 10)));
            value /= 10;
        }
        return string(buffer);
    }
}
