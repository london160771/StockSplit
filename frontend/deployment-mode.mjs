import { basketAssets, contributionAsset } from "./asset-registry.mjs";

export function deploymentMode(network, inputMint, outputMint) {
  if (network === "devnet") {
    if (inputMint !== contributionAsset("devnet").mint
        || !basketAssets("devnet").some((asset) => asset.mint === outputMint)) {
      throw new Error("This Devnet portfolio does not use approved demo assets.");
    }
    return "devnet-demo";
  }
  if (network === "mainnet-beta") return "mainnet-jupiter";
  throw new Error("Investment routing is not configured for this network.");
}
