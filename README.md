# x402-Paid CRE Workflows for AI Agents

AI agents need onchain data and computation but have no way to pay for it
per use. This project puts an **x402 payment gateway** in front of a
**Chainlink CRE workflow**: an agent pays a few cents in USDC (x402 v2,
EIP-3009), the gateway verifies the payment, triggers the workflow, and the
agent gets a signed oracle report back.

Built for the Chainlink **"Best workflow with CRE - 2x $1,000"** bounty
(BLI Legal Tech Hackathon 2, DoraHacks).

## Architecture

```
                        x402 v2 (exact / USDC)
                  ┌─────────────────────────────┐
                  │  1. POST /query (no payment) │
                  │  2. <- 402 + challenge       │
 AI agent ────────│  3. sign EIP-3009 auth       │──── pay 0.05 USDC
 (buyer)           │  4. POST /query +            │
                  │     PAYMENT-SIGNATURE        │
                  └──────────────┬──────────────┘
                                 │ payment verified
                                 │ (sig recovery + amount +
                                 │  recipient + window + nonce)
                                 v
                  ┌─────────────────────────────┐
                  │      x402 gateway            │
                  │      (gateway/, Node)        │
                  └──────────────┬──────────────┘
                                 │ POST localhost:2000
                                 v
                  ┌─────────────────────────────┐
                  │  CRE workflow (HTTP trigger) │
                  │  cre-workflow/ (TypeScript)  │
                  │                              │
                  │  EVM capability -> reads     │
                  │  Chainlink price feed        │
                  │  (latestRoundData) on        │
                  │  Base Sepolia                │
                  └──────────────┬──────────────┘
                                 │ JSON report
                                 v
                        { feed, answerScaled,
                          roundId, updatedAt, ... }
```

CRE has no native x402 handling, so payment verification lives in the
gateway (off-CRE), which is the pattern from Chainlink's own x402+CRE
reference. The workflow itself is a generic pay-per-query oracle service:
it knows nothing about payments and can serve any feed.

## Repo layout

- `cre-workflow/` — Chainlink CRE project (TypeScript, Bun).
  - `oracle-query-workflow/main.ts`, `workflow.ts` — HTTP-trigger workflow
    that reads a Chainlink feed via the EVM capability.
  - `workflow.yaml`, `config.staging.json`, `project.yaml` — CRE configs.
- `gateway/` — x402 payment gateway (TypeScript, plain Node).
  - `src/index.ts` — HTTP server: 402 challenges, payment verification,
    forwarding to the CRE simulator.
  - `src/x402.ts` — x402 v2 challenge builder + PAYMENT-SIGNATURE verifier.
  - `src/agent-pay.ts` — demo buyer agent (signs with a throwaway key).
- `demo.sh` — runs the whole demo.

## Setup

### 1. CRE workflow

```bash
# one-time: install the CRE CLI and log in (needs a Chainlink account)
# see https://docs.chain.link/cre/getting-started/part-1-project-setup-ts
cre login
cre whoami

cd cre-workflow/oracle-query-workflow
bun install          # installs @chainlink/cre-sdk; postinstall sets up the WASM toolchain

# set the feed address: look up the ETH/USD proxy on Base Sepolia at
# https://data.chain.link, then edit config.staging.json -> feed.address
# (also confirm chainName matches your CRE CLI's Base Sepolia selector)

# copy .env and set a throwaway private key (reads only, no funds needed)
cp ../.env.example ../.env

# typecheck
npx tsc --noEmit
```

### 2. Gateway

```bash
cd gateway
npm install
cp .env.example .env
# edit .env: set PAY_TO to your Base Sepolia wallet (receives the 0.05 USDC)
```

### 3. Run the demo

Terminal 1 — start the CRE simulator (listens on :2000):

```bash
cd cre-workflow
cre workflow simulate oracle-query-workflow --target staging-settings --listen
```

Terminal 2 — run the demo:

```bash
./demo.sh
```

Expected output:

1. `POST /query` without payment -> `402` with the x402 v2 challenge
   (`scheme=exact`, `network=eip155:84532`, `amount=50000` = $0.05).
2. The demo agent builds an EIP-3009 `TransferWithAuthorization` from the
   challenge and signs it.
3. `POST /query` with `PAYMENT-SIGNATURE` -> gateway verifies (signature
   recovery, amount, recipient, time window, one-time nonce), forwards to
   the simulator, and returns the oracle report:

```json
{
  "paid": true,
  "payer": "0x...",
  "priceUsdc": "0.05",
  "report": {
    "feed": "ETH/USD",
    "answerScaled": "3124.55",
    "roundId": "12345",
    "updatedAtIso": "2026-10-17T..."
  }
}
```

Without the simulator running, step 3 returns a clear `502` telling you the
exact `cre workflow simulate --listen` command to start it. Payment
verification (tampered amounts, wrong recipient, replays) is enforced by the
gateway in all cases.

## Security notes

- The gateway never signs anything and never touches private keys. It only
  verifies buyer signatures via `recoverTypedDataAddress` against the USDC
  EIP-3009 domain.
- Each payment nonce is accepted once (in-memory replay protection).
- `validBefore` is bounded by the challenge window; amounts must match the
  quoted price exactly.
- Demo keys are throwaway and generated fresh per run. Fund nothing.
- No `--broadcast` writes: the workflow only reads chain state. Simulation
  only, no mainnet.

## Bounty requirement mapping

| Requirement | How it is met |
|---|---|
| Build a workflow with the CRE SDK | `cre-workflow/oracle-query-workflow` (TypeScript, `@chainlink/cre-sdk`) |
| Integrate a blockchain with an external system / AI agent | EVM capability reads a Chainlink feed on Base Sepolia; the x402 gateway lets AI agents consume it |
| Successful simulation via the CRE CLI | `cre workflow simulate oracle-query-workflow --target staging-settings --listen`, exercised end-to-end by `demo.sh` |
| Example use case: AI agents consuming CRE workflows with x402 payments | Exactly the architecture above |

## Status

- [x] CRE workflow code (typechecks against `@chainlink/cre-sdk`)
- [x] x402 gateway with payment verification (tested: 402, valid payment,
      tampered amount rejected, replay rejected)
- [x] Demo buyer agent + `demo.sh`
- [ ] `cre login` + live simulation (needs a Chainlink account; human step)
- [ ] Feed address in `config.staging.json` (look up on data.chain.link)
- [ ] Demo video for the DoraHacks Build page
