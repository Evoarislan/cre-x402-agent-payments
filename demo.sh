#!/usr/bin/env bash
#
# Demo: an AI agent pays for a CRE oracle query through x402.
#
# What it shows:
#   1. Unpaid POST /query -> 402 with an x402 v2 payment challenge.
#   2. The agent builds an EIP-3009 TransferWithAuthorization from the
#      challenge and signs it with a throwaway test key.
#   3. Paid POST /query with PAYMENT-SIGNATURE -> the gateway verifies the
#      payment and forwards to the CRE workflow simulator, returning the
#      oracle report.
#
# Prerequisites:
#   - Node 20+, npm.
#   - gateway/.env with PAY_TO set (copy gateway/.env.example).
#   - For the full end-to-end: the CRE simulator running
#       cre workflow simulate oracle-query-workflow --target staging-settings --listen
#     (needs `cre login`; without it the demo stops after payment verification
#      with a clear 502 message.)
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
GATEWAY_DIR="$ROOT/gateway"

echo "==> installing gateway dependencies"
cd "$GATEWAY_DIR"
npm install --no-audit --no-fund > /dev/null 2>&1 || true

if [ ! -f "$GATEWAY_DIR/.env" ]; then
  echo "!! gateway/.env not found. Copy gateway/.env.example to gateway/.env"
  echo "   and set PAY_TO to your Base Sepolia wallet address, then re-run."
  exit 1
fi

set -a
# shellcheck disable=SC1091
source "$GATEWAY_DIR/.env"
set +a

echo "==> starting x402 gateway on port ${PORT:-4021}"
npx tsx src/index.ts > /tmp/cre-x402-gateway.log 2>&1 &
GATEWAY_PID=$!
trap 'kill $GATEWAY_PID 2>/dev/null || true' EXIT

for _ in $(seq 1 20); do
  if curl -sf "http://localhost:${PORT:-4021}/health" > /dev/null 2>&1; then
    break
  fi
  sleep 0.5
done
curl -sf "http://localhost:${PORT:-4021}/health" > /dev/null || {
  echo "!! gateway did not start. See /tmp/cre-x402-gateway.log"
  exit 1
}

echo "==> running the demo buyer agent"
echo ""
npx tsx src/agent-pay.ts

echo ""
echo "==> demo complete (gateway stopped)"
