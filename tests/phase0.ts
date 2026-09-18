import * as anchor from "@coral-xyz/anchor";
import { assert } from "chai";
import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  createAssociatedTokenAccount,
  createMint,
  createTransferInstruction,
  getAccount,
  getAssociatedTokenAddressSync,
  getMint,
  mintTo,
  TOKEN_2022_PROGRAM_ID,
} from "@solana/spl-token";
import {
  Keypair,
  LAMPORTS_PER_SOL,
  PublicKey,
  sendAndConfirmTransaction,
  SystemProgram,
  Transaction,
} from "@solana/web3.js";

describe("StockSplit Phase 0: Token-2022 PDA vault", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);
  // The workspace loader resolves the generated IDL at runtime. Keeping this
  // handle dynamic avoids TypeScript's recursive account-resolver expansion in
  // Anchor 0.32.x while preserving runtime account validation.
  const program = anchor.workspace.StockSplitPhase0 as any;
  const alice = (provider.wallet as anchor.Wallet).payer;
  const bob = Keypair.generate();
  const portfolioId = new anchor.BN(1);
  const portfolioIdBytes = Buffer.alloc(8);
  portfolioIdBytes.writeBigUInt64LE(1n);

  let testUsdcMint: PublicKey;
  let testXStockMint: PublicKey;
  let portfolio: PublicKey;
  let usdcVault: PublicKey;
  let xStockVault: PublicKey;
  let aliceUsdc: PublicKey;
  let bobUsdc: PublicKey;
  let aliceXStock: PublicKey;

  async function fundBob(): Promise<void> {
    const signature = await provider.connection.requestAirdrop(bob.publicKey, 2 * LAMPORTS_PER_SOL);
    await provider.connection.confirmTransaction(signature, "confirmed");
  }

  async function createTestMint(): Promise<PublicKey> {
    return createMint(
      provider.connection,
      alice,
      alice.publicKey,
      null,
      6,
      Keypair.generate(),
      { commitment: "confirmed" },
      TOKEN_2022_PROGRAM_ID,
    );
  }

  async function createWalletTokenAccount(mint: PublicKey, owner: PublicKey): Promise<PublicKey> {
    const address = getAssociatedTokenAddressSync(
      mint,
      owner,
      false,
      TOKEN_2022_PROGRAM_ID,
      ASSOCIATED_TOKEN_PROGRAM_ID,
    );

    const existing = await provider.connection.getAccountInfo(address, "confirmed");
    if (existing === null) {
      await createAssociatedTokenAccount(
        provider.connection,
        alice,
        mint,
        owner,
        { commitment: "confirmed" },
        TOKEN_2022_PROGRAM_ID,
        ASSOCIATED_TOKEN_PROGRAM_ID,
      );
    }

    // Fetch only after the ATA is confirmed to exist, and always decode it as
    // a Token-2022 account rather than falling back to the legacy program.
    await getAccount(provider.connection, address, "confirmed", TOKEN_2022_PROGRAM_ID);
    return address;
  }

  async function balance(account: PublicKey): Promise<bigint> {
    return (await getAccount(provider.connection, account, "confirmed", TOKEN_2022_PROGRAM_ID)).amount;
  }

  async function vaultBalance(vault: PublicKey, mint: PublicKey): Promise<bigint> {
    const account = await getAccount(provider.connection, vault, "confirmed", TOKEN_2022_PROGRAM_ID);
    assert.equal(account.mint.toBase58(), mint.toBase58());
    assert.equal(account.owner.toBase58(), portfolio.toBase58());
    return account.amount;
  }

  async function confirmedRpc(send: () => Promise<string>): Promise<void> {
    const signature = await send();
    await provider.connection.confirmTransaction(signature, "confirmed");
  }

  before(async () => {
    await fundBob();
    testUsdcMint = await createTestMint();
    testXStockMint = await createTestMint();

    const usdcMintInfo = await getMint(provider.connection, testUsdcMint, "confirmed", TOKEN_2022_PROGRAM_ID);
    const xStockMintInfo = await getMint(provider.connection, testXStockMint, "confirmed", TOKEN_2022_PROGRAM_ID);
    assert.equal(usdcMintInfo.decimals, 6);
    assert.equal(xStockMintInfo.decimals, 6);

    aliceUsdc = await createWalletTokenAccount(testUsdcMint, alice.publicKey);
    bobUsdc = await createWalletTokenAccount(testUsdcMint, bob.publicKey);
    aliceXStock = await createWalletTokenAccount(testXStockMint, alice.publicKey);

    await mintTo(
      provider.connection,
      alice,
      testUsdcMint,
      aliceUsdc,
      alice,
      100_000_000n,
      [],
      { commitment: "confirmed" },
      TOKEN_2022_PROGRAM_ID,
    );
    await mintTo(
      provider.connection,
      alice,
      testUsdcMint,
      bobUsdc,
      alice,
      100_000_000n,
      [],
      { commitment: "confirmed" },
      TOKEN_2022_PROGRAM_ID,
    );
    await mintTo(
      provider.connection,
      alice,
      testXStockMint,
      aliceXStock,
      alice,
      50_000_000n,
      [],
      { commitment: "confirmed" },
      TOKEN_2022_PROGRAM_ID,
    );

    [portfolio] = PublicKey.findProgramAddressSync(
      [Buffer.from("portfolio"), alice.publicKey.toBuffer(), portfolioIdBytes],
      program.programId,
    );
    [usdcVault] = PublicKey.findProgramAddressSync(
      [Buffer.from("vault"), portfolio.toBuffer(), testUsdcMint.toBuffer()],
      program.programId,
    );
    [xStockVault] = PublicKey.findProgramAddressSync(
      [Buffer.from("vault"), portfolio.toBuffer(), testXStockMint.toBuffer()],
      program.programId,
    );

    await confirmedRpc(() =>
      program.methods
        .initializePortfolio(portfolioId)
        .accounts({ creator: alice.publicKey, portfolio, systemProgram: SystemProgram.programId })
        .signers([alice])
        .rpc(),
    );

    await confirmedRpc(() =>
      program.methods
        .initializeVault()
        .accounts({
          payer: alice.publicKey,
          portfolio,
          mint: testUsdcMint,
          vault: usdcVault,
          tokenProgram: TOKEN_2022_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
        })
        .signers([alice])
        .rpc(),
    );

    await confirmedRpc(() =>
      program.methods
        .initializeVault()
        .accounts({
          payer: alice.publicKey,
          portfolio,
          mint: testXStockMint,
          vault: xStockVault,
          tokenProgram: TOKEN_2022_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
        })
        .signers([alice])
        .rpc(),
    );
  });

  it("creates Token-2022 mock assets and PDA-controlled vaults", async () => {
    await vaultBalance(usdcVault, testUsdcMint);
    await vaultBalance(xStockVault, testXStockMint);
  });

  it("accepts deposits from two independent wallets", async () => {
    await confirmedRpc(() =>
      program.methods
        .deposit(new anchor.BN(25_000_000))
        .accounts({
          depositor: alice.publicKey,
          portfolio,
          mint: testUsdcMint,
          sourceToken: aliceUsdc,
          vault: usdcVault,
          tokenProgram: TOKEN_2022_PROGRAM_ID,
        })
        .signers([alice])
        .rpc(),
    );

    await confirmedRpc(() =>
      program.methods
        .deposit(new anchor.BN(15_000_000))
        .accounts({
          depositor: bob.publicKey,
          portfolio,
          mint: testUsdcMint,
          sourceToken: bobUsdc,
          vault: usdcVault,
          tokenProgram: TOKEN_2022_PROGRAM_ID,
        })
        .signers([bob])
        .rpc(),
    );

    await confirmedRpc(() =>
      program.methods
        .deposit(new anchor.BN(5_000_000))
        .accounts({
          depositor: alice.publicKey,
          portfolio,
          mint: testXStockMint,
          sourceToken: aliceXStock,
          vault: xStockVault,
          tokenProgram: TOKEN_2022_PROGRAM_ID,
        })
        .signers([alice])
        .rpc(),
    );

    assert.equal((await vaultBalance(usdcVault, testUsdcMint)).toString(), "40000000");
    assert.equal((await vaultBalance(xStockVault, testXStockMint)).toString(), "5000000");
  });

  it("withdraws from the vault only when the creator authorizes the PDA transfer", async () => {
    await confirmedRpc(() =>
      program.methods
        .withdraw(new anchor.BN(10_000_000))
        .accounts({
          creator: alice.publicKey,
          portfolio,
          mint: testUsdcMint,
          vault: usdcVault,
          destinationToken: bobUsdc,
          tokenProgram: TOKEN_2022_PROGRAM_ID,
        })
        .signers([alice])
        .rpc(),
    );

    assert.equal((await vaultBalance(usdcVault, testUsdcMint)).toString(), "30000000");
    assert.equal((await balance(bobUsdc)).toString(), "95000000");
  });

  it("rejects an unauthorized wallet at the program boundary", async () => {
    let failed = false;
    try {
      await program.methods
        .withdraw(new anchor.BN(1))
        .accounts({
          creator: bob.publicKey,
          portfolio,
          mint: testUsdcMint,
          vault: usdcVault,
          destinationToken: bobUsdc,
          tokenProgram: TOKEN_2022_PROGRAM_ID,
        })
        .signers([bob])
        .rpc();
    } catch {
      failed = true;
    }
    assert.isTrue(failed, "Bob must not invoke the creator-only withdrawal path");
  });

  it("rejects direct Token-2022 transfers from the PDA vault by an unauthorized wallet", async () => {
    const transfer = new Transaction().add(
      createTransferInstruction(
        usdcVault,
        bobUsdc,
        bob.publicKey,
        1,
        [],
        TOKEN_2022_PROGRAM_ID,
      ),
    );

    let failed = false;
    try {
      await sendAndConfirmTransaction(provider.connection, transfer, [bob], {
        commitment: "confirmed",
      });
    } catch {
      failed = true;
    }
    assert.isTrue(failed, "A wallet cannot sign for the portfolio PDA token authority");
    assert.equal((await vaultBalance(usdcVault, testUsdcMint)).toString(), "30000000");
  });
});
