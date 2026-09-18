# StockSplit — Product & Technical Specification

**Tagline:** Invest together. Own independently.

## 1. Product

StockSplit is an invite-only collaborative investing application built on Solana.

A user creates a predefined portfolio of tokenized stocks, invites other wallets, and opens a limited contribution window.

Members contribute USDC during that window.

When the contribution window closes:

1. Contributions stop.
2. Each member's ownership percentage becomes fixed.
3. The pooled USDC is deployed into the predefined xStock basket.
4. The portfolio becomes active.
5. Members can independently withdraw their proportional share of the underlying assets.

StockSplit is not a brokerage, copy-trading platform, investment adviser, or managed fund.

It is a programmable ownership layer for people who intentionally want to invest together.

## 2. Problem

People already invest together:

- couples
- families
- friends
- investment circles
- small communities

Today this often means:

- one person owns the brokerage account;
- everyone sends money to that person;
- ownership is tracked manually;
- members must trust whoever controls the account;
- withdrawals require coordination.

StockSplit replaces this trust-heavy model with transparent onchain ownership.

## 3. Core Value

One portfolio can have multiple contributors while every participant retains a provable individual economic share.

The creator cannot withdraw another member's ownership.

A member does not need creator approval to exit once the portfolio is active.

**One portfolio. Multiple owners. Independent ownership.**

## 4. MVP User Flow

### Step 1 — Connect
User connects a Solana wallet.

### Step 2 — Create Circle
Creator defines:
- portfolio name;
- description;
- supported xStocks;
- allocation percentages;
- contribution target;
- contribution deadline.

Example: **AI Leaders**
- NVDAx — 40%
- AAPLx — 30%
- GOOGLx — 20%
- SPYx — 10%

Target: 500 USDC

Contribution deadline: September 16.

Allocations must equal exactly 100%.

After the first contribution, the basket configuration cannot be changed.

### Step 3 — Invite
StockSplit generates an invite URL.

Only invited/authorized wallets may participate in the MVP.

### Step 4 — Contribute
Members contribute USDC.

Example:
- Alice — 200 USDC
- Bob — 150 USDC
- Carol — 100 USDC
- Dave — 50 USDC

Total = 500 USDC.

During funding, ownership units correspond directly to USDC contributed:
- Alice — 200 units
- Bob — 150 units
- Carol — 100 units
- Dave — 50 units
- Total — 500 units

Therefore:
- Alice — 40%
- Bob — 30%
- Carol — 20%
- Dave — 10%

Units are internal ownership accounting, not publicly tradable tokens.

### Step 5 — Close Contributions
Funding closes when:
- the target is reached and the creator closes it; or
- the deadline is reached.

MVP rule: **No new deposits are accepted after funding closes.**

This eliminates complicated NAV-based entry accounting.

### Step 6 — Deploy Portfolio
The collected USDC is allocated according to the basket.

Example with 500 USDC:
- 200 USDC → NVDAx
- 150 USDC → AAPLx
- 100 USDC → GOOGLx
- 50 USDC → SPYx

Use Jupiter-compatible routing for secondary-market execution.

Each basket leg should execute separately.

Example deployment status:
- NVDAx — Complete
- AAPLx — Complete
- GOOGLx — Processing
- SPYx — Pending

If one swap fails, purchased assets remain in the vault and unused USDC remains safe.

Retry only the failed leg.

### Step 7 — Active Portfolio
After deployment the dashboard displays:
- portfolio holdings;
- scaled xStock balances;
- estimated portfolio value;
- each member's ownership percentage;
- each member's estimated share value;
- deployment transactions;
- contribution history.

Price movement does NOT alter ownership percentages.

### Step 8 — Withdraw
A member may withdraw their proportional share.

If Bob owns 30%, Bob receives 30% of each remaining underlying raw token balance:
- 30% of NVDAx
- 30% of AAPLx
- 30% of GOOGLx
- 30% of SPYx
- 30% of remaining USDC

The withdrawal is in-kind.

StockSplit does not need to sell assets or calculate NAV to determine withdrawal entitlement.

Bob's ownership units are then removed/burned from the accounting state.

### Cancel before deployment — refund contributions

The creator may cancel a portfolio only while it is `DRAFT`, `FUNDING`, or
`FUNDING_CLOSED`, and only if every deployment leg is still pending. Cancellation
is terminal: no contribution, deployment, active withdrawal, or creator sweep is
permitted afterward. `DEPLOYING`, `ACTIVE`, and `CLOSED` portfolios cannot be
cancelled.

In `CANCELLED`, each contributor independently signs a refund of exactly their
recorded raw USDC contribution from the canonical portfolio USDC vault to that
wallet's canonical USDC associated token account. No creator approval is
required. A successful refund zeros that member's outstanding contribution and
ownership units, subtracts the same amount from portfolio outstanding
contributions and units, and marks the member refunded. Duplicate refunds are
rejected. Unsolicited vault surplus never increases a refund and is not
creator-sweepable. Failed refunds leave all balances and accounting unchanged.
The portfolio remains `CANCELLED` after every member refunds.
This branch uses portfolio status `6` (`CANCELLED`) and member
`withdrawal_status = 2` (`REFUNDED`); no account-size change is required.

## 5. Portfolio Lifecycle

Use explicit states:

`DRAFT → FUNDING → FUNDING_CLOSED → DEPLOYING → ACTIVE → CLOSED`

Before any deployment leg executes, `DRAFT`, `FUNDING`, or `FUNDING_CLOSED`
may instead transition to terminal `CANCELLED`, where members claim their
recorded USDC refunds independently.

Invalid transitions must be rejected onchain.

## 6. Solana Architecture

Use a Solana program, preferably Anchor.

### Portfolio PDA
Stores:
- creator;
- portfolio ID;
- lifecycle status;
- contribution deadline;
- target USDC;
- total ownership units;
- supported basket assets;
- target allocations;
- deployment status.

### Member PDA
Stores:
- portfolio;
- wallet;
- ownership units;
- total contribution;
- withdrawal/refund settlement status (pending, active withdrawal completed, or cancelled refund completed).

### USDC Vault
PDA-controlled token account containing contributions before deployment and any residual USDC afterward.

### xStock Vaults
Separate PDA-controlled Token-2022 accounts for every supported asset.

Example:
- NVDAx vault
- AAPLx vault
- GOOGLx vault
- SPYx vault

No contributor or creator directly controls these accounts.

## 7. Ownership Rules

Ownership must be deterministic.

During funding:

`memberUnits += contributedUSDC`

`totalUnits += contributedUSDC`

Member ownership:

`memberUnits / totalUnits`

Once funding closes, units cannot increase.

Portfolio swaps must never change ownership units.

Market movements must never change ownership units.

Withdrawals reduce the withdrawing member's units and total outstanding units according to the implemented withdrawal model.

Cancelled refunds reduce outstanding member and portfolio contributions and
units by the exact recorded USDC amount. They do not use vault surplus.

Never use a centralized database as the source of truth for ownership.

The blockchain state is authoritative.

## 8. xStocks Integration

Real xStocks on Solana use SPL Token-2022 and are freely transferable onchain.

Corporate actions including dividends, stock splits, and reverse splits are reflected using the xStocks multiplier.

Important:

**Raw amount** = actual amount stored onchain and used in transactions.

**Scaled amount** = raw amount × current multiplier.

StockSplit must:
- transact using raw amounts;
- calculate withdrawals using raw balances;
- display multiplier-adjusted amounts;
- never use displayed balances as transaction amounts.

Multiplier data should come from Token-2022 metadata/onchain state, with xStocks public APIs available as supplementary metadata.

Portfolio interactions should avoid the brief activation window around pending multiplier changes where practical.

### Token-2022 Freeze Authority Policy

- Do not reject a mint solely because it has a freeze authority.
- Treat issuer-controlled freeze authority as an explicit external trust assumption.
- Future deployment and withdrawal paths must revalidate that every required token account is usable and not frozen immediately before execution.

## 9. Swap Architecture

MVP stablecoin: **USDC**

Execution target: **Jupiter-compatible Solana routing**

Architecture:

`Portfolio USDC Vault → approved swap transaction → xStock → matching Portfolio xStock Vault`

Security requirements:
- portfolio must be `FUNDING_CLOSED` or `DEPLOYING`;
- input mint must be USDC;
- output mint must be part of the immutable basket;
- input amount must not exceed that asset's approved allocation;
- minimum output/slippage protection required;
- arbitrary destination accounts prohibited;
- output must land in the portfolio's corresponding vault.

Immediately before deployment:

- revalidate supported mint/account compatibility;
- revalidate that all required token accounts are usable and not frozen;
- derive the deployment amount from recorded `total_contributed` / `total_units` accounting;
- never use unsolicited excess balance in a vault as the deployment amount.

Use one basket leg per transaction.

Do not make the entire basket depend on one giant atomic transaction.

## 10. Devnet / Mainnet Strategy

### Development
Use Solana devnet.

For the curated mock mints only, Devnet Demo Mode may use a fixed-price,
PDA-authorized settlement against pre-funded mock-token liquidity when no
Jupiter market exists. This is a separate compile-time Devnet build path;
the production build omits the demo instruction and retains the validated
Jupiter deployment route. Demo settlement must preserve recorded-allocation
input sizing, one leg per transaction, exact source/output vault deltas,
atomic rollback, and the existing deployment lifecycle. Demo tokens have no
monetary value. The mainnet proof must use real USDC and Jupiter routing.

Create mock Token-2022 assets representing:
- TEST-NVDAx
- TEST-AAPLx
- TEST-TSLAx
- TEST-SPYx
- devnet stablecoin/test USDC equivalent

Mocks exist only to test StockSplit mechanics.

The UI must clearly identify them as test assets.

### Final Proof
Use Solana mainnet with very small amounts of:
- real USDC;
- real xStocks.

Never present mock assets as genuine xStocks.

Real xStocks are fractional, so the mainnet proof should intentionally use minimal capital.

## 11. MVP Pages

### Landing
Explain: **Invest together. Own independently.**

Primary CTA: `Create a Portfolio`

Secondary CTA: `Join a Portfolio`

### Create Portfolio
Configure:
- name;
- assets;
- allocations;
- target;
- deadline;
- invited wallets.

### Portfolio / Funding
Show:
- target;
- collected amount;
- progress;
- members;
- individual contributions;
- ownership percentages;
- deadline;
- contribute button.

### Deployment
Show every basket leg and transaction state.

### Active Portfolio
Show:
- holdings;
- portfolio value;
- allocation;
- members;
- ownership percentages;
- transaction receipts;
- withdraw action.

### Withdrawal
Preview exact proportional underlying assets before confirmation.

### Cancelled Portfolio
Show the terminal `CANCELLED` state. Before deployment, the creator can cancel;
after cancellation, each funded member can claim their own exact USDC refund.

## 12. MVP Non-Goals

Do NOT build:
- continuous deposits after activation;
- NAV-based share issuance;
- active portfolio management;
- automatic rebalancing;
- AI investment recommendations;
- public fund discovery;
- copy trading;
- tradable portfolio shares;
- governance/voting;
- lending;
- leverage;
- derivatives;
- social feeds;
- fiat payments;
- traditional brokerage integrations.

These require future versions.

## 13. Safety

StockSplit must never:
- allow the creator to seize members' assets;
- allow arbitrary vault withdrawals;
- silently change basket allocations;
- pretend a failed swap succeeded;
- rely on frontend ownership calculations;
- trust user-supplied token mints without validation;
- confuse raw xStock balances with scaled balances.

Every state-changing action must be verifiable onchain.

## 14. Success Criteria

The MVP is complete only when this real flow works:

1. Wallet A creates a portfolio.
2. Wallet A contributes USDC.
3. Wallet B joins.
4. Wallet B contributes USDC.
5. Onchain state correctly records both members.
6. Contribution window closes.
7. Ownership becomes fixed.
8. USDC is deployed into the configured basket.
9. Portfolio vault actually holds the assets.
10. Both wallets see correct ownership.
11. Wallet B withdraws independently.
12. Wallet B receives its exact proportional underlying assets.
13. Wallet A's assets remain in the portfolio.
14. Transactions can be independently verified.

A beautiful UI without this flow is **not a completed StockSplit MVP**.

## 15. Build Phases

### Phase 0 — Technical Proof
Prove:
- Anchor project works;
- PDA token vault works;
- Token-2022 transfers work;
- two wallets can interact;
- mock assets work.

### Phase 1 — Portfolio + Funding
Implement:
- create portfolio;
- basket validation;
- invite/member state;
- USDC contribution;
- ownership units;
- funding lifecycle.

**Sol High review after Phase 1.**

### Phase 2 — Deployment Engine
Implement:
- close funding;
- calculate allocation amounts;
- Jupiter routing prototype;
- PDA-controlled swap;
- one-leg-at-a-time execution;
- retryable failures.

This is the highest-risk phase.

Do not continue until at least one real/mock routed swap works correctly.

**Sol High review after the first successful PDA-controlled swap.**

### Phase 3 — Portfolio + Withdrawals
Implement:
- active portfolio state;
- holdings;
- multiplier-aware xStock display;
- proportional raw-balance withdrawal;
- member exit accounting.

### Phase 4 — Product UI
Build polished:
- landing;
- creation flow;
- funding screen;
- deployment screen;
- portfolio dashboard;
- withdrawal preview.

### Phase 5 — Devnet End-to-End
Run complete two-wallet flow repeatedly.

Test:
- failed transactions;
- duplicate contributions;
- invalid members;
- expired funding;
- wrong token;
- unauthorized withdrawal;
- partial deployment;
- repeated withdrawal.

**Sol High security/reliability review.**

### Phase 6 — Mainnet Proof
Switch approved asset configuration to real xStock/USDC mints.

Use minimal capital.

Prove:

`real USDC → real xStocks → vault → proportional withdrawal`

### Phase 7 — Submission
Finish:
- demo script;
- README;
- architecture diagram;
- deployed app;
- transaction evidence;
- screenshots;
- submission copy.

**Final Sol High review before submission.**
