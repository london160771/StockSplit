import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Connection, Keypair } from "@solana/web3.js";
import { ClaimStore, FaucetError } from "./claim-store.mjs";
import { DemoFaucet, solToLamports } from "./service.mjs";

const currentDir = path.dirname(fileURLToPath(import.meta.url));
const distDir = path.resolve(currentDir, "../frontend/dist");
const officialDevnetRpc = "https://api.devnet.solana.com";
const enabled = process.env.STOCKSPLIT_DEMO_FAUCET_ENABLED === "true";
const port = Number(process.env.PORT || 4174);
const host = process.env.HOST || "127.0.0.1";
const contentTypes = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
};
// The frontend build owns the public-file list, including transitive local imports.
const publicFiles = new Set(JSON.parse(fs.readFileSync(path.join(distDir, "asset-manifest.json"), "utf8")));
const demoFundsApiPrefix = "/api/demo-funds/";
const legacyDemoFaucetApiPrefix = "/api/demo-faucet/";

function canonicalDemoFundsPath(pathname) {
  return pathname.startsWith(legacyDemoFaucetApiPrefix)
    ? `${demoFundsApiPrefix}${pathname.slice(legacyDemoFaucetApiPrefix.length)}`
    : pathname;
}

function requiredPrivatePath(name) {
  const value = process.env[name];
  if (!value || !path.isAbsolute(value)) throw new Error(`${name} must be an absolute path outside the frontend build.`);
  const resolved = path.resolve(value);
  const relative = path.relative(distDir, resolved);
  if (!relative.startsWith("..") && !path.isAbsolute(relative)) {
    throw new Error(`${name} must not be inside the public frontend build.`);
  }
  return resolved;
}

function readKeypair(filename, name) {
  const secret = JSON.parse(fs.readFileSync(filename, "utf8"));
  if (!Array.isArray(secret) || secret.length !== 64 || secret.some((byte) => !Number.isInteger(byte) || byte < 0 || byte > 255)) {
    throw new Error(`${name} keypair file must contain a Solana 64-byte JSON secret key.`);
  }
  return Keypair.fromSecretKey(Uint8Array.from(secret));
}

function json(response, status, body) {
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
  });
  response.end(JSON.stringify(body));
}

async function readJson(request, requiredKeys, optionalKeys = []) {
  if (!String(request.headers["content-type"] || "").startsWith("application/json")) {
    throw new FaucetError("Expected a JSON request.", 415);
  }
  let raw = "";
  for await (const chunk of request) {
    raw += chunk;
    if (raw.length > 4096) throw new FaucetError("Request is too large.", 413);
  }
  let body;
  try { body = JSON.parse(raw); } catch { throw new FaucetError("Invalid JSON request."); }
  const keys = Object.keys(body || {});
  const required = new Set(requiredKeys);
  const optional = new Set(optionalKeys);
  if (!body || typeof body !== "object" || Array.isArray(body)
      || [...required].some((key) => !keys.includes(key))
      || keys.some((key) => !required.has(key) && !optional.has(key))) {
    throw new FaucetError("Unexpected claim fields.");
  }
  return body;
}

async function createFaucet() {
  if (!enabled) return null;
  const keypairPath = requiredPrivatePath("STOCKSPLIT_FAUCET_KEYPAIR_PATH");
  const solKeypairPath = process.env.STOCKSPLIT_SOL_FAUCET_KEYPAIR_PATH
    ? requiredPrivatePath("STOCKSPLIT_SOL_FAUCET_KEYPAIR_PATH")
    : null;
  const databasePath = requiredPrivatePath("STOCKSPLIT_FAUCET_DB_PATH");
  if (keypairPath === databasePath || solKeypairPath === databasePath) throw new Error("Faucet keypairs and claim database must be separate files.");
  if (solKeypairPath && solKeypairPath === keypairPath) throw new Error("SOL faucet treasury must be separate from the TEST-USDC treasury.");
  const treasury = readKeypair(keypairPath, "TEST-USDC faucet treasury");
  const solTreasury = solKeypairPath ? readKeypair(solKeypairPath, "SOL faucet treasury") : null;
  const solAmountLamports = solToLamports(process.env.STOCKSPLIT_SOL_FAUCET_AMOUNT_SOL || "0.2", "STOCKSPLIT_SOL_FAUCET_AMOUNT_SOL");
  const solMinReserveLamports = solToLamports(process.env.STOCKSPLIT_SOL_FAUCET_MIN_RESERVE_SOL || "0.2", "STOCKSPLIT_SOL_FAUCET_MIN_RESERVE_SOL", { allowZero: true });
  const store = new ClaimStore(databasePath);
  const connection = new Connection(process.env.STOCKSPLIT_FAUCET_DEVNET_RPC_URL || officialDevnetRpc, "confirmed");
  const officialDevnetConnection = new Connection(officialDevnetRpc, "confirmed");
  const faucet = new DemoFaucet({
    connection,
    officialDevnetConnection,
    treasury,
    solTreasury,
    solAmountLamports,
    solMinReserveLamports,
    store,
  });
  try { await faucet.initialize(); } catch (error) { store.close(); throw error; }
  console.log(`Devnet demo faucet enabled for treasury ${treasury.publicKey.toBase58()}`);
  if (solTreasury) console.log(`Devnet SOL fee faucet enabled for treasury ${solTreasury.publicKey.toBase58()} (${solAmountLamports} lamports per wallet, ${solMinReserveLamports} lamports reserve)`);
  else console.log("Devnet SOL fee faucet is disabled: STOCKSPLIT_SOL_FAUCET_KEYPAIR_PATH is not configured.");
  return faucet;
}

function serveStatic(pathname, response) {
  const filename = pathname === "/" ? "index.html" : pathname.slice(1);
  if (!publicFiles.has(filename)) return json(response, 404, { error: "Not found." });
  const file = path.join(distDir, filename);
  if (!fs.existsSync(file)) return json(response, 404, { error: "Frontend build is missing." });
  response.writeHead(200, {
    "Content-Type": contentTypes[path.extname(file)] || "application/octet-stream",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
  });
  fs.createReadStream(file).pipe(response);
}

if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("PORT must be a valid TCP port.");
if (!fs.existsSync(path.join(distDir, "index.html"))) throw new Error("Build the frontend before starting the demo faucet.");
const faucet = await createFaucet();
http.createServer(async (request, response) => {
  const url = new URL(request.url || "/", `http://${request.headers.host || "localhost"}`);
  const pathname = canonicalDemoFundsPath(url.pathname);
  if (!pathname.startsWith(demoFundsApiPrefix)) {
    if (request.method !== "GET") return json(response, 405, { error: "Method not allowed." });
    return serveStatic(url.pathname, response);
  }
  if (!faucet) return json(response, 503, { error: "Devnet demo funds are disabled." });
  try {
    if (request.method === "GET" && pathname === "/api/demo-funds/status") {
      return json(response, 200, await faucet.status(url.searchParams.get("wallet")));
    }
    if (request.method === "POST" && pathname === "/api/demo-funds/challenge") {
      const body = await readJson(request, ["wallet"], ["asset"]);
      return json(response, 200, await faucet.challenge(body.wallet, body.asset));
    }
    if (request.method === "POST" && pathname === "/api/demo-funds/claim") {
      const body = await readJson(request, ["wallet", "nonce", "signature"], ["asset"]);
      const result = await faucet.claim(body);
      return json(response, result.status === "claimed" ? 200 : 202, result);
    }
    return json(response, 404, { error: "Not found." });
  } catch (error) {
    if (!(error instanceof FaucetError)) console.error("Demo faucet request failed:", error);
    return json(response, error instanceof FaucetError ? error.status : 503, {
      error: error instanceof FaucetError ? error.message : "Demo funds are temporarily unavailable. Please try again later.",
    });
  }
}).listen(port, host, () => console.log(`StockSplit demo server listening at http://${host}:${port}`));
