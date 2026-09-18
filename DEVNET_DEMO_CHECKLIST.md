# StockSplit Devnet Demo — Pre-upgrade and Walkthrough Checklist

This runbook is **Devnet-only**. TEST-USDC and TEST-xStocks have no monetary value. The fixed program ID is `9nLrXyjgLTwMxnyBJ2GnKqnHZiu5koYNHrpKXezVGDmm`. Production builds omit `devnet-demo` and continue to use the validated Jupiter `deploy_leg` route. Never run `anchor keys sync` or deploy a demo-feature binary to mainnet.

## Before any upgrade

- [ ] Confirm the intended RPC's `getGenesisHash` equals the pinned Solana Devnet hash `EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG`. URL text alone is not proof of cluster identity.
- [ ] Keep `PROGRAM_KEYPAIR` at an absolute path outside this workspace/OneDrive. Confirm it resolves to the fixed program ID. Record the expected **public** upgrade authority in `EXPECTED_UPGRADE_AUTHORITY`; never place a secret key in the frontend or repository.
- [ ] Build the exact demo binary locally: `anchor build -p stock_split_phase0 --no-idl -- --tools-version v1.52 --features devnet-demo`. Reject any `Stack offset exceeded max offset of 4096` warning.
- [ ] Generate the matching IDL: `anchor idl build -p stock_split_phase0 -o target/idl/stock_split_phase0.json -- --features devnet-demo`. Confirm `prepare_demo_router`, `deploy_demo_leg`, and the unchanged `deploy_leg` are present.
- [ ] Run `node frontend/build.mjs`; confirm `frontend/dist/stock_split_phase0.json` is byte-identical to the tested IDL.
- [ ] Run `cargo fmt --check`, `cargo test -p stock_split_phase0 --features devnet-demo`, and `pnpm test:local-demo`. The local harness starts a fresh validator, genesis-loads the fixed-ID program and mock Jupiter, and explicitly supplies five exact-address mint fixtures; it does not submit Devnet transactions. Do not approve an upgrade unless the demo settlement cases execute and the entire suite passes.
- [ ] Record the tested `target/deploy/stock_split_phase0.so` and `target/idl/stock_split_phase0.json` SHA-256 values in `EXPECTED_DEMO_BINARY_SHA256` and `EXPECTED_DEMO_IDL_SHA256`. Do not rebuild or edit either artifact after recording them.
- [ ] Run `pnpm demo:verify-upgrade` with `ANCHOR_PROVIDER_URL`, `PROGRAM_KEYPAIR`, `EXPECTED_UPGRADE_AUTHORITY`, and both expected hashes set. It is read-only and must verify the Devnet genesis, external program keypair, fixed IDL address/instructions, binary/IDL hashes, served IDL equality, current executable program, and onchain upgrade authority. **Do not upgrade if any check fails.**

## Approved mock liquidity

The onchain allowlist contains exactly TEST-NVDAx, TEST-AAPLx, TEST-TSLAx, and TEST-SPYx. The operator script checks the same fixed addresses against `devnet-mock-assets.json`, and both operator scripts verify the Devnet genesis hash before changing state.

- [ ] Confirm the TEST-USDC sink is canonical and every selected output has its own canonical demo-liquidity PDA.
- [ ] Set finite amounts for `DEMO_LIQUIDITY_TEST_NVDAX`, `DEMO_LIQUIDITY_TEST_AAPLX`, `DEMO_LIQUIDITY_TEST_TSLAX`, and `DEMO_LIQUIDITY_TEST_SPYX` as needed; run `pnpm demo-router:prepare` **only after** the Devnet program upgrade and the verifier passes. Omitted amounts prepare vaults without transferring tokens.
- [ ] Read back the TEST-NVDAx liquidity balance and confirm it covers every planned NVDA leg.
- [ ] Read back the TEST-AAPLx liquidity balance and confirm it covers every planned AAPL leg.
- [ ] Read back the TEST-TSLAx liquidity balance and confirm it covers every planned TSLA leg.
- [ ] Read back the TEST-SPYx liquidity balance and confirm it covers every planned SPY leg.
- [ ] Confirm the faucet treasury has enough TEST-USDC and fee SOL for the complete walkthrough. Liquidity PDA deposits cannot be reclaimed; fund only the finite demo amount.
- [ ] Confirm the generated frontend Devnet asset config contains the four current mint addresses and that the frontend tests/build pass.

## Two-wallet demo sequence (after upgrade)

- [ ] Connect wallet A on Devnet; claim TEST-USDC and confirm a repeat claim is rejected.
- [ ] Create a fresh portfolio using one or more curated TEST-xStocks, with allocations totaling exactly 100%; prepare vaults, invite wallet B, and open funding.
- [ ] Contribute from both wallets and verify their onchain units. Confirm a late contribution is rejected.
- [ ] Close funding and click **Invest funds** once per selected leg. For each, verify exact recorded-allocation TEST-USDC spend, exact 1:1 raw-unit output into the matching vault, and one completed leg.
- [ ] Verify a failed leg leaves balances/state unchanged and can be retried. Verify only the final successful leg makes the portfolio **Active**.
- [ ] Withdraw wallet B independently, then wallet A; verify proportional in-kind assets, residual TEST-USDC, and the final **Closed** state.

Stop if the program ID, cluster identity, authority, IDL/hash, canonical vaults, available liquidity, or source/output deltas differ from expectations.
