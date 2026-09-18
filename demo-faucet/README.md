# StockSplit Devnet Demo Funds

This is a separate, finite Devnet-only demo distributor for TEST-USDC and transaction-fee SOL. It is not part of the StockSplit program. It never mints tokens and never has portfolio custody. Each connected wallet signs a one-time message challenge; the server sends exactly 25 TEST-USDC from its own treasury or exactly 0.2 Devnet SOL from a separate SOL treasury to that same wallet.

The faucet serves the built frontend and `/api/demo-funds/*` on one origin. Use this server, not `frontend/dev-server.mjs`, when testing claims. The latter remains a frontend-only server.

## Requirements

- Node.js 22.20 or newer (this implementation uses Node's built-in SQLite API).
- A single running server instance with a persistent local volume for the SQLite file. Do not deploy the SQLite file to an ephemeral serverless filesystem or run multiple independent replicas.
- A dedicated Devnet keypair that is **not** the TEST-USDC mint authority, a portfolio wallet, or a frontend user's wallet.
- A separate dedicated Devnet SOL treasury keypair for fee claims; it must not be the TEST-USDC treasury.
- The treasury's own Token-2022 ATA funded with a finite portion of the existing TEST-USDC supply. No mint-authority key is used by this server.

Required environment variables when enabled:

| Variable | Meaning |
| --- | --- |
| `STOCKSPLIT_DEMO_FAUCET_ENABLED=true` | Explicit opt-in; any other value disables payouts. |
| `STOCKSPLIT_FAUCET_KEYPAIR_PATH` | Absolute path to the private treasury keypair JSON, outside `frontend/dist`; mount as a server secret. |
| `STOCKSPLIT_SOL_FAUCET_KEYPAIR_PATH` | Absolute path to the separate private SOL fee-treasury keypair JSON, outside `frontend/dist`; optional until SOL claims are enabled. |
| `STOCKSPLIT_SOL_FAUCET_AMOUNT_SOL` | SOL payout per wallet; defaults to exactly `0.2`. |
| `STOCKSPLIT_SOL_FAUCET_MIN_RESERVE_SOL` | Minimum SOL left in the SOL treasury after a payout; the server requires this reserve plus the estimated transaction fee. Defaults to `0.2`. |
| `STOCKSPLIT_FAUCET_DB_PATH` | Absolute path to SQLite on a persistent volume, outside `frontend/dist`. Preserve this file and its WAL files across deploys and key rotation. |
| `STOCKSPLIT_FAUCET_DEVNET_RPC_URL` | Optional Devnet RPC, default `https://api.devnet.solana.com`. Startup verifies its genesis hash against the official Devnet RPC. |
| `HOST`, `PORT` | Optional bind address and port; defaults `127.0.0.1:4174`. Use `HOST=0.0.0.0` only behind your deployment's HTTPS proxy. |

Never put a keypair, `.env`, or SQLite database in `frontend/dist` or a publicly served directory. Do not log or commit the treasury secret. Configure HTTPS for a public deployment so Phantom message signing and the clipboard work normally.

## Treasury setup

1. Generate a new Devnet-only TEST-USDC treasury keypair and a separate Devnet SOL fee-treasury keypair at private absolute paths. Record only their public addresses.
2. Fund the SOL treasury with enough Devnet SOL for the finite demo while preserving the configured reserve. The server also accounts for the estimated transfer fee before sending.
3. From the existing holder of TEST-USDC, transfer up to the approximately 1,000 already available tokens to the TEST-USDC treasury public wallet. With the SPL Token CLI, use the Token-2022 program and `--fund-recipient`, for example: `spl-token --program-id TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb transfer HfstGSPF1MJsD8hrpYTcPhqT6uxXTvCFSeuBYLsZJ26J 1000 <TREASURY_PUBLIC_KEY> --fund-recipient --url devnet`. Confirm the treasury's canonical TEST-USDC ATA holds the intended balance before enabling the server.
4. Create a persistent private directory for the SQLite database. Supply all absolute paths through secret environment configuration. The database directory must exist and be writable by the server process.
5. Run `pnpm install`, `pnpm frontend:build`, then `pnpm faucet:devnet` with the environment variables set. Open `http://localhost:4174` for local testing. The existing frontend-only server on port 4173 cannot process claims.

The server checks the mint is Token-2022, has six decimals and no transfer fee, verifies the RPC's Devnet genesis, and requires a usable treasury ATA. It refuses to start enabled if those checks fail.

## API claim types

The existing `/api/demo-funds/challenge` and `/api/demo-funds/claim` endpoints remain the TEST-USDC-compatible default. Add `"asset": "SOL"` to both request bodies to use the SOL fee faucet; omit it or send `"asset": "TEST-USDC"` for the existing claim. `GET /api/demo-funds/status?wallet=...` returns independent `usdc` and `sol` states, while retaining the legacy top-level TEST-USDC `status` and `signature` fields.

## Claim behavior and recovery

- A random five-minute challenge is stored per wallet. Phantom signs the message; no user transaction or recipient input is accepted.
- SQLite reserves each `(wallet, claim type)` before any treasury transaction is built. TEST-USDC and SOL claims are independent, while concurrent requests for the same wallet and claim type cannot both pay.
- The treasury-signed transaction signature is stored **before** broadcast. Confirmed claims remain permanent, even after the recipient spends their tokens.
- Failed onchain transactions are released for a fresh challenge. Ambiguous RPC timeouts remain pending until signature status resolves or finalized block height passes expiry with a safety margin. A failed transfer is never recorded as successful.
- The source is only the treasury's current TEST-USDC balance. Each payout is fixed at 25 tokens; when fewer than 25 remain the API reports exhaustion. Approximately 1,000 tokens permit at most 40 payouts, assuming the treasury initially holds the full amount.
- SOL payouts are fixed at the configured amount, defaulting to 0.2 SOL. A payout is rejected if the separate SOL treasury would fall below its configured reserve after the transfer and estimated fee. The authoritative Devnet genesis check applies to both claim types.

For an ambiguous pending claim, leave the server and database intact and use **Check claim status** in the UI. If manual intervention is necessary, inspect the stored transaction signature on Devnet before altering a claim record. Never delete the database merely to allow another claim.

## Rotation or shutdown

To disable immediately, set `STOCKSPLIT_DEMO_FAUCET_ENABLED=false` and restart or stop the service. To rotate either treasury, disable payouts, resolve pending signatures, move only the remaining TEST-USDC or minimal Devnet SOL to the new dedicated treasury, update the corresponding keypair path, and restart. **Keep the same persistent SQLite database** so previous wallets remain ineligible for the corresponding claim type. Do not rotate the mint authority into the server.

## Verification

Run `node --test demo-faucet/*.test.mjs frontend/*.test.mjs` and `pnpm frontend:build`. Then, on Devnet with two invited wallets: claim exactly 25 TEST-USDC and exactly 0.2 SOL once per wallet, verify the claim signatures confirm, verify TEST-USDC and SOL claims remain independent, verify duplicate claims are blocked, verify a wallet without a TEST-USDC ATA gets one created, verify the SOL treasury reserve is enforced, and verify an empty treasury returns an exhausted state. Test a deliberately wrong-cluster RPC in a non-production environment; enabled startup must fail. No StockSplit protocol accounts are modified by faucet claims.
