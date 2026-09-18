import { createHash } from "node:crypto";
import { readFile, realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";
import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import { assertDevnetCluster } from "./devnet-cluster";

const PROGRAM_ID = new PublicKey("9nLrXyjgLTwMxnyBJ2GnKqnHZiu5koYNHrpKXezVGDmm");
const UPGRADEABLE_LOADER = new PublicKey("BPFLoaderUpgradeab1e11111111111111111111111");
const ROOT = resolve(__dirname, "..");

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Set ${name} before the pre-upgrade check.`);
  return value;
}

function digest(data: Buffer): string {
  return createHash("sha256").update(data).digest("hex");
}

async function main(): Promise<void> {
  const endpoint = required("ANCHOR_PROVIDER_URL");
  const expectedAuthority = new PublicKey(required("EXPECTED_UPGRADE_AUTHORITY"));
  const expectedBinaryHash = required("EXPECTED_DEMO_BINARY_SHA256").toLowerCase();
  const expectedIdlHash = required("EXPECTED_DEMO_IDL_SHA256").toLowerCase();
  if (![expectedBinaryHash, expectedIdlHash].every((value) => /^[0-9a-f]{64}$/.test(value))) {
    throw new Error("Expected artifact SHA-256 values must each contain exactly 64 hex characters.");
  }
  const keypairPath = required("PROGRAM_KEYPAIR");
  if (!isAbsolute(keypairPath)) throw new Error("PROGRAM_KEYPAIR must be an absolute external path.");
  const externalPath = await realpath(keypairPath);
  const relativeKeypair = relative(ROOT, externalPath);
  if (!relativeKeypair.startsWith("..") && !isAbsolute(relativeKeypair)) {
    throw new Error("PROGRAM_KEYPAIR must be outside the StockSplit workspace.");
  }
  const keypairBytes = JSON.parse(await readFile(externalPath, "utf8"));
  if (!Array.isArray(keypairBytes) || keypairBytes.length !== 64
      || keypairBytes.some((value) => !Number.isInteger(value) || value < 0 || value > 255)) {
    throw new Error("PROGRAM_KEYPAIR is not a Solana 64-byte keypair file.");
  }
  const keypair = Keypair.fromSecretKey(Uint8Array.from(keypairBytes));
  if (!keypair.publicKey.equals(PROGRAM_ID)) throw new Error("External program keypair does not resolve to the fixed StockSplit program ID.");

  const connection = new Connection(endpoint, "confirmed");
  await assertDevnetCluster(connection);
  const binary = await readFile(resolve(ROOT, "target/deploy/stock_split_phase0.so"));
  const idlBytes = await readFile(resolve(ROOT, "target/idl/stock_split_phase0.json"));
  const servedIdlBytes = await readFile(resolve(ROOT, "frontend/dist/stock_split_phase0.json"));
  if (!binary.length || digest(binary) !== expectedBinaryHash) throw new Error("Feature-enabled binary does not match the tested SHA-256.");
  if (digest(idlBytes) !== expectedIdlHash || !idlBytes.equals(servedIdlBytes)) {
    throw new Error("Feature-enabled IDL hash or served frontend IDL does not match the tested artifact.");
  }
  const idl = JSON.parse(idlBytes.toString("utf8"));
  if (idl.address !== PROGRAM_ID.toBase58()) throw new Error("IDL program address differs from the fixed StockSplit ID.");
  const instructionNames = new Set((idl.instructions || []).map((instruction: { name: string }) => instruction.name));
  if (!instructionNames.has("prepare_demo_router") || !instructionNames.has("deploy_demo_leg")
      || !instructionNames.has("deploy_leg")) {
    throw new Error("IDL must contain both demo instructions and the unchanged Jupiter deploy_leg instruction.");
  }

  const programAccount = await connection.getAccountInfo(PROGRAM_ID, "confirmed");
  if (!programAccount?.executable || !programAccount.owner.equals(UPGRADEABLE_LOADER)
      || programAccount.data.length < 36 || programAccount.data.readUInt32LE(0) !== 2) {
    throw new Error("The fixed program ID is not an executable upgradeable program on Devnet.");
  }
  const programDataAddress = new PublicKey(programAccount.data.subarray(4, 36));
  const programData = await connection.getAccountInfo(programDataAddress, "confirmed");
  if (!programData?.owner.equals(UPGRADEABLE_LOADER) || programData.data.length < 45
      || programData.data.readUInt32LE(0) !== 3 || programData.data[12] !== 1) {
    throw new Error("Devnet program data has no valid upgrade authority.");
  }
  const actualAuthority = new PublicKey(programData.data.subarray(13, 45));
  if (!actualAuthority.equals(expectedAuthority)) throw new Error(`Unexpected Devnet upgrade authority: ${actualAuthority.toBase58()}.`);

  console.log(`Devnet genesis, program ID, external keypair, and upgrade authority verified.`);
  console.log(`Program: ${PROGRAM_ID.toBase58()}, authority: ${actualAuthority.toBase58()}`);
  console.log(`Tested binary SHA-256: ${expectedBinaryHash}`);
  console.log(`Tested IDL SHA-256: ${expectedIdlHash}`);
  console.log("Read-only verification complete. No program was deployed or upgraded.");
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
