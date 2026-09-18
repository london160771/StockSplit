import assert from "node:assert/strict";
import { createPrivateKey, sign } from "node:crypto";
import test from "node:test";
import bs58 from "bs58";
import { Keypair, LAMPORTS_PER_SOL, SystemInstruction, Transaction } from "@solana/web3.js";
import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
  decodeTransferCheckedInstruction,
  getAssociatedTokenAddressSync,
} from "@solana/spl-token";
import { CLAIM_TYPE_SOL, CLAIM_TYPE_USDC, ClaimStore, FaucetError } from "./claim-store.mjs";
import { DemoFaucet, TEST_USDC_MINT, solToLamports } from "./service.mjs";

const ED25519_PKCS8_PREFIX = Buffer.from("302e020100300506032b657004220420", "hex");

function approve(wallet, message) {
  const privateKey = createPrivateKey({
    key: Buffer.concat([ED25519_PKCS8_PREFIX, Buffer.from(wallet.secretKey.subarray(0, 32))]),
    format: "der", type: "pkcs8",
  });
  return sign(null, Buffer.from(message), privateKey).toString("base64");
}

test("server signs one fixed Token-2022 payout to the signing wallet's ATA", async () => {
  const store = new ClaimStore(":memory:");
  try {
    const treasury = Keypair.generate();
    const claimant = Keypair.generate();
    const claimantAta = getAssociatedTokenAddressSync(TEST_USDC_MINT, claimant.publicKey, false, TOKEN_2022_PROGRAM_ID);
    const treasuryAta = getAssociatedTokenAddressSync(TEST_USDC_MINT, treasury.publicKey, false, TOKEN_2022_PROGRAM_ID);
    const blockhash = Keypair.generate().publicKey.toBase58();
    let broadcasts = 0;
    const connection = {
      getLatestBlockhash: async () => ({ blockhash, lastValidBlockHeight: 100 }),
      sendRawTransaction: async (raw) => {
        broadcasts++;
        const transaction = Transaction.from(raw);
        assert.equal(transaction.feePayer.toBase58(), treasury.publicKey.toBase58());
        assert.equal(transaction.instructions.length, 2);
        assert.equal(transaction.instructions[0].programId.toBase58(), ASSOCIATED_TOKEN_PROGRAM_ID.toBase58());
        assert.equal(transaction.instructions[0].keys[1].pubkey.toBase58(), claimantAta.toBase58());
        const transfer = decodeTransferCheckedInstruction(transaction.instructions[1], TOKEN_2022_PROGRAM_ID);
        assert.equal(transfer.keys.source.pubkey.toBase58(), treasuryAta.toBase58());
        assert.equal(transfer.keys.mint.pubkey.toBase58(), TEST_USDC_MINT.toBase58());
        assert.equal(transfer.keys.destination.pubkey.toBase58(), claimantAta.toBase58());
        assert.equal(transfer.keys.owner.pubkey.toBase58(), treasury.publicKey.toBase58());
        assert.equal(transfer.data.amount, 25_000_000n);
        assert.equal(transfer.data.decimals, 6);
        return bs58.encode(transaction.signature);
      },
      confirmTransaction: async () => ({ value: { err: null } }),
    };
    const faucet = new DemoFaucet({ connection, officialDevnetConnection: connection, treasury, store });
    faucet.treasuryBalance = async () => 50_000_000n;
    const challenge = await faucet.challenge(claimant.publicKey.toBase58());
    const result = await faucet.claim({
      wallet: claimant.publicKey.toBase58(), nonce: challenge.nonce,
      signature: approve(claimant, challenge.message),
    });
    assert.equal(result.status, "claimed");
    assert.equal(broadcasts, 1);
    assert.equal(store.getClaim(claimant.publicKey.toBase58()).status, "confirmed");
    await assert.rejects(() => faucet.challenge(claimant.publicKey.toBase58()), FaucetError);
  } finally { store.close(); }
});

test("failed onchain payout is not recorded as a successful claim", async () => {
  const store = new ClaimStore(":memory:");
  try {
    const treasury = Keypair.generate();
    const claimant = Keypair.generate();
    const connection = {
      getLatestBlockhash: async () => ({ blockhash: Keypair.generate().publicKey.toBase58(), lastValidBlockHeight: 100 }),
      sendRawTransaction: async (raw) => bs58.encode(Transaction.from(raw).signature),
      confirmTransaction: async () => ({ value: { err: { InstructionError: [1, "Custom"] } } }),
    };
    const faucet = new DemoFaucet({ connection, officialDevnetConnection: connection, treasury, store });
    faucet.treasuryBalance = async () => 50_000_000n;
    const challenge = await faucet.challenge(claimant.publicKey.toBase58());
    await assert.rejects(() => faucet.claim({
      wallet: claimant.publicKey.toBase58(), nonce: challenge.nonce,
      signature: approve(claimant, challenge.message),
    }), FaucetError);
    assert.equal(store.getClaim(claimant.publicKey.toBase58()), null);
    assert.ok((await faucet.challenge(claimant.publicKey.toBase58())).nonce);
  } finally { store.close(); }
});

function solConnection({ solTreasury, claimant, balance = 600_000_000n, confirmError = null } = {}) {
  const blockhash = Keypair.generate().publicKey.toBase58();
  let currentBalance = balance;
  let broadcasts = 0;
  const connection = {
    getLatestBlockhash: async () => ({ blockhash, lastValidBlockHeight: 100 }),
    getBalance: async (address) => address.equals(solTreasury.publicKey) ? Number(currentBalance) : 0,
    sendRawTransaction: async (raw) => {
      broadcasts++;
      const transaction = Transaction.from(raw);
      assert.equal(transaction.feePayer.toBase58(), solTreasury.publicKey.toBase58());
      assert.equal(transaction.instructions.length, 1);
      const transfer = SystemInstruction.decodeTransfer(transaction.instructions[0]);
      assert.equal(transfer.fromPubkey.toBase58(), solTreasury.publicKey.toBase58());
      assert.equal(transfer.toPubkey.toBase58(), claimant.publicKey.toBase58());
      assert.equal(transfer.lamports, BigInt(0.2 * LAMPORTS_PER_SOL));
      currentBalance -= BigInt(transfer.lamports);
      return bs58.encode(transaction.signature);
    },
    confirmTransaction: async () => ({ value: { err: confirmError } }),
  };
  return { connection, get broadcasts() { return broadcasts; }, get balance() { return currentBalance; } };
}

test("claims exactly 0.2 Devnet SOL from a separate treasury and leaves TEST-USDC claims independent", async () => {
  const store = new ClaimStore(":memory:");
  try {
    const treasury = Keypair.generate();
    const solTreasury = Keypair.generate();
    const claimant = Keypair.generate();
    const mock = solConnection({ solTreasury, claimant });
    const faucet = new DemoFaucet({
      connection: mock.connection, officialDevnetConnection: mock.connection, treasury, solTreasury, store,
      solAmountLamports: solToLamports("0.2"), solMinReserveLamports: solToLamports("0.2"),
    });
    faucet.treasuryBalance = async () => 50_000_000n;
    const solChallenge = await faucet.challenge(claimant.publicKey.toBase58(), CLAIM_TYPE_SOL);
    const result = await faucet.claim({
      wallet: claimant.publicKey.toBase58(), nonce: solChallenge.nonce,
      signature: approve(claimant, solChallenge.message), asset: CLAIM_TYPE_SOL,
    });
    assert.equal(result.status, "claimed");
    assert.equal(mock.broadcasts, 1);
    assert.equal(mock.balance, 400_000_000n);
    await assert.rejects(() => faucet.challenge(claimant.publicKey.toBase58(), CLAIM_TYPE_SOL), FaucetError);
    const usdcChallenge = await faucet.challenge(claimant.publicKey.toBase58(), CLAIM_TYPE_USDC);
    assert.ok(usdcChallenge.nonce);
  } finally { store.close(); }
});

test("SOL faucet rejects an under-reserve treasury and bad approvals without consuming a claim", async () => {
  const store = new ClaimStore(":memory:");
  try {
    const treasury = Keypair.generate();
    const solTreasury = Keypair.generate();
    const claimant = Keypair.generate();
    const other = Keypair.generate();
    const mock = solConnection({ solTreasury, claimant, balance: 399_999_999n });
    const faucet = new DemoFaucet({
      connection: mock.connection, officialDevnetConnection: mock.connection, treasury, solTreasury, store,
      solAmountLamports: 200_000_000n, solMinReserveLamports: 200_000_000n,
    });
    await assert.rejects(() => faucet.challenge(claimant.publicKey.toBase58(), CLAIM_TYPE_SOL), FaucetError);
    assert.equal(store.getClaim(claimant.publicKey.toBase58(), CLAIM_TYPE_SOL), null);

    mock.connection.getBalance = async () => 600_000_000;
    const challenge = await faucet.challenge(claimant.publicKey.toBase58(), CLAIM_TYPE_SOL);
    await assert.rejects(() => faucet.claim({
      wallet: claimant.publicKey.toBase58(), nonce: challenge.nonce,
      signature: approve(other, challenge.message), asset: CLAIM_TYPE_SOL,
    }), FaucetError);
    assert.equal(store.getClaim(claimant.publicKey.toBase58(), CLAIM_TYPE_SOL), null);
    await assert.rejects(() => faucet.claim({
      wallet: claimant.publicKey.toBase58(), nonce: "0".repeat(64),
      signature: approve(claimant, challenge.message), asset: CLAIM_TYPE_SOL,
    }), FaucetError);
    assert.equal(store.getClaim(claimant.publicKey.toBase58(), CLAIM_TYPE_SOL), null);
  } finally { store.close(); }
});

test("SOL reserve protection includes the transfer transaction fee", async () => {
  const store = new ClaimStore(":memory:");
  try {
    const treasury = Keypair.generate();
    const solTreasury = Keypair.generate();
    const claimant = Keypair.generate();
    const mock = solConnection({ solTreasury, claimant, balance: 400_000_000n });
    mock.connection.getFeeForMessage = async () => ({ value: 5_000 });
    const faucet = new DemoFaucet({ connection: mock.connection, officialDevnetConnection: mock.connection, treasury, solTreasury, store });
    const challenge = await faucet.challenge(claimant.publicKey.toBase58(), CLAIM_TYPE_SOL);
    await assert.rejects(() => faucet.claim({
      wallet: claimant.publicKey.toBase58(), nonce: challenge.nonce,
      signature: approve(claimant, challenge.message), asset: CLAIM_TYPE_SOL,
    }), FaucetError);
    assert.equal(mock.broadcasts, 0);
    assert.equal(store.getClaim(claimant.publicKey.toBase58(), CLAIM_TYPE_SOL), null);
  } finally { store.close(); }
});

test("failed SOL confirmation releases the claim for a retry", async () => {
  const store = new ClaimStore(":memory:");
  try {
    const treasury = Keypair.generate();
    const solTreasury = Keypair.generate();
    const claimant = Keypair.generate();
    const mock = solConnection({ solTreasury, claimant, confirmError: { InstructionError: [0, "Custom"] } });
    const faucet = new DemoFaucet({ connection: mock.connection, officialDevnetConnection: mock.connection, treasury, solTreasury, store });
    const challenge = await faucet.challenge(claimant.publicKey.toBase58(), CLAIM_TYPE_SOL);
    await assert.rejects(() => faucet.claim({
      wallet: claimant.publicKey.toBase58(), nonce: challenge.nonce,
      signature: approve(claimant, challenge.message), asset: CLAIM_TYPE_SOL,
    }), FaucetError);
    assert.equal(store.getClaim(claimant.publicKey.toBase58(), CLAIM_TYPE_SOL), null);
    assert.ok((await faucet.challenge(claimant.publicKey.toBase58(), CLAIM_TYPE_SOL)).nonce);
  } finally { store.close(); }
});

test("concurrent SOL claims for one wallet result in one payout", async () => {
  const store = new ClaimStore(":memory:");
  try {
    const treasury = Keypair.generate();
    const solTreasury = Keypair.generate();
    const claimant = Keypair.generate();
    const mock = solConnection({ solTreasury, claimant });
    const faucet = new DemoFaucet({ connection: mock.connection, officialDevnetConnection: mock.connection, treasury, solTreasury, store });
    const challenge = await faucet.challenge(claimant.publicKey.toBase58(), CLAIM_TYPE_SOL);
    const request = {
      wallet: claimant.publicKey.toBase58(), nonce: challenge.nonce,
      signature: approve(claimant, challenge.message), asset: CLAIM_TYPE_SOL,
    };
    const results = await Promise.allSettled([faucet.claim(request), faucet.claim(request)]);
    assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
    assert.equal(results.filter((result) => result.status === "rejected").length, 1);
    assert.equal(mock.broadcasts, 1);
    assert.equal(store.getClaim(claimant.publicKey.toBase58(), CLAIM_TYPE_SOL).status, "confirmed");
  } finally { store.close(); }
});
