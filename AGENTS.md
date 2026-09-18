# AGENTS.md — StockSplit

This file and `STOCKSPLIT_SPEC.md` are the source of truth for the project.

Do not change core architecture, scope, lifecycle, ownership rules, or security assumptions without explicitly updating the specification first.

When instructions conflict:

1. Latest explicit user instruction
2. `STOCKSPLIT_SPEC.md`
3. `AGENTS.md`
4. Existing implementation

## Product

StockSplit is an invite-only collaborative xStock portfolio application on Solana.

Core loop:

`Create → Invite → Contribute USDC → Close Funding → Deploy Basket → Hold → Withdraw Proportionally`

Tagline: **Invest together. Own independently.**

## MVP Principle

Build the smallest real end-to-end product.

Prioritize:

1. correct onchain ownership;
2. safe custody;
3. working contributions;
4. real basket deployment;
5. independent proportional withdrawals;
6. transaction verification;
7. UI polish.

Never sacrifice core correctness to add features.

## Mandatory Architecture

Use:

- Solana;
- Anchor for program development unless a strong technical reason requires otherwise;
- PDA-controlled vaults;
- Token-2022 support;
- USDC as the contribution asset;
- immutable basket configuration after contributions begin;
- fixed ownership after funding closes;
- in-kind proportional withdrawals;
- Jupiter-compatible routing for basket deployment;
- one swap leg per transaction.

Development:

- Solana devnet;
- mock Token-2022 xStocks.

Final proof:

- Solana mainnet;
- minimal real USDC/xStock amounts.

## Ownership

Onchain state is the source of truth.

Do not use a database as authoritative ownership accounting.

During funding:

`memberUnits += contribution`

`totalUnits += contribution`

After funding closes:

- no new units;
- no new contributors;
- swaps do not modify units;
- asset price movement does not modify units.

Members own:

`memberUnits / totalUnits`

of the portfolio.

## Withdrawals

MVP withdrawals are proportional and in-kind.

Before any deployment leg executes, the creator may cancel a DRAFT, FUNDING,
or FUNDING_CLOSED portfolio. A cancelled portfolio is terminal. Each member may
independently reclaim exactly their recorded raw USDC contribution from the
canonical portfolio vault to their canonical USDC account. Refunds zero that
member's outstanding contribution and units and reduce portfolio outstanding
contributions and units. Duplicate refunds are forbidden; unsolicited vault
surplus is never included and no creator sweep is allowed.

If a user owns X% of outstanding portfolio ownership, withdrawal returns the appropriate proportional raw amounts of each underlying asset according to the implemented unit accounting.

Do not require:

- portfolio liquidation;
- creator permission;
- market prices;
- NAV oracle.

Never use scaled UI xStock amounts when constructing transfers.

## xStocks

Solana xStocks use SPL Token-2022.

Corporate actions use Scaled UI multipliers.

Rules:

- use raw amount for transactions;
- use multiplier-adjusted amount for display;
- retrieve multiplier from trusted token/onchain data;
- never treat displayed amount as raw amount;
- account for multiplier activation timing.

Do not fake xStocks on mainnet.

Devnet mocks must be visibly marked as mocks.

### Token-2022 Freeze Authority Policy

- Do not reject a mint solely because it has a freeze authority.
- Treat issuer-controlled freeze authority as an explicit external trust assumption.
- Future deployment and withdrawal paths must revalidate that every required token account is usable and not frozen immediately before execution.

## Swap Security

The portfolio program must restrict deployments.

A valid deployment leg must:

- originate from the portfolio USDC vault;
- target a basket asset already stored in portfolio state;
- respect that asset's approved allocation;
- enforce minimum output/slippage protection;
- send resulting tokens to the matching portfolio vault.

Immediately before deployment, revalidate supported mint/account compatibility and required account usability.

Deployment amounts must come from recorded `total_contributed` / `total_units` accounting. Never derive a deployment amount from unsolicited excess balance in a vault.

Never permit:

- arbitrary output mints;
- arbitrary recipients;
- creator-selected destinations;
- unrestricted use of portfolio funds.

If a leg fails:

- do not mark it complete;
- preserve remaining USDC;
- allow safe retry.

## Lifecycle

Supported states:

`DRAFT`

`FUNDING`

`FUNDING_CLOSED`

`DEPLOYING`

`ACTIVE`

`CLOSED`

`CANCELLED` (terminal pre-deployment branch from DRAFT, FUNDING, or FUNDING_CLOSED)

Validate every transition.

Never use UI state as authority for program state.

## Security Rules

Reject:

- unauthorized contributors where invite restrictions apply;
- contributions after funding closes;
- allocation totals != 100%;
- unauthorized funding closure;
- arbitrary vault transfers;
- duplicate completed deployment legs;
- withdrawals exceeding ownership;
- repeated full withdrawals;
- invalid token program/mint accounts;
- spoofed vault accounts;
- unchecked arithmetic;
- unsafe rounding.

Use checked arithmetic.

Test rounding behavior explicitly.

Never use floating-point arithmetic onchain.

## Coding Rules

Prefer:

- small modules;
- explicit types;
- deterministic functions;
- clear errors;
- minimal dependencies;
- reusable Solana helpers;
- tests around every financial calculation.

Avoid:

- giant components;
- unnecessary abstractions;
- speculative architecture;
- premature optimization;
- AI-generated placeholder logic left in production paths.

No mocked success states.

If execution fails, surface the real failure.

## Frontend

Design should feel:

- premium;
- simple;
- financial;
- trustworthy;
- consumer-friendly.

Avoid:

- generic crypto-dashboard aesthetics;
- excessive gradients;
- tiny text;
- excessive animation;
- AI/chatbot interfaces;
- unnecessarily technical blockchain terminology.

The portfolio lifecycle should always be obvious.

Important states should have strong visual distinction:

**Funding**

**Deploying**

**Active**

**Withdrawn**

Users should understand what will happen before signing any transaction.

## Backend

Keep backend responsibilities minimal.

Allowed:

- Jupiter route/quote retrieval;
- public xStocks metadata/price data;
- application metadata;
- non-authoritative indexing;
- transaction status helpers.

Forbidden:

- authoritative ownership;
- private keys for portfolio assets;
- silently executing withdrawals;
- overriding onchain state.

Never expose secrets to the client.

## Testing Priority

Highest priority tests:

1. contribution accounting;
2. ownership percentages;
3. unauthorized vault access;
4. funding closure;
5. post-close contribution rejection;
6. deployment restrictions;
7. partial deployment failure;
8. Token-2022 transfer behavior;
9. proportional withdrawal;
10. rounding;
11. repeated withdrawal;
12. multiple members exiting sequentially.

Also run complete two-wallet integration tests.

## Scope Protection

Do not add during the MVP unless explicitly requested:

- AI;
- rebalancing;
- continuous deposits;
- public portfolio marketplace;
- copy trading;
- governance;
- tradable portfolio tokens;
- lending;
- leverage;
- options;
- recurring investments;
- social features.

If a feature does not help complete:

`contribute → deploy → own → withdraw`

defer it.

## Phase Discipline

At the end of every phase:

1. summarize files changed;
2. summarize implemented behavior;
3. report tests/build status;
4. report known limitations;
5. identify anything needing `.env`;
6. provide exact commands to run frontend/backend/program where relevant;
7. stop before beginning the next phase.

Do not silently move into another phase.

Major reviews should use **GPT-5.6 Sol High** after:

- funding/ownership core;
- first successful PDA-controlled swap;
- end-to-end devnet completion;
- final mainnet/submission readiness.

## Definition of Done

StockSplit is not done because pages render.

It is done when two independent wallets can complete the real lifecycle:

`contribute → receive ownership → deploy pooled assets → hold real portfolio assets → independently withdraw correct proportional assets`

with verifiable Solana transactions and no trusted custodian controlling member ownership.
