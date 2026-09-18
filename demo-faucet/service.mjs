import bs58 from "bs58";
import { LAMPORTS_PER_SOL, PublicKey, SystemProgram, Transaction } from "@solana/web3.js";
import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
  createAssociatedTokenAccountIdempotentInstruction,
  createTransferCheckedInstruction,
  getAccount,
  getAssociatedTokenAddressSync,
  getMint,
  getTransferFeeConfig,
} from "@solana/spl-token";
import {
  CLAIM_AMOUNT,
  CLAIM_TYPE_SOL,
  CLAIM_TYPE_USDC,
  FaucetError,
} from "./claim-store.mjs";
import { verifyClaimSignature } from "./auth.mjs";

export const TEST_USDC_MINT = new PublicKey("HfstGSPF1MJsD8hrpYTcPhqT6uxXTvCFSeuBYLsZJ26J");

export function solToLamports(value, fieldName = "SOL amount", { allowZero = false } = {}) {
  const text = String(value ?? "").trim();
  if (!/^\d+(?:\.\d{1,9})?$/.test(text)) throw new Error(`${fieldName} must be a decimal SOL amount with at most 9 decimals.`);
  const [whole, fraction = ""] = text.split(".");
  const lamports = BigInt(whole) * BigInt(LAMPORTS_PER_SOL)
    + BigInt((fraction + "0".repeat(9)).slice(0, 9));
  if ((!allowZero && lamports === 0n) || lamports < 0n || lamports > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new Error(`${fieldName} is outside the supported lamport range.`);
  }
  return lamports;
}

export function lamportsToSol(lamports) {
  const value = BigInt(lamports);
  const whole = value / BigInt(LAMPORTS_PER_SOL);
  const fraction = (value % BigInt(LAMPORTS_PER_SOL)).toString().padStart(9, "0").replace(/0+$/, "");
  return fraction ? `${whole}.${fraction}` : whole.toString();
}

export function normalizeClaimType(value) {
  const normalized = value == null ? CLAIM_TYPE_USDC : String(value).trim().toUpperCase();
  if (normalized === "USDC" || normalized === CLAIM_TYPE_USDC) return CLAIM_TYPE_USDC;
  if (normalized === CLAIM_TYPE_SOL) return CLAIM_TYPE_SOL;
  throw new FaucetError("Unsupported faucet claim type.");
}

export function parseWallet(value) {
  if (typeof value !== "string") throw new FaucetError("A wallet address is required.");
  let wallet;
  try { wallet = new PublicKey(value); } catch { throw new FaucetError("Invalid wallet address."); }
  if (wallet.toBase58() !== value || !PublicKey.isOnCurve(wallet.toBytes())) {
    throw new FaucetError("A connected wallet address is required.");
  }
  return wallet;
}

export class DemoFaucet {
  constructor({
    connection,
    officialDevnetConnection,
    treasury,
    solTreasury = null,
    store,
    solAmountLamports = solToLamports("0.2"),
    solMinReserveLamports = solToLamports("0.2"),
  }) {
    this.connection = connection;
    this.officialDevnetConnection = officialDevnetConnection;
    this.treasury = treasury;
    this.solTreasury = solTreasury;
    this.store = store;
    this.solAmountLamports = typeof solAmountLamports === "bigint"
      ? solAmountLamports
      : solToLamports(solAmountLamports, "SOL faucet amount");
    this.solMinReserveLamports = typeof solMinReserveLamports === "bigint"
      ? solMinReserveLamports
      : solToLamports(solMinReserveLamports, "SOL faucet minimum reserve", { allowZero: true });
    if (this.solAmountLamports <= 0n) throw new Error("SOL faucet amount must be positive.");
    if (this.solMinReserveLamports < 0n) throw new Error("SOL faucet minimum reserve cannot be negative.");
    if (this.solTreasury?.publicKey.equals(this.treasury.publicKey)) {
      throw new Error("SOL faucet treasury must be separate from the TEST-USDC treasury.");
    }
    this.claimLocks = new Map();
    this.treasuryAta = getAssociatedTokenAddressSync(
      TEST_USDC_MINT, treasury.publicKey, false, TOKEN_2022_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID,
    );
  }

  async withClaimLock(claimType, callback) {
    const previous = this.claimLocks.get(claimType) || Promise.resolve();
    let release;
    const next = new Promise((resolve) => { release = resolve; });
    const queued = previous.then(() => next);
    this.claimLocks.set(claimType, queued);
    await previous;
    try {
      return await callback();
    } finally {
      release();
      if (this.claimLocks.get(claimType) === queued) this.claimLocks.delete(claimType);
    }
  }

  async initialize() {
    const [actualGenesis, officialGenesis] = await Promise.all([
      this.connection.getGenesisHash(),
      this.officialDevnetConnection.getGenesisHash(),
    ]);
    if (actualGenesis !== officialGenesis) throw new Error("Faucet RPC is not Solana Devnet.");
    const mint = await getMint(this.connection, TEST_USDC_MINT, "confirmed", TOKEN_2022_PROGRAM_ID);
    if (mint.decimals !== 6 || getTransferFeeConfig(mint)) {
      throw new Error("TEST-USDC mint has unsupported decimals or transfer fees.");
    }
    if (mint.mintAuthority?.equals(this.treasury.publicKey)) {
      throw new Error("Faucet treasury must not also hold TEST-USDC mint authority.");
    }
    await this.treasuryBalance();
    if (this.solTreasury) await this.solTreasuryBalance();
  }

  async treasuryBalance() {
    const source = await getAccount(this.connection, this.treasuryAta, "confirmed", TOKEN_2022_PROGRAM_ID);
    if (!source.owner.equals(this.treasury.publicKey) || !source.mint.equals(TEST_USDC_MINT) || source.isFrozen) {
      throw new Error("Faucet treasury TEST-USDC account is not usable.");
    }
    return source.amount;
  }

  async solTreasuryBalance() {
    if (!this.solTreasury) return 0n;
    return BigInt(await this.connection.getBalance(this.solTreasury.publicKey, "confirmed"));
  }

  async solPayoutAvailable(transaction = null) {
    if (!this.solTreasury) return false;
    let feeLamports = 0n;
    if (transaction && typeof this.connection.getFeeForMessage === "function") {
      const fee = await this.connection.getFeeForMessage(transaction.compileMessage(), "confirmed");
      if (fee?.value == null) return false;
      feeLamports = BigInt(fee.value);
    }
    const balance = await this.solTreasuryBalance();
    return balance >= this.solAmountLamports + this.solMinReserveLamports + feeLamports;
  }

  async reconcile(wallet, claimType = CLAIM_TYPE_USDC) {
    const row = this.store.getClaim(wallet, claimType);
    if (!row) return null;
    if (row.status === "confirmed") return row;
    if (row.status === "reserved") {
      // No signed transaction exists yet. A stale reservation cannot have paid out.
      if (Date.now() - row.updated_at > 2 * 60_000) this.store.releaseReserved(wallet, claimType);
      return this.store.getClaim(wallet, claimType);
    }
    const statuses = await this.connection.getSignatureStatuses([row.signature], { searchTransactionHistory: true });
    const status = statuses.value[0];
    if (status?.err) {
      this.store.releaseSubmitted(wallet, row.signature, claimType);
    } else if (status?.confirmationStatus === "confirmed" || status?.confirmationStatus === "finalized") {
      this.store.markConfirmed(wallet, row.signature, claimType);
    } else if (!status) {
      // Wait for the finalized chain to pass expiry with a margin before allowing
      // another claim. A merely timed-out RPC call is never proof of failure.
      const finalizedHeight = await this.connection.getBlockHeight("finalized");
      if (finalizedHeight > row.last_valid_block_height + 150) {
        const reference = await this.officialDevnetConnection.getSignatureStatuses(
          [row.signature], { searchTransactionHistory: true },
        );
        const referenceStatus = reference.value[0];
        if (referenceStatus?.err) this.store.releaseSubmitted(wallet, row.signature, claimType);
        else if (referenceStatus?.confirmationStatus === "confirmed" || referenceStatus?.confirmationStatus === "finalized") {
          this.store.markConfirmed(wallet, row.signature, claimType);
        } else if (!referenceStatus) this.store.releaseSubmitted(wallet, row.signature, claimType);
      }
    }
    return this.store.getClaim(wallet, claimType);
  }

  async statusFor(wallet, claimType) {
    const solMeta = claimType === CLAIM_TYPE_SOL ? { amountSol: lamportsToSol(this.solAmountLamports) } : {};
    const row = await this.reconcile(wallet, claimType);
    if (row?.status === "confirmed") return { status: "claimed", signature: row.signature, ...solMeta };
    if (row) return { status: "pending", signature: row.signature || null, ...solMeta };
    if (claimType === CLAIM_TYPE_SOL) {
      const amountSol = solMeta.amountSol;
      if (!this.solTreasury) return { status: "unavailable", signature: null, amountSol, reason: "SOL faucet treasury is not configured." };
      return { status: await this.solPayoutAvailable() ? "available" : "exhausted", signature: null, amountSol };
    }
    return { status: (await this.treasuryBalance()) >= CLAIM_AMOUNT ? "available" : "exhausted", signature: null };
  }

  async status(walletText) {
    const wallet = parseWallet(walletText);
    const walletTextValue = wallet.toBase58();
    const [usdc, sol] = await Promise.all([
      this.statusFor(walletTextValue, CLAIM_TYPE_USDC),
      this.statusFor(walletTextValue, CLAIM_TYPE_SOL),
    ]);
    return { status: usdc.status, signature: usdc.signature, usdc, sol };
  }

  async challenge(walletText, claimTypeValue = CLAIM_TYPE_USDC) {
    const wallet = parseWallet(walletText);
    const claimType = normalizeClaimType(claimTypeValue);
    const payoutTreasury = claimType === CLAIM_TYPE_SOL ? this.solTreasury : this.treasury;
    if (!payoutTreasury) throw new FaucetError("Devnet SOL faucet is not configured.", 503);
    if (wallet.equals(payoutTreasury.publicKey)) throw new FaucetError("The treasury wallet cannot claim demo funds.");
    const row = await this.reconcile(wallet.toBase58(), claimType);
    if (row) throw new FaucetError("This wallet already has a claim in progress or completed.", 409);
    if (claimType === CLAIM_TYPE_SOL) {
      if (!(await this.solPayoutAvailable())) throw new FaucetError("Devnet SOL faucet is below its reserve.", 409);
    } else if ((await this.treasuryBalance()) < CLAIM_AMOUNT) {
      throw new FaucetError("Demo faucet is exhausted.", 409);
    }
    const claimDescription = claimType === CLAIM_TYPE_SOL ? `${lamportsToSol(this.solAmountLamports)} Devnet SOL` : null;
    return this.store.issueChallenge(wallet.toBase58(), claimType, Date.now(), claimDescription);
  }

  async claim({ wallet: walletText, nonce, signature: approvalSignature, asset, claimType: claimTypeValue }) {
    const wallet = parseWallet(walletText);
    const claimType = normalizeClaimType(asset ?? claimTypeValue);
    const payoutTreasury = claimType === CLAIM_TYPE_SOL ? this.solTreasury : this.treasury;
    if (!payoutTreasury) throw new FaucetError("Devnet SOL faucet is not configured.", 503);
    if (wallet.equals(payoutTreasury.publicKey)) throw new FaucetError("The treasury wallet cannot claim demo funds.");
    if (typeof nonce !== "string" || !/^[0-9a-f]{64}$/.test(nonce)) throw new FaucetError("Invalid claim approval.");
    const challenge = this.store.getChallenge(wallet.toBase58(), claimType);
    if (!challenge || challenge.nonce !== nonce || challenge.expires_at < Date.now()) {
      throw new FaucetError("Claim approval expired. Request a new demo-funds approval.", 401);
    }
    if (!verifyClaimSignature(wallet.toBytes(), challenge.message, approvalSignature)) {
      throw new FaucetError("Wallet signature did not match the claimant.", 401);
    }
    return this.withClaimLock(claimType, async () => {
      this.store.reserveClaim(wallet.toBase58(), nonce, claimType);
      let submittedSignature = null;
      try {
        const latest = await this.connection.getLatestBlockhash("confirmed");
        const transaction = new Transaction({ feePayer: payoutTreasury.publicKey, recentBlockhash: latest.blockhash });
        if (claimType === CLAIM_TYPE_SOL) {
          transaction.add(SystemProgram.transfer({
            fromPubkey: payoutTreasury.publicKey,
            toPubkey: wallet,
            lamports: Number(this.solAmountLamports),
          }));
          if (!(await this.solPayoutAvailable(transaction))) throw new FaucetError("Devnet SOL faucet is below its reserve.", 409);
        } else {
          if ((await this.treasuryBalance()) < CLAIM_AMOUNT) throw new FaucetError("Demo faucet is exhausted.", 409);
          const recipientAta = getAssociatedTokenAddressSync(
            TEST_USDC_MINT, wallet, false, TOKEN_2022_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID,
          );
          transaction.add(
            createAssociatedTokenAccountIdempotentInstruction(
              payoutTreasury.publicKey, recipientAta, wallet, TEST_USDC_MINT, TOKEN_2022_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID,
            ),
            createTransferCheckedInstruction(
              this.treasuryAta, TEST_USDC_MINT, recipientAta, payoutTreasury.publicKey,
              CLAIM_AMOUNT, 6, [], TOKEN_2022_PROGRAM_ID,
            ),
          );
        }
        transaction.sign(payoutTreasury);
        const raw = transaction.serialize();
        const signedSignature = bs58.encode(transaction.signature);
        this.store.markSubmitted(wallet.toBase58(), signedSignature, latest.blockhash, latest.lastValidBlockHeight, claimType);
        submittedSignature = signedSignature;
        try {
          const broadcastSignature = await this.connection.sendRawTransaction(raw, {
            skipPreflight: false, preflightCommitment: "confirmed", maxRetries: 3,
          });
          if (broadcastSignature !== submittedSignature) throw new Error("RPC returned a different transaction signature.");
          const confirmation = await this.connection.confirmTransaction(
            { signature: submittedSignature, blockhash: latest.blockhash, lastValidBlockHeight: latest.lastValidBlockHeight },
            "confirmed",
          );
          if (confirmation.value.err) {
            this.store.releaseSubmitted(wallet.toBase58(), submittedSignature, claimType);
            throw new FaucetError(`${claimType === CLAIM_TYPE_SOL ? "Devnet SOL transfer" : "Demo transfer"} failed onchain. Please retry the claim.`, 502);
          }
          this.store.markConfirmed(wallet.toBase58(), submittedSignature, claimType);
          return { status: "claimed", signature: submittedSignature };
        } catch (error) {
          if (error instanceof FaucetError) throw error;
          const row = await this.reconcile(wallet.toBase58(), claimType).catch(() => this.store.getClaim(wallet.toBase58(), claimType));
          if (row?.status === "confirmed") return { status: "claimed", signature: submittedSignature };
          if (!row) throw new FaucetError("Demo transfer failed. Request a new claim approval.", 502);
          return { status: "pending", signature: submittedSignature };
        }
      } catch (error) {
        if (!submittedSignature) this.store.releaseReserved(wallet.toBase58(), claimType);
        throw error;
      }
    });
  }
}
