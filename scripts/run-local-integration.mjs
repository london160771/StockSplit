import { spawn } from "node:child_process";
import { createHash, generateKeyPairSync } from "node:crypto";
import { closeSync, existsSync, mkdtempSync, openSync, readFileSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createServer } from "node:net";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const programId = "9nLrXyjgLTwMxnyBJ2GnKqnHZiu5koYNHrpKXezVGDmm";
const jupiterId = "JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4";
const token2022Id = "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb";
const fixtureMints = [
  ["TEST-USDC", "HfstGSPF1MJsD8hrpYTcPhqT6uxXTvCFSeuBYLsZJ26J", "devnet-demo-test-usdc.json"],
  ["TEST-NVDAx", "Cedwf76ynoKGU5jRxHNx2Y1B2b8VNuEEuf2jDevy7L9F", "devnet-demo-test-nvdax.json"],
  ["TEST-AAPLx", "7DB6cCsaG1sFvPzX8DUL3GfetHbQyEMYmYHuShdhiNDW", "devnet-demo-test-aaplx.json"],
  ["TEST-TSLAx", "AzkzmLNh2SzTTdHnYmaC4GAxiLnngCJkPeLDCNLRbPWm", "devnet-demo-test-tslax.json"],
  ["TEST-SPYx", "8DrsDuwYPsSY8LaLGKpiBFyCkz5bLFzdZAk6kbqKADJ9", "devnet-demo-test-spyx.json"],
];

function verifyInstructionDiscriminators(idl) {
  for (const name of ["cancel_portfolio", "refund_member"]) {
    const instruction = idl.instructions.find((item) => item.name === name);
    const canonical = [...createHash("sha256").update(`global:${name}`).digest().subarray(0, 8)];
    if (!instruction || JSON.stringify(instruction.discriminator) !== JSON.stringify(canonical)) {
      throw new Error(`${name} IDL discriminator must be generated from global:${name}.`);
    }
  }
}

function base58(bytes) {
  const alphabet = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
  let value = BigInt(`0x${bytes.toString("hex")}`);
  let encoded = "";
  while (value > 0n) {
    encoded = alphabet[Number(value % 58n)] + encoded;
    value /= 58n;
  }
  for (const byte of bytes) {
    if (byte !== 0) break;
    encoded = `1${encoded}`;
  }
  return encoded || "1";
}

function makeLocalWallet(directory) {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const privateDer = privateKey.export({ format: "der", type: "pkcs8" });
  const publicDer = publicKey.export({ format: "der", type: "spki" });
  const seed = privateDer.subarray(-32);
  const publicBytes = publicDer.subarray(-32);
  const path = join(directory, "local-test-wallet.json");
  writeFileSync(path, JSON.stringify([...seed, ...publicBytes]));
  return { path, publicBytes, address: base58(publicBytes) };
}

function writeLocalMintFixtures(directory, authority) {
  return fixtureMints.map(([label, address, filename]) => {
    const source = readFileSync(join(root, "tests", "fixtures", filename), "utf8");
    const fixture = JSON.parse(source);
    const encoded = fixture.account?.data?.[0];
    const data = Buffer.from(encoded || "", "base64");
    if (fixture.pubkey !== address || fixture.account?.owner !== token2022Id
        || fixture.account?.data?.[1] !== "base64" || data.length !== 82
        || data.readUInt32LE(0) !== 1 || data[44] !== 6 || data[45] !== 1
        || source.split(encoded).length !== 2) {
      throw new Error(`${label} fixture is not the exact approved initialized six-decimal Token-2022 mint.`);
    }
    // The local validator needs a test signer that can mint liquidity. Keep
    // the fixed mint address and every other public account byte unchanged.
    authority.copy(data, 4);
    const destination = join(directory, filename);
    writeFileSync(destination, source.replace(encoded, data.toString("base64")));
    return { label, address, destination };
  });
}

function validatorExecutable() {
  if (process.env.SOLANA_TEST_VALIDATOR_BIN) return process.env.SOLANA_TEST_VALIDATOR_BIN;
  if (process.platform === "win32") {
    const installed = join(process.env.USERPROFILE || "", ".local", "share", "solana", "install", "active_release", "bin", "solana-test-validator.exe");
    if (existsSync(installed)) return installed;
  }
  return "solana-test-validator";
}

function checkPortAvailable(port) {
  return new Promise((resolvePort, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => server.close(resolvePort));
  });
}

async function rpc(url, method, params = []) {
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  const body = await response.json();
  if (!response.ok || body.error) throw new Error(`${method}: ${JSON.stringify(body.error || response.status)}`);
  return body.result;
}

async function waitForLocalAccounts(url, child, mints) {
  const addresses = [programId, jupiterId, ...mints.map((mint) => mint.address)];
  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline) {
    if (child.startError) throw child.startError;
    if (child.exitCode !== null) throw new Error(`Local validator exited early with code ${child.exitCode}.`);
    try {
      const accounts = (await rpc(url, "getMultipleAccounts", [addresses, { encoding: "base64", commitment: "processed" }])).value;
      if (accounts.every(Boolean)) {
        if (!accounts[0].executable || !accounts[1].executable
            || mints.some((_, index) => accounts[index + 2].owner !== token2022Id)) {
          throw new Error("Loaded local programs or fixed mint accounts have unexpected ownership/executable state.");
        }
        return;
      }
    } catch (error) {
      if (String(error).includes("unexpected ownership")) throw error;
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 500));
  }
  throw new Error("Local validator did not load the fixed program, mock Jupiter, and all five mint fixtures within 90 seconds.");
}

function runTests(url, walletPath) {
  return new Promise((resolveTests, reject) => {
    const command = process.platform === "win32" ? "pnpm.cmd" : "pnpm";
    const child = spawn(command, ["test"], {
      cwd: root,
      env: { ...process.env, ANCHOR_PROVIDER_URL: url, ANCHOR_WALLET: walletPath },
      stdio: "inherit",
      shell: process.platform === "win32",
    });
    child.once("error", reject);
    child.once("exit", (code) => resolveTests(code ?? 1));
  });
}

function runCommand(command, args, label, env = process.env) {
  return new Promise((resolveRun, reject) => {
    const child = spawn(command, args, { cwd: root, env, stdio: "inherit" });
    child.once("error", reject);
    child.once("exit", (code) => {
      if (code === 0) resolveRun();
      else reject(new Error(`${label} exited with code ${code}.`));
    });
  });
}

async function buildFeatureProgram() {
  const binary = join(root, "target", "deploy", "stock_split_phase0.so");
  const source = join(root, "programs", "stock_split_phase0", "src", "lib.rs");
  const sourceModifiedAt = statSync(source).mtimeMs;
  const previousBinaryModifiedAt = existsSync(binary) ? statSync(binary).mtimeMs : 0;
  const buildEnv = { ...process.env, CARGO_TARGET_DIR: join(root, "target") };
  const anchor = process.platform === "win32" ? "anchor.exe" : "anchor";
  const cargo = process.platform === "win32" ? "cargo.exe" : "cargo";

  // A stale deploy .so can make every new instruction fall through despite a
  // correct generated IDL. Rebuild this package when the Rust source is newer.
  if (previousBinaryModifiedAt < sourceModifiedAt) {
    await runCommand(cargo, ["clean", "-p", "stock_split_phase0"], "Scoped StockSplit SBF clean", buildEnv);
  }
  await runCommand(anchor, [
    "build", "-p", "stock_split_phase0", "--no-idl", "--",
    "--tools-version", "v1.52", "--features", "devnet-demo",
  ], "Feature-enabled StockSplit build", buildEnv);
  if (!existsSync(binary) || statSync(binary).mtimeMs < sourceModifiedAt) {
    throw new Error("The StockSplit deploy .so is older than its Rust source; refusing to genesis-load a stale program.");
  }

  await runCommand(anchor, [
    "idl", "build", "-p", "stock_split_phase0",
    "-o", join(root, "target", "idl", "stock_split_phase0.json"),
    "-t", join(root, "target", "types", "stock_split_phase0.ts"),
    "--", "--features", "devnet-demo",
  ], "Feature-enabled StockSplit IDL generation", buildEnv);
  await runCommand(process.execPath, [join(root, "frontend", "build.mjs")], "Frontend build", buildEnv);
  const generatedIdl = readFileSync(join(root, "target", "idl", "stock_split_phase0.json"));
  const frontendIdl = readFileSync(join(root, "frontend", "dist", "stock_split_phase0.json"));
  if (!generatedIdl.equals(frontendIdl)) {
    throw new Error("The frontend IDL does not match the generated feature-enabled IDL byte-for-byte.");
  }
}

async function main() {
  const mode = process.argv[2];
  if (process.argv.length > 3 || (mode && mode !== "--verify-only" && mode !== "--fixtures-only")) {
    throw new Error("Usage: node scripts/run-local-integration.mjs [--verify-only|--fixtures-only]");
  }
  if (!mode) await buildFeatureProgram();
  const idl = JSON.parse(readFileSync(join(root, "target", "idl", "stock_split_phase0.json"), "utf8"));
  const instructionNames = new Set(idl.instructions.map((instruction) => instruction.name));
  if (idl.address !== programId || !instructionNames.has("deploy_demo_leg") || !instructionNames.has("prepare_demo_router")
      || !instructionNames.has("cancel_portfolio") || !instructionNames.has("refund_member")) {
    throw new Error("Build the exact feature-enabled StockSplit binary and IDL before the local integration suite.");
  }
  verifyInstructionDiscriminators(idl);
  const programBinary = join(root, "target", "deploy", "stock_split_phase0.so");
  const jupiterBinary = join(root, "target", "deploy", "mock_jupiter_router.so");
  if (!existsSync(programBinary) || !existsSync(jupiterBinary)) throw new Error("The StockSplit or mock Jupiter local binary is missing.");
  const source = join(root, "programs", "stock_split_phase0", "src", "lib.rs");
  if (mode !== "--fixtures-only" && statSync(programBinary).mtimeMs < statSync(source).mtimeMs) {
    throw new Error("The StockSplit deploy .so is older than its Rust source; refusing to genesis-load a stale program.");
  }
  const port = Number(process.env.LOCAL_DEMO_RPC_PORT || 8910);
  if (!Number.isInteger(port) || port < 1024 || port > 64535) throw new Error("LOCAL_DEMO_RPC_PORT must leave room for its RPC, websocket, and faucet ports.");
  if (mode !== "--fixtures-only") {
    await checkPortAvailable(port);
    await checkPortAvailable(port + 1);
    await checkPortAvailable(port + 1000);
  }
  const directory = mkdtempSync(join(tmpdir(), "stocksplit-local-demo-"));
  const wallet = makeLocalWallet(directory);
  const logPath = join(directory, "validator.log");
  let validator;
  try {
    const mints = writeLocalMintFixtures(directory, wallet.publicBytes);
    if (mode === "--fixtures-only") {
      console.log(`Validated and prepared ${mints.length} exact-address local Token-2022 mint fixtures: ${mints.map((mint) => `${mint.label}=${mint.address}`).join(", ")}`);
      return;
    }
    const logFd = openSync(logPath, "w");
    const args = [
      "--ledger", join(directory, "ledger"), "--rpc-port", String(port),
      "--faucet-port", String(port + 1000), "--bind-address", "127.0.0.1",
      "--mint", wallet.address,
      "--bpf-program", programId, programBinary,
      "--bpf-program", jupiterId, jupiterBinary,
      ...mints.flatMap((mint) => ["--account", mint.address, mint.destination]),
    ];
    validator = spawn(validatorExecutable(), args, { cwd: root, stdio: ["ignore", logFd, logFd] });
    validator.once("error", (error) => { validator.startError = error; });
    closeSync(logFd);
    const url = `http://127.0.0.1:${port}`;
    await waitForLocalAccounts(url, validator, mints);
    console.log(`Fresh local validator: ${url}`);
    console.log(`Genesis-loaded StockSplit ${programId}, mock Jupiter, and ${mints.length} exact-address Token-2022 mint fixtures.`);
    console.log(`Ephemeral local mint authority: ${wallet.address}`);
    if (mode === "--verify-only") return;
    const code = await runTests(url, wallet.path);
    if (code !== 0) throw new Error(`Full Anchor integration suite exited with code ${code}.`);
  } catch (error) {
    if (validator) console.error(`Validator log: ${logPath}`);
    throw error;
  } finally {
    validator?.kill();
    if (existsSync(wallet.path)) unlinkSync(wallet.path);
  }
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
