import { randomBytes } from "node:crypto";
import { DatabaseSync } from "node:sqlite";

export const CLAIM_AMOUNT = 25_000_000n;
export const CLAIM_TYPE_USDC = "TEST-USDC";
export const CLAIM_TYPE_SOL = "SOL";
export const CHALLENGE_LIFETIME_MS = 5 * 60_000;

const CLAIM_TYPES = new Set([CLAIM_TYPE_USDC, CLAIM_TYPE_SOL]);

function normalizeClaimType(value = CLAIM_TYPE_USDC) {
  if (!CLAIM_TYPES.has(value)) throw new FaucetError("Unsupported faucet claim type.");
  return value;
}

function normalizeClaimTypeAndNow(claimTypeOrNow, maybeNow) {
  if (typeof claimTypeOrNow === "number") {
    return { claimType: CLAIM_TYPE_USDC, now: claimTypeOrNow };
  }
  return {
    claimType: normalizeClaimType(claimTypeOrNow),
    now: maybeNow ?? Date.now(),
  };
}

export class FaucetError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.name = "FaucetError";
    this.status = status;
  }
}

export function challengeMessage(wallet, nonce, expiresAt, claimType = CLAIM_TYPE_USDC, claimDescription = null) {
  const normalizedType = normalizeClaimType(claimType);
  const description = claimDescription || (normalizedType === CLAIM_TYPE_SOL ? "0.2 Devnet SOL" : "25 TEST-USDC");
  return [
    "StockSplit Devnet Demo Funds",
    `Wallet: ${wallet}`,
    `Claim: ${description} to this wallet only`,
    `Asset: ${normalizedType}`,
    `Nonce: ${nonce}`,
    `Expires: ${new Date(expiresAt).toISOString()}`,
    normalizedType === CLAIM_TYPE_SOL
      ? "This is a message signature, not a transaction. Devnet SOL is only for transaction fees and has no monetary value."
      : "This is a message signature, not a transaction. Demo tokens have no monetary value.",
  ].join("\n");
}

function createChallengesTableSql(tableName) {
  return `
    CREATE TABLE IF NOT EXISTS ${tableName} (
      wallet TEXT NOT NULL,
      claim_type TEXT NOT NULL CHECK (claim_type IN ('${CLAIM_TYPE_USDC}', '${CLAIM_TYPE_SOL}')),
      nonce TEXT NOT NULL,
      message TEXT NOT NULL,
      expires_at INTEGER NOT NULL,
      PRIMARY KEY (wallet, claim_type)
    );`;
}

function createClaimsTableSql(tableName) {
  return `
    CREATE TABLE IF NOT EXISTS ${tableName} (
      wallet TEXT NOT NULL,
      claim_type TEXT NOT NULL CHECK (claim_type IN ('${CLAIM_TYPE_USDC}', '${CLAIM_TYPE_SOL}')),
      status TEXT NOT NULL CHECK (status IN ('reserved', 'submitted', 'confirmed')),
      signature TEXT,
      blockhash TEXT,
      last_valid_block_height INTEGER,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY (wallet, claim_type)
    );`;
}

export class ClaimStore {
  constructor(dbPath) {
    this.db = new DatabaseSync(dbPath);
    this.db.exec("PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;");
    this.migrateWalletOnlyTables();
    this.db.exec(`${createChallengesTableSql("challenges")}${createClaimsTableSql("claims")}`);
  }

  close() { this.db.close(); }

  migrateWalletOnlyTables() {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      for (const [tableName, createSql] of [["challenges", createChallengesTableSql], ["claims", createClaimsTableSql]]) {
        const columns = this.db.prepare(`PRAGMA table_info(${tableName})`).all();
        if (columns.length === 0) continue;
        if (columns.some((column) => column.name === "claim_type")) continue;
        const legacyName = `${tableName}_legacy`;
        this.db.exec(`ALTER TABLE ${tableName} RENAME TO ${legacyName};${createSql(tableName)}`);
        if (tableName === "challenges") {
          this.db.exec(`INSERT INTO challenges (wallet, claim_type, nonce, message, expires_at)
            SELECT wallet, '${CLAIM_TYPE_USDC}', nonce, message, expires_at FROM ${legacyName};`);
        } else {
          this.db.exec(`INSERT INTO claims (wallet, claim_type, status, signature, blockhash, last_valid_block_height, updated_at)
            SELECT wallet, '${CLAIM_TYPE_USDC}', status, signature, blockhash, last_valid_block_height, updated_at FROM ${legacyName};`);
        }
        this.db.exec(`DROP TABLE ${legacyName};`);
      }
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  getClaim(wallet, claimType = CLAIM_TYPE_USDC) {
    const normalizedType = normalizeClaimType(claimType);
    return this.db.prepare("SELECT * FROM claims WHERE wallet = ? AND claim_type = ?").get(wallet, normalizedType) || null;
  }

  getChallenge(wallet, claimType = CLAIM_TYPE_USDC) {
    const normalizedType = normalizeClaimType(claimType);
    return this.db.prepare("SELECT * FROM challenges WHERE wallet = ? AND claim_type = ?").get(wallet, normalizedType) || null;
  }

  issueChallenge(wallet, claimTypeOrNow = CLAIM_TYPE_USDC, maybeNow = Date.now(), claimDescription = null) {
    const { claimType, now } = normalizeClaimTypeAndNow(claimTypeOrNow, maybeNow);
    if (this.getClaim(wallet, claimType)) throw new FaucetError("This wallet already has a claim in progress or completed.", 409);
    const current = this.getChallenge(wallet, claimType);
    if (current && current.expires_at >= now) {
      return { nonce: current.nonce, message: current.message, expiresAt: current.expires_at };
    }
    this.db.prepare("DELETE FROM challenges WHERE expires_at < ?").run(now);
    const nonce = randomBytes(32).toString("hex");
    const expiresAt = now + CHALLENGE_LIFETIME_MS;
    const message = challengeMessage(wallet, nonce, expiresAt, claimType, claimDescription);
    this.db.prepare("INSERT OR REPLACE INTO challenges (wallet, claim_type, nonce, message, expires_at) VALUES (?, ?, ?, ?, ?)")
      .run(wallet, claimType, nonce, message, expiresAt);
    return { nonce, message, expiresAt };
  }

  reserveClaim(wallet, nonce, claimTypeOrNow = CLAIM_TYPE_USDC, maybeNow = Date.now()) {
    const { claimType, now } = normalizeClaimTypeAndNow(claimTypeOrNow, maybeNow);
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const existing = this.getClaim(wallet, claimType);
      if (existing) throw new FaucetError("This wallet already has a claim in progress or completed.", 409);
      const challenge = this.getChallenge(wallet, claimType);
      if (!challenge || challenge.nonce !== nonce || challenge.expires_at < now) {
        throw new FaucetError("Claim approval expired. Request a new demo-funds approval.", 401);
      }
      this.db.prepare("INSERT INTO claims (wallet, claim_type, status, updated_at) VALUES (?, ?, 'reserved', ?)").run(wallet, claimType, now);
      this.db.prepare("DELETE FROM challenges WHERE wallet = ? AND claim_type = ?").run(wallet, claimType);
      this.db.exec("COMMIT");
      return challenge;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  markSubmitted(wallet, signature, blockhash, lastValidBlockHeight, claimTypeOrNow = CLAIM_TYPE_USDC, maybeNow = Date.now()) {
    const { claimType, now } = normalizeClaimTypeAndNow(claimTypeOrNow, maybeNow);
    const result = this.db.prepare("UPDATE claims SET status = 'submitted', signature = ?, blockhash = ?, last_valid_block_height = ?, updated_at = ? WHERE wallet = ? AND claim_type = ? AND status = 'reserved'")
      .run(signature, blockhash, lastValidBlockHeight, now, wallet, claimType);
    if (result.changes !== 1) throw new Error("Claim reservation was lost before submission.");
  }

  markConfirmed(wallet, signature, claimTypeOrNow = CLAIM_TYPE_USDC, maybeNow = Date.now()) {
    const { claimType, now } = normalizeClaimTypeAndNow(claimTypeOrNow, maybeNow);
    const result = this.db.prepare("UPDATE claims SET status = 'confirmed', updated_at = ? WHERE wallet = ? AND claim_type = ? AND status = 'submitted' AND signature = ?")
      .run(now, wallet, claimType, signature);
    if (result.changes !== 1 && this.getClaim(wallet, claimType)?.status !== "confirmed") {
      throw new Error("Submitted claim disappeared before confirmation could be recorded.");
    }
  }

  releaseReserved(wallet, claimType = CLAIM_TYPE_USDC) {
    const normalizedType = normalizeClaimType(claimType);
    this.db.prepare("DELETE FROM claims WHERE wallet = ? AND claim_type = ? AND status = 'reserved'").run(wallet, normalizedType);
  }

  releaseSubmitted(wallet, signature, claimType = CLAIM_TYPE_USDC) {
    const normalizedType = normalizeClaimType(claimType);
    this.db.prepare("DELETE FROM claims WHERE wallet = ? AND claim_type = ? AND status = 'submitted' AND signature = ?").run(wallet, normalizedType, signature);
  }
}
