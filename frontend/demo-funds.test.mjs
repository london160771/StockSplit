import assert from "node:assert/strict";
import test from "node:test";
import { DEMO_CLAIM_RAW, TEST_USDC_MINT_ADDRESS, demoFundsAvailableForPortfolio, needsDemoFunds } from "./demo-funds.mjs";

test("demo funds are offered only for the configured Devnet mock USDC mint", () => {
  assert.equal(demoFundsAvailableForPortfolio("devnet", TEST_USDC_MINT_ADDRESS), true);
  assert.equal(demoFundsAvailableForPortfolio("mainnet-beta", TEST_USDC_MINT_ADDRESS), false);
  assert.equal(demoFundsAvailableForPortfolio("devnet", "another-mint"), false);
});

test("low balance means less than one fixed 25 TEST-USDC claim", () => {
  assert.equal(DEMO_CLAIM_RAW, 25_000_000n);
  assert.equal(needsDemoFunds(0n), true);
  assert.equal(needsDemoFunds(24_999_999n), true);
  assert.equal(needsDemoFunds(25_000_000n), false);
  assert.equal(needsDemoFunds(null), false);
});
