#!/usr/bin/env bash
# =============================================================================
# scripts/setup-agent-wallets.sh
#
# Creates 5 test agent wallets for Base Sepolia using `cast wallet new`.
# IDEMPOTENT — safe to run multiple times. Skips generation if wallets
# already exist in .env.agents. Never overwrites existing keys.
#
# After generation, automatically injects AGENT1_ADDRESS..AGENT5_ADDRESS
# into .env so forge scripts and DeployAll.s.sol can read them.
#
# Usage:
#   bash scripts/setup-agent-wallets.sh          # normal run
#   bash scripts/setup-agent-wallets.sh --force  # force regen (dangerous!)
#
# Output files:
#   .env.agents   — private keys + addresses (NEVER commit)
#   .env          — updated with AGENT1_ADDRESS..AGENT5_ADDRESS entries
# =============================================================================

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
AGENTS_FILE="$REPO_ROOT/.env.agents"
ENV_FILE="$REPO_ROOT/.env"
FORCE="${1:-}"

AGENT_NAMES=("LiquidityAgent_Alpha" "ArbitrageAgent_Beta" "LendingAgent_Gamma" "BorrowerAgent_Delta" "HedgeAgent_Epsilon")
AGENT_ROLES=("Market Maker" "Arbitrageur" "Lender" "Borrower" "Options Writer")
AGENT_KEYS=("AGENT1" "AGENT2" "AGENT3" "AGENT4" "AGENT5")

# ── Colour helpers ─────────────────────────────────────────────────────────────
GREEN='\033[0;32m'; YELLOW='\033[1;33m'; RED='\033[0;31m'; NC='\033[0m'
info()  { echo -e "${GREEN}[INFO]${NC}  $*"; }
warn()  { echo -e "${YELLOW}[WARN]${NC}  $*"; }
error() { echo -e "${RED}[ERROR]${NC} $*"; exit 1; }

# ── Dependency check ──────────────────────────────────────────────────────────
if ! command -v cast &> /dev/null; then
    error "cast not found. Install Foundry: curl -L https://foundry.paradigm.xyz | bash && foundryup"
fi

# ── Banner ────────────────────────────────────────────────────────────────────
echo ""
echo "============================================================"
echo "  ClawStreet — Agent Wallet Setup"
echo "  Base Sepolia Testnet"
echo "============================================================"
echo ""

# ── Idempotency check — skip if wallets already exist ────────────────────────
if [ "$FORCE" != "--force" ] && [ -f "$AGENTS_FILE" ]; then
    EXISTING_COUNT=0
    for KEY in "${AGENT_KEYS[@]}"; do
        ADDR_LINE=$(grep "^${KEY}_ADDRESS=" "$AGENTS_FILE" 2>/dev/null || true)
        ADDR=$(echo "$ADDR_LINE" | cut -d= -f2)
        if [ -n "$ADDR" ] && [ "$ADDR" != "0x" ]; then
            EXISTING_COUNT=$((EXISTING_COUNT + 1))
        fi
    done

    if [ "$EXISTING_COUNT" -eq 5 ]; then
        info "Agent wallets already exist ($AGENTS_FILE). Skipping generation."
        info "Use --force to regenerate (WARNING: this creates NEW wallets)."
        echo ""
        echo "  Current agent addresses:"
        for KEY in "${AGENT_KEYS[@]}"; do
            ADDR=$(grep "^${KEY}_ADDRESS=" "$AGENTS_FILE" | cut -d= -f2)
            echo "    $KEY: $ADDR"
        done
        echo ""
        # Still inject into .env in case it was recreated
        _inject_into_env
        exit 0
    fi

    warn "Found $EXISTING_COUNT/5 agents in $AGENTS_FILE — regenerating missing ones is not supported."
    warn "Delete .env.agents manually and re-run, or use --force to start fresh."
    exit 1
fi

if [ "$FORCE" = "--force" ] && [ -f "$AGENTS_FILE" ]; then
    warn "--force: overwriting existing $AGENTS_FILE"
    warn "Old private keys will be PERMANENTLY lost."
    read -r -p "  Type 'yes' to confirm: " CONFIRM
    [ "$CONFIRM" = "yes" ] || { echo "Aborted."; exit 1; }
    rm -f "$AGENTS_FILE"
fi

# ── Generate wallets ──────────────────────────────────────────────────────────
info "Generating 5 agent wallets..."
echo ""

{
    echo "# ============================================================"
    echo "# ClawStreet Agent Test Wallets — Base Sepolia"
    echo "# NEVER commit this file. It is in .gitignore."
    echo "# Generated: $(date)"
    echo "# ============================================================"
    echo ""
} > "$AGENTS_FILE"

GENERATED_ADDRESSES=()

for i in "${!AGENT_NAMES[@]}"; do
    NAME="${AGENT_NAMES[$i]}"
    ROLE="${AGENT_ROLES[$i]}"
    KEY_VAR="${AGENT_KEYS[$i]}"
    NUM=$((i + 1))

    WALLET_OUTPUT=$(cast wallet new 2>&1)
    ADDRESS=$(echo "$WALLET_OUTPUT" | grep "Address:" | awk '{print $2}')
    PRIVKEY=$(echo "$WALLET_OUTPUT"  | grep "Private key:" | awk '{print $3}')

    if [ -z "$ADDRESS" ] || [ -z "$PRIVKEY" ]; then
        error "Failed to generate wallet for $NAME. Output: $WALLET_OUTPUT"
    fi

    {
        echo "# ── Agent $NUM: $NAME ($ROLE) ──"
        echo "${KEY_VAR}_NAME=$NAME"
        echo "${KEY_VAR}_ROLE=$ROLE"
        echo "${KEY_VAR}_ADDRESS=$ADDRESS"
        echo "${KEY_VAR}_PRIVATE_KEY=$PRIVKEY"
        echo ""
    } >> "$AGENTS_FILE"

    GENERATED_ADDRESSES+=("$ADDRESS")

    printf "  [%d/5] %-28s  %s\n" "$NUM" "$NAME" "$ADDRESS"
done

echo ""
info "All wallets written to $AGENTS_FILE"

# ── Inject addresses into .env ────────────────────────────────────────────────
_inject_into_env() {
    if [ ! -f "$ENV_FILE" ]; then
        warn ".env not found — skipping address injection."
        warn "Create .env from .env.example and re-run, or add manually:"
        for i in "${!AGENT_KEYS[@]}"; do
            echo "    ${AGENT_KEYS[$i]}_ADDRESS=${GENERATED_ADDRESSES[$i]:-<address>}"
        done
        return
    fi

    echo ""
    info "Injecting agent addresses into .env..."

    for i in "${!AGENT_KEYS[@]}"; do
        KEY="${AGENT_KEYS[$i]}_ADDRESS"
        ADDR="${GENERATED_ADDRESSES[$i]:-}"

        # Read from agents file if not in memory (idempotent path)
        if [ -z "$ADDR" ]; then
            ADDR=$(grep "^${AGENT_KEYS[$i]}_ADDRESS=" "$AGENTS_FILE" | cut -d= -f2)
        fi

        if grep -q "^${KEY}=" "$ENV_FILE"; then
            # Update existing line (cross-platform sed)
            if [[ "$OSTYPE" == "darwin"* ]]; then
                sed -i '' "s|^${KEY}=.*|${KEY}=${ADDR}|" "$ENV_FILE"
            else
                sed -i "s|^${KEY}=.*|${KEY}=${ADDR}|" "$ENV_FILE"
            fi
            info "  Updated: $KEY=$ADDR"
        else
            echo "${KEY}=${ADDR}" >> "$ENV_FILE"
            info "  Added:   $KEY=$ADDR"
        fi
    done
}

_inject_into_env

# ── Guard .gitignore ──────────────────────────────────────────────────────────
GITIGNORE="$REPO_ROOT/.gitignore"
for PATTERN in ".env.agents" ".env.agents.bak"; do
    if ! grep -q "^$PATTERN" "$GITIGNORE" 2>/dev/null; then
        echo "$PATTERN" >> "$GITIGNORE"
        info "Added $PATTERN to .gitignore"
    fi
done

# ── Next steps ────────────────────────────────────────────────────────────────
echo ""
echo "============================================================"
echo "  NEXT STEPS"
echo "============================================================"
echo ""
echo "  1. Fund deployer with Base Sepolia ETH (needs ~0.3 ETH):"
echo "     https://www.coinbase.com/faucets/base-ethereum-goerli-faucet"
echo ""
echo "  2. Add your deployer private key to .env:"
echo "     DEPLOYER_PRIVATE_KEY=0x..."
echo ""
echo "  3. Run the full bootstrap (deploys everything + funds agents):"
echo "     bash scripts/bootstrap.sh"
echo ""
echo "  Or step-by-step:"
echo "     forge script script/DisperseETH.s.sol  --rpc-url base_sepolia --broadcast"
echo "     forge script script/DeployAll.s.sol    --rpc-url base_sepolia --broadcast --verify"
echo ""
echo "  Agent keys saved to: $AGENTS_FILE"
echo "  Keep this file PRIVATE — never share or commit it."
echo "============================================================"
echo ""
