import test from "node:test";
import assert from "node:assert/strict";
import { assetDetails, basketAssets, contributionAsset, displayAsset, isApprovedContributionMint, validateBasketSelection } from "./asset-registry.mjs";
import { FUNDING_ENDED_MESSAGE, fundingCloseLabel, fundingCountdown, fundingEnded } from "./funding-deadline.mjs";
import { friendlyActionError, isRefundAlreadyCompletedError, isWithdrawalAlreadyCompletedError } from "./action-errors.mjs";
import { deploymentMode } from "./deployment-mode.mjs";

test("Devnet registry fixes contribution mint and exposes the curated mock asset catalog", () => {
  assert.equal(contributionAsset("devnet").mint, "HfstGSPF1MJsD8hrpYTcPhqT6uxXTvCFSeuBYLsZJ26J");
  assert.deepEqual(basketAssets("devnet").map((asset) => asset.ticker), ["TEST-NVDAx", "TEST-AAPLx", "TEST-TSLAx", "TEST-SPYx"]);
  assert.deepEqual(basketAssets("devnet").map((asset) => asset.name), ["NVIDIA", "Apple", "Tesla", "S&P 500"]);
  assert.equal(basketAssets("devnet")[0].icon, "N");
  assert.equal(displayAsset("devnet", basketAssets("devnet")[0].mint), "TEST-NVDAx");
  assert.equal(isApprovedContributionMint("devnet", contributionAsset("devnet").mint), true);
  assert.equal(displayAsset("devnet", "11111111111111111111111111111111", true), "Unapproved contribution asset");
  assert.equal(assetDetails("devnet", "11111111111111111111111111111111", true), null);
  assert.deepEqual(validateBasketSelection("devnet", [{ mint: basketAssets("devnet")[0].mint, allocation: "100.00" }]), [
    { mint: basketAssets("devnet")[0].mint, allocationBps: 10_000 },
  ]);
  assert.throws(() => validateBasketSelection("devnet", [{ mint: basketAssets("devnet")[0].mint, allocation: "99.99" }]), /total exactly 100/);
  assert.throws(() => validateBasketSelection("devnet", [{ mint: "11111111111111111111111111111111", allocation: "100" }]), /approved list/);
  assert.throws(() => validateBasketSelection("devnet", [
    { mint: basketAssets("devnet")[0].mint, allocation: "50" },
    { mint: basketAssets("devnet")[0].mint, allocation: "50" },
  ]), /only once/);
  for (const asset of basketAssets("devnet")) {
    assert.equal(asset.available, true);
    assert.deepEqual(validateBasketSelection("devnet", [{ mint: asset.mint, allocation: "100" }]), [
      { mint: asset.mint, allocationBps: 10_000 },
    ]);
  }
  assert.equal(contributionAsset("mainnet-beta"), null);
  assert.equal(basketAssets("mainnet-beta").length, 0);
});

test("funding clock includes local date/time and expires on boundary", () => {
  const close = 1_800_000_000;
  assert.match(fundingCloseLabel(close, "en-US"), /\d/);
  assert.equal(fundingCountdown(close, close * 1000 - 1000), "00:00:01 remaining");
  assert.equal(fundingEnded(close, close * 1000 - 1), false);
  assert.equal(fundingEnded(close, close * 1000), true);
  assert.equal(fundingCountdown(close, close * 1000), FUNDING_ENDED_MESSAGE);
});

test("known funding errors are friendly and raw simulation stays hidden", () => {
  assert.equal(friendlyActionError(new Error("AnchorError FundingWindowExpired 6014 Logs: private")), FUNDING_ENDED_MESSAGE);
  assert.equal(friendlyActionError(new Error("Transaction simulation failed: Custom(9). Logs: Program log: secret")), "Transaction could not be completed. Please try again.");
  assert.equal(friendlyActionError(new Error("Jupiter /build failed (400)"), "Investing funds"), "Investment could not be completed. Try again.");
});

test("completed withdrawal and missing wallet signature show actionable messages", () => {
  for (const error of [
    new Error("AnchorError WithdrawalAlreadyCompleted"),
    new Error("Transaction simulation failed: custom program error: 0x17a7"),
    { error: { errorCode: { number: 6055 } } },
  ]) {
    assert.equal(isWithdrawalAlreadyCompletedError(error), true);
    assert.equal(friendlyActionError(error, "Withdrawing"), "You already withdrew from this portfolio.");
  }
  assert.match(friendlyActionError({ code: "WALLET_SIGNATURE_MISSING" }, "Withdrawing"), /Phantom did not sign.*selected Solana account/);
});

test("cancel and refund failures are friendly without exposing simulation logs", () => {
  assert.equal(isRefundAlreadyCompletedError(new Error("RefundAlreadyCompleted")), true);
  assert.equal(isRefundAlreadyCompletedError({ error: { errorCode: { number: 6057 } } }), true);
  assert.equal(friendlyActionError(new Error("RefundAlreadyCompleted"), "Claiming refund"),
    "You already claimed your refund from this portfolio.");
  assert.equal(friendlyActionError(new Error("NoRefundAvailable"), "Claiming refund"),
    "This wallet has no recorded contribution left to refund.");
  assert.equal(friendlyActionError(new Error("InvalidLifecycle: logs: private"), "Cancel portfolio"),
    "This portfolio cannot be cancelled after investment begins.");
});

test("Devnet mock assets cannot fall through to Jupiter routing", () => {
  const usdc = contributionAsset("devnet").mint;
  const nvda = basketAssets("devnet")[0].mint;
  assert.equal(deploymentMode("devnet", usdc, nvda), "devnet-demo");
  assert.throws(() => deploymentMode("devnet", usdc, "11111111111111111111111111111111"), /approved demo assets/);
  assert.throws(() => deploymentMode("localnet", usdc, nvda), /not configured/);
  assert.equal(deploymentMode("mainnet-beta", usdc, nvda), "mainnet-jupiter");
});
