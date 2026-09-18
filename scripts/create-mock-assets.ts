import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  createAssociatedTokenAccount,
  getAccount,
  getAssociatedTokenAddressSync,
  getMint,
  mintTo,
  TOKEN_2022_PROGRAM_ID,
} from "@solana/spl-token";
import { AnchorProvider, Wallet } from "@coral-xyz/anchor";
import { Connection, PublicKey } from "@solana/web3.js";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { assertDevnetCluster } from "./devnet-cluster";

type MockAssetLabel = "TEST-USDC" | "TEST-NVDAx" | "TEST-AAPLx" | "TEST-TSLAx" | "TEST-SPYx";

type MockAssetSpec = {
  label: MockAssetLabel;
  name: string;
  icon: string;
  decimals: number;
  mintAmount: bigint;
};

type MockAsset = {
  label: MockAssetLabel;
  name: string;
  icon: string;
  decimals: number;
  mint: string;
  tokenProgram: string;
  authority: string;
  note: string;
};

type ExistingManifest = {
  assets?: Array<Partial<MockAsset> & { label?: string }>;
};

const provider = AnchorProvider.env();
const connection: Connection = provider.connection;
const payer = (provider.wallet as Wallet).payer;
const outputPath = resolve(process.cwd(), "devnet-mock-assets.json");
const frontendConfigPath = resolve(process.cwd(), "frontend", "devnet-asset-config.mjs");
const MOCK_ASSET_NOTE = "Development-only Token-2022 mock. No monetary value. Never present as a real xStock or USDC.";
const APPROVED_MINTS: Record<MockAssetLabel, string> = {
  "TEST-USDC": "HfstGSPF1MJsD8hrpYTcPhqT6uxXTvCFSeuBYLsZJ26J",
  "TEST-NVDAx": "Cedwf76ynoKGU5jRxHNx2Y1B2b8VNuEEuf2jDevy7L9F",
  "TEST-AAPLx": "7DB6cCsaG1sFvPzX8DUL3GfetHbQyEMYmYHuShdhiNDW",
  "TEST-TSLAx": "AzkzmLNh2SzTTdHnYmaC4GAxiLnngCJkPeLDCNLRbPWm",
  "TEST-SPYx": "8DrsDuwYPsSY8LaLGKpiBFyCkz5bLFzdZAk6kbqKADJ9",
};

const MOCK_ASSET_SPECS: MockAssetSpec[] = [
  { label: "TEST-USDC", name: "Demo USDC", icon: "$", decimals: 6, mintAmount: 1_000_000_000n },
  { label: "TEST-NVDAx", name: "NVIDIA", icon: "N", decimals: 6, mintAmount: 1_000_000_000n },
  { label: "TEST-AAPLx", name: "Apple", icon: "A", decimals: 6, mintAmount: 1_000_000_000n },
  { label: "TEST-TSLAx", name: "Tesla", icon: "T", decimals: 6, mintAmount: 1_000_000_000n },
  { label: "TEST-SPYx", name: "S&P 500", icon: "S", decimals: 6, mintAmount: 1_000_000_000n },
];

async function readExistingAssets(): Promise<Map<string, Partial<MockAsset>>> {
  let raw: string;
  try {
    raw = await readFile(outputPath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      // Reconstruct only the manifest for the already-approved onchain mints.
      // New random mint addresses would be incompatible with the fixed program allowlist.
      return new Map(Object.entries(APPROVED_MINTS).map(([label, mint]) => [label, { mint }]));
    }
    throw error;
  }
  const manifest = JSON.parse(raw) as ExistingManifest & { cluster?: string };
  if (manifest.cluster !== "devnet" || !Array.isArray(manifest.assets)) {
    throw new Error("Existing Devnet mock-asset manifest is malformed; refusing to overwrite it.");
  }
  const knownLabels = new Set(MOCK_ASSET_SPECS.map((spec) => spec.label));
  const existing = new Map<string, Partial<MockAsset>>();
  for (const asset of manifest.assets) {
    if (!asset || typeof asset.label !== "string" || !knownLabels.has(asset.label as MockAssetLabel)
        || typeof asset.mint !== "string" || asset.mint !== APPROVED_MINTS[asset.label as MockAssetLabel]
        || existing.has(asset.label)) {
      throw new Error("Existing Devnet mock-asset manifest has an invalid or duplicate asset; refusing to overwrite it.");
    }
    try { new PublicKey(asset.mint); } catch {
      throw new Error(`Existing ${asset.label} mint address is invalid; refusing to replace it.`);
    }
    existing.set(asset.label, asset);
  }
  if (existing.size !== MOCK_ASSET_SPECS.length) {
    throw new Error("Existing Devnet mock-asset manifest is incomplete; repair it explicitly before rerunning this script.");
  }
  return existing;
}

async function validateMint(mint: PublicKey, spec: MockAssetSpec): Promise<Awaited<ReturnType<typeof getMint>>> {
  const mintAccountInfo = await connection.getAccountInfo(mint, "confirmed");
  if (!mintAccountInfo || !mintAccountInfo.owner.equals(TOKEN_2022_PROGRAM_ID)) {
    throw new Error(`${spec.label} mint is not an initialized Token-2022 mint`);
  }
  const mintData = await getMint(connection, mint, "confirmed", TOKEN_2022_PROGRAM_ID);
  if (mintData.decimals !== spec.decimals) {
    throw new Error(`${spec.label} mint has ${mintData.decimals} decimals; expected ${spec.decimals}`);
  }
  return mintData;
}

async function createOrReuseMockAsset(spec: MockAssetSpec, existing: Partial<MockAsset> | undefined): Promise<MockAsset> {
  if (existing?.mint !== APPROVED_MINTS[spec.label]) {
    throw new Error(`${spec.label} does not match the approved fixed Devnet mint; refusing to create a replacement.`);
  }
  const mint = new PublicKey(existing.mint);
  if (existing.authority && existing.authority !== payer.publicKey.toBase58()) {
    throw new Error(`${spec.label} is controlled by ${existing.authority}, not the configured demo operator`);
  }
  const mintData = await validateMint(mint, spec);
  if (!mintData.mintAuthority?.equals(payer.publicKey)) {
    throw new Error(`${spec.label} mint authority is not the configured demo operator; refusing to prepare or fund its account.`);
  }

  const tokenAccountAddress = getAssociatedTokenAddressSync(
    mint,
    payer.publicKey,
    false,
    TOKEN_2022_PROGRAM_ID,
    ASSOCIATED_TOKEN_PROGRAM_ID,
  );
  if (!(await connection.getAccountInfo(tokenAccountAddress, "confirmed"))) {
    await createAssociatedTokenAccount(
      connection,
      payer,
      mint,
      payer.publicKey,
      { commitment: "confirmed" },
      TOKEN_2022_PROGRAM_ID,
      ASSOCIATED_TOKEN_PROGRAM_ID,
    );
  }

  const tokenAccount = await getAccount(connection, tokenAccountAddress, "confirmed", TOKEN_2022_PROGRAM_ID);
  if (!tokenAccount.mint.equals(mint) || !tokenAccount.owner.equals(payer.publicKey)) {
    throw new Error(`${spec.label} ATA has an unexpected mint or owner`);
  }

  if (tokenAccount.amount < spec.mintAmount) {
    await mintTo(
      connection,
      payer,
      mint,
      tokenAccountAddress,
      payer,
      spec.mintAmount - tokenAccount.amount,
      [],
      { commitment: "confirmed" },
      TOKEN_2022_PROGRAM_ID,
    );
  }

  const fundedTokenAccount = await getAccount(connection, tokenAccountAddress, "confirmed", TOKEN_2022_PROGRAM_ID);
  if (fundedTokenAccount.amount < spec.mintAmount) {
    throw new Error(`${spec.label} operator ATA has ${fundedTokenAccount.amount} tokens; expected at least ${spec.mintAmount}`);
  }

  return {
    label: spec.label,
    name: spec.name,
    icon: spec.icon,
    decimals: spec.decimals,
    mint: mint.toBase58(),
    tokenProgram: TOKEN_2022_PROGRAM_ID.toBase58(),
    authority: payer.publicKey.toBase58(),
    note: MOCK_ASSET_NOTE,
  };
}

async function writeFrontendConfig(assets: MockAsset[]): Promise<void> {
  const mints = Object.fromEntries(assets.map((asset) => [asset.label, asset.mint]));
  const source = [
    "// Generated by scripts/create-mock-assets.ts from devnet-mock-assets.json.",
    "// Do not hand-edit mint addresses; rerun the operator script after creating assets.",
    `export const DEVNET_ASSET_MINTS = Object.freeze(${JSON.stringify(mints, null, 2)});`,
    "",
  ].join("\n");
  await writeFile(frontendConfigPath, source, "utf8");
}

async function main(): Promise<void> {
  await assertDevnetCluster(connection);
  const existingAssets = await readExistingAssets();
  const assets = [] as MockAsset[];
  for (const spec of MOCK_ASSET_SPECS) {
    assets.push(await createOrReuseMockAsset(spec, existingAssets.get(spec.label)));
  }

  const manifest = {
    cluster: "devnet",
    generatedAt: new Date().toISOString(),
    purpose: "Devnet demo only. These assets have no monetary value and are not real xStocks or USDC.",
    assets,
  };
  await mkdir(dirname(outputPath), { recursive: true });
  await writeFile(outputPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  await writeFrontendConfig(assets);

  console.log(`Verified/created ${assets.length} Token-2022 mock assets on ${connection.rpcEndpoint}`);
  console.log(`Manifest: ${outputPath}`);
  console.log(`Frontend config: ${frontendConfigPath}`);
  for (const asset of assets) console.log(`${asset.label} (${asset.name}): ${asset.mint}`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
