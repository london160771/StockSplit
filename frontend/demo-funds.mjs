import { DEVNET_USDC } from "./asset-registry.mjs";

export const TEST_USDC_MINT_ADDRESS = DEVNET_USDC.mint;
export const DEMO_CLAIM_RAW = 25_000_000n;

export function demoFundsAvailableForPortfolio(network, portfolioMint) {
  return network === "devnet" && portfolioMint === TEST_USDC_MINT_ADDRESS;
}

export function needsDemoFunds(balance) {
  return balance != null && BigInt(balance) < DEMO_CLAIM_RAW;
}
