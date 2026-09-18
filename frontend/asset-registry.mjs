import { DEVNET_ASSET_MINTS } from "./devnet-asset-config.mjs";

const DEVNET_CATALOG = Object.freeze([
  Object.freeze({ key: "TEST-NVDAx", ticker: "TEST-NVDAx", name: "NVIDIA", icon: "N" }),
  Object.freeze({ key: "TEST-AAPLx", ticker: "TEST-AAPLx", name: "Apple", icon: "A" }),
  Object.freeze({ key: "TEST-TSLAx", ticker: "TEST-TSLAx", name: "Tesla", icon: "T" }),
  Object.freeze({ key: "TEST-SPYx", ticker: "TEST-SPYx", name: "S&P 500", icon: "S" }),
]);

export const DEVNET_USDC = Object.freeze({
  key: "TEST-USDC",
  ticker: "TEST-USDC",
  name: "Demo USDC",
  icon: "$",
  mint: DEVNET_ASSET_MINTS["TEST-USDC"],
  decimals: 6,
  available: Boolean(DEVNET_ASSET_MINTS["TEST-USDC"]),
});

export const DEVNET_ASSETS = Object.freeze(DEVNET_CATALOG.map((asset) => Object.freeze({
  ...asset,
  mint: DEVNET_ASSET_MINTS[asset.key] || null,
  decimals: 6,
  available: Boolean(DEVNET_ASSET_MINTS[asset.key]),
  demoPriceNumerator: 1n,
  demoPriceDenominator: 1n,
})));

export function devnetAssetCatalog() {
  return DEVNET_ASSETS;
}

export function contributionAsset(network) {
  return network === "devnet" ? DEVNET_USDC : null;
}

export function isApprovedContributionMint(network, mint) {
  const configured = contributionAsset(network);
  return Boolean(configured?.mint && String(mint) === configured.mint);
}

export function contributionAssetLabel(network, mint) {
  const configured = contributionAsset(network);
  return isApprovedContributionMint(network, mint)
    ? configured.ticker
    : "Unapproved contribution asset";
}

export function basketAssets(network) {
  return network === "devnet" ? DEVNET_ASSETS : [];
}

export function displayAsset(network, mint, isUsdc = false) {
  const address = String(mint);
  if (isUsdc) return contributionAssetLabel(network, address);
  const configured = basketAssets(network).find((asset) => asset.mint === address);
  return configured?.ticker || "Basket asset";
}

export function assetDetails(network, mint, isUsdc = false) {
  const address = String(mint);
  return isUsdc
    ? isApprovedContributionMint(network, address) ? contributionAsset(network) : null
    : basketAssets(network).find((asset) => asset.mint === address) || null;
}

export function validateBasketSelection(network, rows) {
  const registry = basketAssets(network);
  if (rows.length < 1 || rows.length > 8) throw new Error("Choose between 1 and 8 assets.");
  const seen = new Set();
  let total = 0;
  const basket = rows.map((row) => {
    const asset = registry.find((entry) => entry.mint === row.mint);
    if (!asset) throw new Error("Choose an asset from the approved list.");
    if (!asset.available || !asset.mint) throw new Error(`${asset.ticker} is not available on Devnet yet. Ask the operator to run the mock-asset script.`);
    if (seen.has(asset.mint)) throw new Error("Each basket asset can appear only once.");
    seen.add(asset.mint);
    const allocationText = String(row.allocation).trim();
    if (!/^(?:0|[1-9]\d*)(?:\.\d{1,2})?$/.test(allocationText)) throw new Error("Use whole or two-decimal allocation percentages.");
    const [whole, fraction = ""] = allocationText.split(".");
    const allocationBps = Number(whole) * 100 + Number(fraction.padEnd(2, "0"));
    if (!Number.isSafeInteger(allocationBps) || allocationBps <= 0 || allocationBps > 10_000) {
      throw new Error("Enter a valid allocation percentage.");
    }
    total += allocationBps;
    return { mint: asset.mint, allocationBps };
  });
  if (total !== 10_000) throw new Error("Allocations must total exactly 100%.");
  return basket;
}
