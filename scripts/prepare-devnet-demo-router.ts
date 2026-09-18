import { AnchorProvider, Program, Wallet } from "@coral-xyz/anchor";
import {
  createTransferCheckedInstruction,
  getAccount,
  getAssociatedTokenAddressSync,
  TOKEN_2022_PROGRAM_ID,
} from "@solana/spl-token";
import { PublicKey, sendAndConfirmTransaction, Transaction } from "@solana/web3.js";
import { readFileSync } from "node:fs";
import { assertDevnetCluster } from "./devnet-cluster";

const PROGRAM_ID = new PublicKey("9nLrXyjgLTwMxnyBJ2GnKqnHZiu5koYNHrpKXezVGDmm");
const TEST_USDC = new PublicKey("HfstGSPF1MJsD8hrpYTcPhqT6uxXTvCFSeuBYLsZJ26J");
const APPROVED_OUTPUTS = [
  { label: "TEST-NVDAx", mint: new PublicKey("Cedwf76ynoKGU5jRxHNx2Y1B2b8VNuEEuf2jDevy7L9F"), amountVariable: "DEMO_LIQUIDITY_TEST_NVDAX" },
  { label: "TEST-AAPLx", mint: new PublicKey("7DB6cCsaG1sFvPzX8DUL3GfetHbQyEMYmYHuShdhiNDW"), amountVariable: "DEMO_LIQUIDITY_TEST_AAPLX" },
  { label: "TEST-TSLAx", mint: new PublicKey("AzkzmLNh2SzTTdHnYmaC4GAxiLnngCJkPeLDCNLRbPWm"), amountVariable: "DEMO_LIQUIDITY_TEST_TSLAX" },
  { label: "TEST-SPYx", mint: new PublicKey("8DrsDuwYPsSY8LaLGKpiBFyCkz5bLFzdZAk6kbqKADJ9"), amountVariable: "DEMO_LIQUIDITY_TEST_SPYX" },
] as const;

function parseAmount(variable: string): bigint | null {
  const text = process.env[variable];
  if (text == null || text === "") return null;
  if (!/^(?:0|[1-9]\d*)(?:\.\d{1,6})?$/.test(text)) throw new Error(`${variable} must be a positive amount with up to six decimals.`);
  const [whole, fraction = ""] = text.split(".");
  const raw = BigInt(whole) * 1_000_000n + BigInt(fraction.padEnd(6, "0"));
  if (raw <= 0n || raw > 18_446_744_073_709_551_615n) throw new Error(`${variable} is outside the supported token amount range.`);
  return raw;
}

function verifyManifest(): void {
  const manifest = JSON.parse(readFileSync("devnet-mock-assets.json", "utf8"));
  if (manifest.cluster !== "devnet" || !Array.isArray(manifest.assets)) throw new Error("Expected the Devnet mock-asset manifest.");
  const mints = new Map(manifest.assets.map((asset: { label: string; mint: string }) => [asset.label, asset.mint]));
  if (mints.get("TEST-USDC") !== TEST_USDC.toBase58()) throw new Error("Manifest TEST-USDC mint does not match the onchain demo allowlist.");
  for (const asset of APPROVED_OUTPUTS) {
    if (mints.get(asset.label) !== asset.mint.toBase58()) throw new Error(`${asset.label} mint does not match the onchain demo allowlist.`);
  }
}

async function main() {
  const provider = AnchorProvider.env();
  await assertDevnetCluster(provider.connection);
  verifyManifest();
  const amounts = APPROVED_OUTPUTS.map((asset) => parseAmount(asset.amountVariable));
  const payer = (provider.wallet as Wallet).payer;
  if (!payer) throw new Error("ANCHOR_WALLET must point to the demo operator keypair file.");
  const idl = JSON.parse(readFileSync("target/idl/stock_split_phase0.json", "utf8"));
  const program = new Program(idl, provider);
  if (!program.programId.equals(PROGRAM_ID) || typeof program.methods.prepareDemoRouter !== "function"
      || typeof program.methods.deployDemoLeg !== "function") {
    throw new Error("Build the exact program and IDL with devnet-demo before preparing liquidity.");
  }
  const [demoAuthority] = PublicKey.findProgramAddressSync([Buffer.from("demo-authority")], PROGRAM_ID);
  const [demoUsdcSink] = PublicKey.findProgramAddressSync([Buffer.from("demo-sink"), TEST_USDC.toBuffer()], PROGRAM_ID);
  for (const [index, asset] of APPROVED_OUTPUTS.entries()) {
    const [demoOutputLiquidity] = PublicKey.findProgramAddressSync([Buffer.from("demo-liquidity"), asset.mint.toBuffer()], PROGRAM_ID);
    await program.methods.prepareDemoRouter().accounts({
      payer: payer.publicKey,
      inputMint: TEST_USDC,
      outputMint: asset.mint,
      demoAuthority,
      demoUsdcSink,
      demoOutputLiquidity,
      tokenProgram: TOKEN_2022_PROGRAM_ID,
    }).rpc();
    const amount = amounts[index];
    if (amount !== null) {
      const organizerSource = getAssociatedTokenAddressSync(asset.mint, payer.publicKey, false, TOKEN_2022_PROGRAM_ID);
      const source = await getAccount(provider.connection, organizerSource, "confirmed", TOKEN_2022_PROGRAM_ID);
      if (!source.mint.equals(asset.mint) || !source.owner.equals(payer.publicKey) || source.amount < amount) {
        throw new Error(`Organizer has insufficient or invalid ${asset.label} balance.`);
      }
      const instruction = createTransferCheckedInstruction(organizerSource, asset.mint, demoOutputLiquidity, payer.publicKey, amount, 6, [], TOKEN_2022_PROGRAM_ID);
      const signature = await sendAndConfirmTransaction(provider.connection, new Transaction().add(instruction), [payer], { commitment: "confirmed" });
      console.log(`Funded ${asset.label} liquidity with ${amount} raw units. Transaction: ${signature}`);
    }
    const funded = await getAccount(provider.connection, demoOutputLiquidity, "confirmed", TOKEN_2022_PROGRAM_ID);
    if (!funded.mint.equals(asset.mint) || !funded.owner.equals(demoAuthority)) throw new Error(`${asset.label} liquidity vault is not canonical.`);
    console.log(`${asset.label} liquidity vault: ${demoOutputLiquidity.toBase58()}, balance: ${funded.amount} raw units`);
  }
  console.log(`Demo TEST-USDC sink: ${demoUsdcSink.toBase58()}`);
  console.log("Only fund the finite demo amount intended for settlement; these PDA vaults cannot be reclaimed.");
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
