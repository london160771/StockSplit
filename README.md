# StockSplit

**Invest together. Own independently.**

StockSplit is an invite-only collaborative xStock portfolio application on Solana. A creator defines a fixed basket, invites a small group, and opens a funding window. Members contribute together while keeping independent, verifiable ownership and withdrawal rights.

StockSplit is an ownership layer, not a brokerage, investment adviser, managed fund, or copy-trading product.

## The problem

People already invest together as couples, families, friends, and small investment circles. Usually one person controls the brokerage account, everyone relies on manual records, and withdrawals require coordination with that account holder.

StockSplit moves the ownership rules and custody boundaries onchain. The creator configures the portfolio, but cannot sweep another member's share.

## How it works

1. Connect a Solana wallet and create a portfolio.
2. Choose a fixed xStock basket and allocation percentages totaling 100%.
3. Invite the wallets that may participate.
4. Members contribute USDC during the funding window.
5. The creator closes funding; contribution units and ownership percentages are fixed.
6. Each basket allocation is deployed as a separate leg into its portfolio vault.
7. The portfolio becomes **ACTIVE**.
8. Any eligible member can independently withdraw their proportional share of the current raw vault balances in kind.
9. After the final member exits, the portfolio becomes **CLOSED**.

## Core features

- Invite-only collaborative portfolios.
- Fixed basket and allocation validation.
- PDA-controlled USDC and Token-2022 asset vaults.
- Onchain contribution units and proportional ownership.
- One deployment leg per transaction with retryable failures.
- Independent in-kind withdrawals; no NAV or price oracle is required for entitlement.
- Creator cancellation before deployment starts.
- Independent member refunds from a terminal **CANCELLED** portfolio.
- Devnet-only TEST-USDC and TEST-xStock demo assets.
- Separate Devnet SOL faucet for transaction fees.

### Cancel + Refund

Before any deployment leg executes, the creator may cancel a portfolio in `DRAFT`, `FUNDING`, or `FUNDING_CLOSED`. Cancellation is terminal. Each contributor independently claims exactly their recorded raw USDC contribution from the canonical portfolio vault. The creator cannot sweep member funds, and unsolicited vault surplus is never included in a refund.

## Current verified status

- Solana Devnet program is live.
- Program ID: `9nLrXyjgLTwMxnyBJ2GnKqnHZiu5koYNHrpKXezVGDmm`
- Local integration suite: **52/52 passing**.
- Frontend tests: **32/32 passing**.
- Demo-faucet tests: **11/11 passing**.
- Combined frontend/faucet run: **43/43 passing**.
- Verified Devnet flows include create, invite, fund, close funding, invest, `ACTIVE`, independent withdrawal, automatic `CLOSED`, cancel, refund, TEST-USDC faucet, and 0.2 SOL gas faucet.
- Demo xStock liquidity is currently funded on Devnet for the approved mock assets.
- The mainnet Jupiter proof is **not yet completed**. Do not treat Devnet mock settlement as proof of a mainnet routed swap.

## Architecture

The Anchor/Solana program is the source of truth for ownership and lifecycle state.

- **Portfolio PDAs** store the creator, fixed basket, allocations, funding window, status, and recorded contribution totals.
- **Member PDAs** bind invited wallets to a portfolio and store contribution and outstanding ownership units.
- **PDA-controlled vaults** hold the contribution asset and one separate vault for each basket mint. No creator wallet directly controls portfolio assets.
- **Contribution units** are derived from raw contributed USDC. Ownership is the member's outstanding units divided by total outstanding units.
- **Deployment legs** execute one approved basket allocation at a time. Recorded contribution accounting, not unsolicited vault surplus, determines the intended input amount.
- **Production routing** supports legacy SPL USDC and Token-2022 xStocks through a validated Jupiter-compatible path.
- **Devnet settlement** uses a deterministic 1:1 demo path for the curated mock mints when no market exists. It is a separate Devnet build path and has no monetary value.
- **Withdrawals** use current raw vault balances and current outstanding units to transfer proportional in-kind assets.
- **CANCELLED** is a terminal pre-deployment branch; members claim their own recorded refunds independently.

Production/mainnet USDC assumptions remain distinct from the Devnet demo: the production route supports canonical legacy SPL USDC, while the configured Devnet TEST-USDC mint is a six-decimal Token-2022 mock.

## Devnet Demo Mode

Devnet Demo Mode is for demonstrating StockSplit mechanics only.

- `TEST-USDC` is the configured six-decimal Token-2022 demo contribution mint.
- Approved Devnet TEST-USDC mint: `HfstGSPF1MJsD8hrpYTcPhqT6uxXTvCFSeuBYLsZJ26J`.
- `TEST-NVDAx`, `TEST-AAPLx`, `TEST-TSLAx`, and `TEST-SPYx` are mock Token-2022 assets.
- All demo assets have **no monetary value** and must never be presented as real securities or real USDC.
- Demo settlement is deterministic 1:1 in raw units against finite, pre-funded demo liquidity.
- Devnet SOL is supplied only for transaction fees and has no monetary value in the product.
- The operator script verifies or prepares the approved public mint configuration; it does not expose private keys.

The production build omits the Devnet demo instruction and retains the validated Jupiter deployment path. Never deploy a demo-feature binary to mainnet.

## Security and safety

StockSplit enforces the following boundaries onchain:

- invite-only participation and creator-only lifecycle controls where appropriate;
- immutable basket configuration after contributions begin;
- exact raw-unit accounting with checked arithmetic;
- canonical mint, token-program, vault, destination, and PDA validation;
- no arbitrary creator-controlled vault transfer or CPI path;
- no deployment before funding closes and no use of unsolicited excess USDC;
- no duplicate deployment, withdrawal, or refund settlement;
- cancellation is forbidden after deployment starts;
- members withdraw independently without creator approval;
- failed transfers and failed deployment legs roll back state and remain retryable;
- current raw balances, not NAV, price oracles, UI-scaled balances, or historical swap output, determine withdrawal entitlement.

## Local setup

Linux or WSL is recommended for the Anchor and validator workflow.

### Prerequisites

- Node.js 22.20 or newer.
- pnpm.
- Rust and Cargo.
- Solana CLI compatible with the project (the verified environment uses Solana CLI 2.3.0).
- Anchor CLI 0.32.1.

### Install and build

```bash
git clone <repository-url>
cd StockSplit
pnpm install
pnpm exec tsc --noEmit
pnpm frontend:build
```

The fixed program ID is part of the checked-in program and IDL artifacts. Keep any deployment keypair outside the repository and outside OneDrive. Never run `anchor keys sync` to replace the fixed identity.

### Run the frontend

```bash
pnpm frontend:dev
```

This serves the frontend-only app on `http://localhost:4173`. It does not process faucet claims.

### Run the Devnet demo faucet

The faucet is optional and Devnet-only. It requires dedicated treasury keypairs and a persistent SQLite path supplied through secret environment configuration. Never put these files in the repository or a public directory.

Required when payouts are enabled:

```text
STOCKSPLIT_DEMO_FAUCET_ENABLED=true
STOCKSPLIT_FAUCET_KEYPAIR_PATH=<absolute path outside the repository>
STOCKSPLIT_SOL_FAUCET_KEYPAIR_PATH=<different absolute path outside the repository>
STOCKSPLIT_FAUCET_DB_PATH=<persistent absolute path outside the repository>
```

Optional settings include `STOCKSPLIT_FAUCET_DEVNET_RPC_URL`, `STOCKSPLIT_SOL_FAUCET_AMOUNT_SOL` (default `0.2`), `STOCKSPLIT_SOL_FAUCET_MIN_RESERVE_SOL` (default `0.2`), `HOST`, and `PORT` (default `4174`). The server verifies the Devnet genesis hash before enabling claims.

```bash
pnpm frontend:build
pnpm faucet:devnet
```

The faucet sends exactly 25 TEST-USDC or 0.2 Devnet SOL once per wallet and claim type. The SQLite database must persist across restarts; it is not an ownership database.

### Run the local integration suite

```bash
pnpm test:local-demo
```

The harness builds the Devnet-demo feature, starts a fresh local validator, loads the fixed program and mock router, and runs the two-wallet integration suite. It does not require mainnet funds or a Devnet deployment.

For the lower-level checks:

```bash
cargo fmt --check
cargo test -p stock_split_phase0 --features devnet-demo
pnpm exec tsc --noEmit
node --test frontend/*.test.mjs demo-faucet/*.test.mjs
pnpm frontend:build
```

Do not place wallet keypairs, faucet treasury keys, program keypairs, API keys, SQLite claim data, local ledgers, or buffer keypairs in the repository.

## Repository structure

```text
programs/       Anchor programs, including StockSplit and the local mock router
frontend/       Source UI, asset registry, tests, and generated public build
demo-faucet/    Devnet-only TEST-USDC and SOL faucet service and tests
scripts/        Devnet asset/operator tooling, verification, and local harnesses
tests/          Anchor integration and security tests
```

`frontend/dist/` is the generated public frontend served by the demo server. `devnet-mock-assets.json` is local operator output and is intentionally ignored; the asset script can recreate/verify it from the approved configuration.

## Public links

- Live app: **TBD — add deployment URL**
- Demo video: **TBD — add recording URL**
- Hackathon submission: **TBD — add submission URL**

## Project status

The Devnet demo is ready for public review of the invite, funding, deployment, ownership, withdrawal, cancel, refund, and faucet flows. The remaining major proof is a minimal real mainnet USDC → xStock Jupiter swap. Until that proof is complete, the Devnet demo should be understood as a mechanics and UX demonstration using valueless mock assets.
