import assert from "node:assert/strict";
import test from "node:test";
import { allVaultsReady, canCancelPortfolio, canClaimRefund, cancelPortfolioDiagnostics, isCanonicalVault, memberClaimRaw, memberHasWithdrawn, memberRefunded, portfolioInviteUrl } from "./portfolio-ux.mjs";
import { memberRole } from "./public-key-utils.mjs";

const key = (value) => ({ equals: (other) => value === other });
const comparableKey = (value) => ({ value, equals: (other) => other?.value === value, toBase58: () => value });

test("member rendering tolerates missing wallet and public-key values", () => {
  const creator = comparableKey("creator");
  const connectedMember = comparableKey("member");

  assert.equal(memberRole({ wallet: null }, creator, connectedMember), "Invited member");
  assert.equal(memberRole({}, creator, connectedMember), "Invited member");
  assert.equal(memberRole({ wallet: creator }, creator, null), "Creator");
  assert.equal(memberRole({ wallet: connectedMember }, null, connectedMember), "You");
});

test("vault readiness requires a canonical mint and portfolio owner", () => {
  assert.equal(isCanonicalVault({ mint: key("mint"), owner: key("portfolio") }, "mint", "portfolio"), true);
  assert.equal(isCanonicalVault({ mint: key("other"), owner: key("portfolio") }, "mint", "portfolio"), false);
  assert.equal(isCanonicalVault({ mint: key("mint"), owner: key("other") }, "mint", "portfolio"), false);
  assert.equal(isCanonicalVault(null, "mint", "portfolio"), false);
});

test("all required USDC and basket vaults must be initialized", () => {
  assert.equal(allVaultsReady([{ initialized: true }, { initialized: true }], 1), true);
  assert.equal(allVaultsReady([{ initialized: true }], 1), false);
  assert.equal(allVaultsReady([{ initialized: true }, { initialized: false }], 1), false);
});

test("invite links work on localhost and a public deployment without changing the portfolio key", () => {
  assert.equal(portfolioInviteUrl("http://localhost:4173/?old=1#detail", "PortfolioPda"), "http://localhost:4173/?portfolio=PortfolioPda");
  assert.equal(portfolioInviteUrl("https://example.com/app/?old=1", "PortfolioPda"), "https://example.com/app/?portfolio=PortfolioPda");
});

test("withdrawn members have no claim while portfolio vault balances remain independent", () => {
  const portfolioVaultBalance = 2_500_000n;
  assert.equal(memberClaimRaw(portfolioVaultBalance, 0n, 5_000_000n), 0n);
  assert.equal(portfolioVaultBalance, 2_500_000n);
  assert.equal(memberHasWithdrawn({ withdrawalStatus: 1, ownershipUnits: 0n }), true);
  assert.equal(memberHasWithdrawn({ withdrawalStatus: 0, ownershipUnits: 0n }), true);
  assert.equal(memberHasWithdrawn({ withdrawalStatus: 0, ownershipUnits: 5_000_000n }), false);
  assert.equal(memberClaimRaw(portfolioVaultBalance, 5_000_000n, 5_000_000n), portfolioVaultBalance);
});

test("only the creator sees cancellation before any leg executes", () => {
  const portfolio = { creator: key("creator"), usdcMint: { toBase58: () => "configured-mint" },
    status: 1, deploymentLegs: [{ status: 0 }] };
  assert.equal(canCancelPortfolio(portfolio, "creator"), true);
  assert.equal(canCancelPortfolio(portfolio, "other"), false);
  portfolio.deploymentLegs[0].status = 1;
  assert.equal(canCancelPortfolio(portfolio, "creator"), false);
  portfolio.deploymentLegs[0].status = 0;
  portfolio.status = 3;
  assert.equal(canCancelPortfolio(portfolio, "creator"), false);
  portfolio.status = 0;
  portfolio.usdcMint.toBase58 = () => "11111111111111111111111111111111";
  assert.equal(canCancelPortfolio(portfolio, "creator"), false);
});

test("missing deployment legs mean deployment has not started and remain cancellable", () => {
  const portfolio = {
    publicKey: comparableKey("portfolio"),
    creator: key("creator"),
    usdcMint: { toBase58: () => "configured-mint" },
    status: 2,
    basket: [{}, {}],
  };
  const diagnostics = cancelPortfolioDiagnostics(portfolio, "creator");
  assert.equal(canCancelPortfolio(portfolio, "creator"), true);
  assert.equal(diagnostics.allowed, true);
  assert.equal(diagnostics.reason, null);
  assert.equal(diagnostics.deploymentLegCount, 0);
  assert.equal(diagnostics.deploymentLegsPresent, false);
  assert.deepEqual(diagnostics.legStatuses, []);
});

test("cancelled members can claim only an outstanding recorded refund", () => {
  const portfolio = { status: 6 };
  const member = { totalContributed: 25_000_000n, ownershipUnits: 25_000_000n, withdrawalStatus: 0 };
  assert.equal(canClaimRefund(portfolio, member), true);
  member.totalContributed = 0n;
  member.ownershipUnits = 0n;
  member.withdrawalStatus = 2;
  assert.equal(memberRefunded(member), true);
  assert.equal(canClaimRefund(portfolio, member), false);
  assert.equal(canClaimRefund({ status: 4 }, { ...member, totalContributed: 1n, ownershipUnits: 1n, withdrawalStatus: 0 }), false);
});
