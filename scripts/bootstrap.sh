#!/usr/bin/env bash
# =============================================================================
# scripts/bootstrap.sh
#
# ONE-COMMAND full testnet bootstrap for ClawStreet on Base Sepolia.
# Runs all setup steps in the correct order, skipping any already done.
#
# Steps:
#   1. Validate environment (.env, required keys, tools)
#   2. Create agent wallets (idempotent — skips if already exist)
#   3. Check deployer ETH balance
#   4. Disperse ETH to all agent wallets
#   5. Deploy all contracts + disperse MockUSDC + mint NFTs + disperse CLAW
#   6. Print a full summary with addresses to copy
#
# Usage:
#   bash scripts/bootstrap.sh              # full run
#   bash scripts/bootstrap.sh --skip-eth  # skip ETH dispersal (already done)
#   bash scripts/bootstrap.sh --dry-run   # simulate, no broadcast
#
# Prerequisites:
#   - Foundry installed (forge, cast)
#   - .env exists with DEPLOYER_PRIVATE_KEY and BASE_SEPOLIA_RPC set
#   - Deployer wallet funded with >= 0.35 ETH on Base Sepolia
#     Faucet: https://www.coinbase.com/faucets/base-ethereum-goerli-faucet
#
# After bootstrap, copy printed contract addresses into:
#   - src/config/contracts.ts
#   - config/base-sepolia.json
# =============================================================================

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENV_FILE="$REPO_ROOT/.env"
AGENTS_FILE="$REPO_ROOT/.env.agents"
LOGS_DIR="$REPO_ROOT/logs"
TIMESTAMP="$(date +%Y%m%d_%H%M%S)"
LOGFILE="$LOGS_DIR/bootstrap-${TIMESTAMP}.log"

SKIP_ETH=false
DRY_RUN=false
BROADCAST_FLAG="--broadcast --verify"
RPC_FLAG="--rpc-url base_sepolia"

for arg in "$@"; do
    case "$arg" in
        --skip-eth)  SKIP_ETH=true ;;
        --dry-run)   DRY_RUN=true; BROADCAST_FLAG=""; ;;
    esac
done

mkdir -p "$LOGS_DIR"

# ── Colour helpers ─────────────────────────────────────────────────────────────
GREEN='\033[0;32m'; YELLOW='\033[1;33m'; RED='\033[0;31m'; BLUE='\033[0;34m'; NC='\033[0m'
info()    { echo -e "${GREEN}[INFO]${NC}  $*" | tee -a "$LOGFILE"; }
warn()    { echo -e "${YELLOW}[WARN]${NC}  $*" | tee -a "$LOGFILE"; }
error()   { echo -e "${RED}[ERROR]${NC} $*" | tee -a "$LOGFILE"; exit 1; }
step()    { echo -e "\n${BLUE}[STEP $1/6]${NC} $2" | tee -a "$LOGFILE"; }
divider() { echo "============================================================" | tee -a "$LOGFILE"; }

# ── Banner ────────────────────────────────────────────────────────────────────
divider
echo "  ClawStreet — Full Testnet Bootstrap" | tee -a "$LOGFILE"
echo "  Network: Base Sepolia (Chain ID 84532)" | tee -a "$LOGFILE"
echo "  Log: $LOGFILE" | tee -a "$LOGFILE"
[ "$DRY_RUN" = true ]  && echo "  MODE: DRY RUN (no broadcast)" | tee -a "$LOGFILE"
[ "$SKIP_ETH" = true ] && echo "  FLAG: --skip-eth (ETH dispersal skipped)" | tee -a "$LOGFILE"
divider

# ═════════════════════════════════════════════════════════════════════════════
# STEP 1 — Validate environment
# ═════════════════════════════════════════════════════════════════════════════
step 1 "Validate environment"

# Tool checks
for tool in forge cast; do
    command -v "$tool" &>/dev/null || error "$tool not found. Install Foundry: curl -L https://foundry.paradigm.xyz | bash && foundryup"
done
info "forge and cast found."

# .env check
[ -f "$ENV_FILE" ] || error ".env not found. Copy .env.example to .env and fill in your values."

# Source .env (export all vars)
set -a; source "$ENV_FILE"; set +a

# Required key checks
[ -n "${DEPLOYER_PRIVATE_KEY:-}" ] || error "DEPLOYER_PRIVATE_KEY not set in .env"
[ -n "${BASE_SEPOLIA_RPC:-}" ]     || error "BASE_SEPOLIA_RPC not set in .env (add your Alchemy URL)"
[ -n "${PYTH_ADDRESS:-}" ]         || error "PYTH_ADDRESS not set in .env"
[ -n "${PYTH_ETH_USD_FEED_ID:-}" ] || error "PYTH_ETH_USD_FEED_ID not set in .env"

DEPLOYER_ADDR=$(cast wallet address "$DEPLOYER_PRIVATE_KEY" 2>/dev/null || echo "")
[ -n "$DEPLOYER_ADDR" ] || error "Could not derive address from DEPLOYER_PRIVATE_KEY — check format (0x...)"

info "Deployer address: $DEPLOYER_ADDR"
info "Environment validated."

# ═════════════════════════════════════════════════════════════════════════════
# STEP 2 — Create agent wallets (idempotent)
# ═════════════════════════════════════════════════════════════════════════════
step 2 "Create agent wallets"

bash "$REPO_ROOT/scripts/setup-agent-wallets.sh" | tee -a "$LOGFILE"

# Re-source .env to pick up injected AGENT addresses
set -a; source "$ENV_FILE"; set +a

# Verify all agents are now set
for KEY in AGENT1_ADDRESS AGENT2_ADDRESS AGENT3_ADDRESS AGENT4_ADDRESS AGENT5_ADDRESS; do
    [ -n "${!KEY:-}" ] || warn "$KEY still not set in .env after wallet generation."
done

info "Agent wallets ready."

# ═════════════════════════════════════════════════════════════════════════════
# STEP 3 — Check deployer ETH balance
# ═════════════════════════════════════════════════════════════════════════════
step 3 "Check deployer ETH balance"

DEPLOYER_ETH_WEI=$(cast balance "$DEPLOYER_ADDR" --rpc-url "$BASE_SEPOLIA_RPC" 2>/dev/null || echo "0")
DEPLOYER_ETH_GWEI=$(echo "$DEPLOYER_ETH_WEI / 1000000000" | bc 2>/dev/null || echo "0")

info "Deployer balance: ${DEPLOYER_ETH_GWEI} Gwei"

# Minimum: 0.3 ETH = 300000000 Gwei
MIN_GWEI=300000000
if [ "$DEPLOYER_ETH_GWEI" -lt "$MIN_GWEI" ] 2>/dev/null; then
    warn "Deployer balance may be low (< 0.3 ETH)."
    warn "Get Base Sepolia ETH: https://www.coinbase.com/faucets/base-ethereum-goerli-faucet"
    if [ "$DRY_RUN" = false ]; then
        read -r -p "  Continue anyway? (y/N): " CONT
        [[ "$CONT" =~ ^[Yy]$ ]] || { echo "Aborted."; exit 1; }
    fi
else
    info "Balance looks sufficient."
fi

# ═════════════════════════════════════════════════════════════════════════════
# STEP 4 — Disperse ETH to agents
# ═════════════════════════════════════════════════════════════════════════════
step 4 "Disperse ETH to agent wallets"

if [ "$SKIP_ETH" = true ]; then
    warn "--skip-eth flag set. Skipping ETH dispersal."
elif [ "$DRY_RUN" = true ]; then
    info "DRY RUN: would execute:"
    echo "  forge script script/DisperseETH.s.sol $RPC_FLAG -vvvv"
else
    forge script script/DisperseETH.s.sol \
        $RPC_FLAG \
        $BROADCAST_FLAG \
        -vvvv \
        2>&1 | tee -a "$LOGFILE"
    info "ETH dispersal complete."
fi

# ═════════════════════════════════════════════════════════════════════════════
# STEP 5 — Deploy all contracts + fund agents with USDC + NFTs + CLAW
# ═════════════════════════════════════════════════════════════════════════════
step 5 "Deploy all contracts and disperse tokens"

if [ "$DRY_RUN" = true ]; then
    info "DRY RUN: would execute:"
    echo "  forge script script/DeployAll.s.sol $RPC_FLAG --broadcast --verify -vvvv"
else
    DEPLOY_OUTPUT=$(forge script script/DeployAll.s.sol \
        $RPC_FLAG \
        $BROADCAST_FLAG \
        -vvvv \
        2>&1 | tee -a "$LOGFILE")

    echo "$DEPLOY_OUTPUT"

    # ── Extract and persist deployed addresses ────────────────────────────────
    _extract_and_save() {
        local KEY="$1"
        local PATTERN="$2"
        local ADDR
        ADDR=$(echo "$DEPLOY_OUTPUT" | grep -E "$PATTERN" | tail -1 | awk '{print $NF}' || true)
        if [ -n "$ADDR" ] && [[ "$ADDR" =~ ^0x[0-9a-fA-F]{40}$ ]]; then
            if grep -q "^${KEY}=" "$ENV_FILE"; then
                if [[ "$OSTYPE" == "darwin"* ]]; then
                    sed -i '' "s|^${KEY}=.*|${KEY}=${ADDR}|" "$ENV_FILE"
                else
                    sed -i "s|^${KEY}=.*|${KEY}=${ADDR}|" "$ENV_FILE"
                fi
            else
                echo "${KEY}=${ADDR}" >> "$ENV_FILE"
            fi
            info "  Saved $KEY=$ADDR"
        fi
    }

    info "Saving deployed addresses to .env..."
    _extract_and_save "MOCK_USDC_ADDRESS"    "MockUSDC:"
    _extract_and_save "USDC_ADDRESS"         "MockUSDC:"
    _extract_and_save "MOCK_NFT_ADDRESS"     "MockNFT:"
    _extract_and_save "CLAW_TOKEN_ADDRESS"   "ClawToken:"
    _extract_and_save "STAKING_ADDRESS"      "Staking:"
    _extract_and_save "LOAN_ENGINE_ADDRESS"  "LoanEngine:"
    _extract_and_save "CALL_VAULT_ADDRESS"   "CallVault:"
    _extract_and_save "BUNDLE_VAULT_ADDRESS" "BundleVault:"
fi

info "Deployment complete."

# ═════════════════════════════════════════════════════════════════════════════
# STEP 6 — Print final summary
# ═════════════════════════════════════════════════════════════════════════════
step 6 "Bootstrap complete"

# Re-source to get all saved values
set -a; source "$ENV_FILE" 2>/dev/null; set +a

divider
echo "" | tee -a "$LOGFILE"
echo "  ClawStreet is live on Base Sepolia!" | tee -a "$LOGFILE"
echo "" | tee -a "$LOGFILE"
echo "  Contracts:" | tee -a "$LOGFILE"
echo "    MockUSDC:    ${MOCK_USDC_ADDRESS:-<not set>}" | tee -a "$LOGFILE"
echo "    ClawToken:   ${CLAW_TOKEN_ADDRESS:-<not set>}" | tee -a "$LOGFILE"
echo "    Staking:     ${STAKING_ADDRESS:-<not set>}" | tee -a "$LOGFILE"
echo "    LoanEngine:  ${LOAN_ENGINE_ADDRESS:-<not set>}" | tee -a "$LOGFILE"
echo "    CallVault:   ${CALL_VAULT_ADDRESS:-<not set>}" | tee -a "$LOGFILE"
echo "    BundleVault: ${BUNDLE_VAULT_ADDRESS:-<not set>}" | tee -a "$LOGFILE"
echo "    MockNFT:     ${MOCK_NFT_ADDRESS:-<not set>}" | tee -a "$LOGFILE"
echo "" | tee -a "$LOGFILE"
echo "  Agent wallets:" | tee -a "$LOGFILE"
echo "    Agent1 Alpha:   ${AGENT1_ADDRESS:-<not set>}" | tee -a "$LOGFILE"
echo "    Agent2 Beta:    ${AGENT2_ADDRESS:-<not set>}" | tee -a "$LOGFILE"
echo "    Agent3 Gamma:   ${AGENT3_ADDRESS:-<not set>}" | tee -a "$LOGFILE"
echo "    Agent4 Delta:   ${AGENT4_ADDRESS:-<not set>}" | tee -a "$LOGFILE"
echo "    Agent5 Epsilon: ${AGENT5_ADDRESS:-<not set>}" | tee -a "$LOGFILE"
echo "" | tee -a "$LOGFILE"
echo "  Next steps:" | tee -a "$LOGFILE"
echo "    1. Copy contract addresses into src/config/contracts.ts" | tee -a "$LOGFILE"
echo "    2. Copy addresses into config/base-sepolia.json" | tee -a "$LOGFILE"
echo "    3. Start the dev server: npm run dev" | tee -a "$LOGFILE"
echo "    4. Run tests: bash scripts/run-tests.sh" | tee -a "$LOGFILE"
echo "" | tee -a "$LOGFILE"
echo "  Explorer: https://sepolia.basescan.org" | tee -a "$LOGFILE"
echo "  Full log: $LOGFILE" | tee -a "$LOGFILE"
divider
