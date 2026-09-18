import * as anchor from "@coral-xyz/anchor";
import { assert } from "chai";
import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  createAssociatedTokenAccount,
  createInitializeMintInstruction,
  createInitializeTransferFeeConfigInstruction,
  createMint,
  ExtensionType,
  getAccount,
  getAssociatedTokenAddressSync,
  getMintLen,
  mintTo,
  TOKEN_2022_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import {
  Keypair,
  LAMPORTS_PER_SOL,
  PublicKey,
  sendAndConfirmTransaction,
  SystemProgram,
  Transaction,
} from "@solana/web3.js";

describe("StockSplit Phase 1 security boundaries", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);
  const program = anchor.workspace.StockSplitPhase0 as any;
  const creator = (provider.wallet as anchor.Wallet).payer;

  let usdcMint: PublicKey;
  let validBasketMint: PublicKey;
  let transferFeeMint: PublicKey;
  let legacyBasketMint: PublicKey;
  let nonSixDecimalMint: PublicKey;
  let undeclaredMint: PublicKey;
  let creatorUsdc: PublicKey;

  async function assertRejected(action: () => Promise<unknown>, message: string): Promise<void> {
    let rejected = false;
    try {
      await action();
    } catch {
      rejected = true;
    }
    assert.isTrue(rejected, message);
  }

  function portfolioPda(id: number): PublicKey {
    const idBytes = Buffer.alloc(8);
    idBytes.writeBigUInt64LE(BigInt(id));
    return PublicKey.findProgramAddressSync(
      [Buffer.from("portfolio"), creator.publicKey.toBuffer(), idBytes],
      program.programId,
    )[0];
  }

  function memberPda(portfolio: PublicKey, wallet: PublicKey): PublicKey {
    return PublicKey.findProgramAddressSync(
      [Buffer.from("member"), portfolio.toBuffer(), wallet.toBuffer()],
      program.programId,
    )[0];
  }

  function vaultPda(portfolio: PublicKey, mint: PublicKey): PublicKey {
    return PublicKey.findProgramAddressSync(
      [Buffer.from("vault"), portfolio.toBuffer(), mint.toBuffer()],
      program.programId,
    )[0];
  }

  async function createToken2022Mint(decimals = 6): Promise<PublicKey> {
    return createMint(
      provider.connection,
      creator,
      creator.publicKey,
      null,
      decimals,
      Keypair.generate(),
      { commitment: "confirmed" },
      TOKEN_2022_PROGRAM_ID,
    );
  }

  async function createTokenAccount(mint: PublicKey, owner: PublicKey): Promise<PublicKey> {
    const address = getAssociatedTokenAddressSync(
      mint,
      owner,
      false,
      TOKEN_2022_PROGRAM_ID,
      ASSOCIATED_TOKEN_PROGRAM_ID,
    );
    if ((await provider.connection.getAccountInfo(address, "confirmed")) === null) {
      await createAssociatedTokenAccount(
        provider.connection,
        creator,
        mint,
        owner,
        { commitment: "confirmed" },
        TOKEN_2022_PROGRAM_ID,
        ASSOCIATED_TOKEN_PROGRAM_ID,
      );
    }
    await getAccount(provider.connection, address, "confirmed", TOKEN_2022_PROGRAM_ID);
    return address;
  }

  async function createTransferFeeMint(): Promise<PublicKey> {
    const mint = Keypair.generate();
    const mintSpace = getMintLen([ExtensionType.TransferFeeConfig]);
    const lamports = await provider.connection.getMinimumBalanceForRentExemption(mintSpace);
    const transaction = new Transaction().add(
      SystemProgram.createAccount({
        fromPubkey: creator.publicKey,
        newAccountPubkey: mint.publicKey,
        lamports,
        space: mintSpace,
        programId: TOKEN_2022_PROGRAM_ID,
      }),
      createInitializeTransferFeeConfigInstruction(
        mint.publicKey,
        creator.publicKey,
        creator.publicKey,
        100,
        1_000_000n,
        TOKEN_2022_PROGRAM_ID,
      ),
      createInitializeMintInstruction(
        mint.publicKey,
        6,
        creator.publicKey,
        null,
        TOKEN_2022_PROGRAM_ID,
      ),
    );
    await sendAndConfirmTransaction(provider.connection, transaction, [creator, mint], {
      commitment: "confirmed",
    });
    return mint.publicKey;
  }

  async function createPortfolio(
    id: number,
    basket: { mint: PublicKey; allocationBps: number }[],
    options: {
      usdc?: PublicKey;
      name?: string;
      description?: string;
      fundingStart?: number;
      fundingDeadline?: number;
      target?: bigint;
    } = {},
  ): Promise<PublicKey> {
    const portfolio = portfolioPda(id);
    const now = Math.floor(Date.now() / 1000);
    const usdc = options.usdc ?? usdcMint;
    await program.methods
      .createPortfolio(
        new anchor.BN(id),
        options.name ?? "Security boundary",
        options.description ?? "Phase 1 security tests",
        new anchor.BN((options.fundingStart ?? now - 10).toString()),
        new anchor.BN((options.fundingDeadline ?? now + 3600).toString()),
        new anchor.BN((options.target ?? 2_000_000n).toString()),
        basket,
      )
      .accounts({
        creator: creator.publicKey,
        portfolio,
        usdcMint: usdc,
        tokenProgram: TOKEN_2022_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })
      .remainingAccounts(
        basket.map((asset) => ({
          pubkey: asset.mint,
          isSigner: false,
          isWritable: false,
        })),
      )
      .signers([creator])
      .rpc();
    return portfolio;
  }

  async function prepareFundingPortfolio(
    id: number,
    deadline: number,
    target = 2_000_000n,
  ): Promise<{ portfolio: PublicKey; member: PublicKey; vault: PublicKey }> {
    const portfolio = await createPortfolio(
      id,
      [{ mint: validBasketMint, allocationBps: 10_000 }],
      { fundingDeadline: deadline, target },
    );
    const vault = vaultPda(portfolio, usdcMint);
    await program.methods
      .initializeVault()
      .accounts({
        payer: creator.publicKey,
        portfolio,
        mint: usdcMint,
        vault,
        tokenProgram: TOKEN_2022_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })
      .signers([creator])
      .rpc();

    const member = memberPda(portfolio, creator.publicKey);
    await program.methods
      .inviteMember()
      .accounts({
        creator: creator.publicKey,
        portfolio,
        wallet: creator.publicKey,
        member,
        systemProgram: SystemProgram.programId,
      })
      .signers([creator])
      .rpc();
    await program.methods
      .openFunding()
      .accounts({ creator: creator.publicKey, portfolio })
      .signers([creator])
      .rpc();
    return { portfolio, member, vault };
  }

  async function waitForDeadline(deadline: number): Promise<void> {
    const delayMs = Math.max(0, deadline * 1_000 - Date.now() + 1_500);
    await new Promise((resolve) => setTimeout(resolve, delayMs));
  }

  before(async () => {
    const signature = await provider.connection.requestAirdrop(
      creator.publicKey,
      2 * LAMPORTS_PER_SOL,
    );
    await provider.connection.confirmTransaction(signature, "confirmed");

    usdcMint = await createToken2022Mint(6);
    validBasketMint = await createToken2022Mint(6);
    transferFeeMint = await createTransferFeeMint();
    legacyBasketMint = await createMint(
      provider.connection,
      creator,
      creator.publicKey,
      null,
      6,
      Keypair.generate(),
      { commitment: "confirmed" },
      TOKEN_PROGRAM_ID,
    );
    nonSixDecimalMint = await createToken2022Mint(9);
    undeclaredMint = await createToken2022Mint(6);
    creatorUsdc = await createTokenAccount(usdcMint, creator.publicKey);
    await mintTo(
      provider.connection,
      creator,
      usdcMint,
      creatorUsdc,
      creator,
      10_000_000n,
      [],
      { commitment: "confirmed" },
      TOKEN_2022_PROGRAM_ID,
    );
  });

  it("rejects unsupported Token-2022 transfer-fee basket mints", async () => {
    await assertRejected(
      () =>
        createPortfolio(2101, [
          { mint: transferFeeMint, allocationBps: 10_000 },
        ]),
      "Transfer-fee mints must not be accepted as basket assets",
    );
  });

  it("rejects an invalid or missing basket mint account", async () => {
    const invalidMint = Keypair.generate().publicKey;
    await assertRejected(
      () => createPortfolio(2102, [{ mint: invalidMint, allocationBps: 10_000 }]),
      "A basket entry must resolve to a valid mint account",
    );
  });

  it("rejects legacy-token basket mints", async () => {
    await assertRejected(
      () =>
        createPortfolio(2103, [
          { mint: legacyBasketMint, allocationBps: 10_000 },
        ]),
      "Legacy SPL-token basket mints must be rejected",
    );
  });

  it("accepts validated basket decimals and excludes USDC", async () => {
    const portfolio = await createPortfolio(2109, [
      { mint: nonSixDecimalMint, allocationBps: 10_000 },
    ]);
    const state = await program.account.portfolio.fetch(portfolio);
    assert.equal(state.basket.length, 1);
    assert.equal(state.basket[0].mint.toBase58(), nonSixDecimalMint.toBase58());
    await assertRejected(
      () =>
        createPortfolio(2110, [{ mint: usdcMint, allocationBps: 10_000 }]),
      "The configured USDC mint must not also be a basket asset",
    );
  });

  it("accepts the maximum declared basket and metadata sizes", async () => {
    const basket: { mint: PublicKey; allocationBps: number }[] = [];
    for (let index = 0; index < 8; index += 1) {
      basket.push({ mint: await createToken2022Mint(6), allocationBps: 1_250 });
    }
    const portfolio = await createPortfolio(2104, basket, {
      name: "N".repeat(64),
      description: "D".repeat(256),
    });
    const state = await program.account.portfolio.fetch(portfolio);
    assert.equal(state.basket.length, 8);
    assert.equal(state.name.length, 64);
    assert.equal(state.description.length, 256);
  });

  it("allows vault initialization only for configured portfolio mints", async () => {
    const portfolio = await createPortfolio(2105, [
      { mint: validBasketMint, allocationBps: 10_000 },
    ]);
    await assertRejected(
      () =>
        program.methods
          .initializeVault()
          .accounts({
            payer: creator.publicKey,
            portfolio,
            mint: undeclaredMint,
            vault: vaultPda(portfolio, undeclaredMint),
            tokenProgram: TOKEN_2022_PROGRAM_ID,
            systemProgram: SystemProgram.programId,
          })
          .signers([creator])
          .rpc(),
      "An undeclared Token-2022 mint must not receive a portfolio vault",
    );
  });

  it("rejects zero-funded close after the funding deadline", async () => {
    const deadline = Math.floor(Date.now() / 1000) + 5;
    const { portfolio } = await prepareFundingPortfolio(2106, deadline);
    await waitForDeadline(deadline);
    await assertRejected(
      () =>
        program.methods
          .closeFunding()
          .accounts({ creator: creator.publicKey, portfolio })
          .signers([creator])
          .rpc(),
      "A zero-funded portfolio must not enter FUNDING_CLOSED",
    );
  });

  it("allows a partial close after the deadline when units are nonzero", async () => {
    const deadline = Math.floor(Date.now() / 1000) + 5;
    const { portfolio, member, vault } = await prepareFundingPortfolio(2107, deadline);
    await program.methods
      .contribute(new anchor.BN("1000000"))
      .accounts({
        contributor: creator.publicKey,
        portfolio,
        member,
        mint: usdcMint,
        sourceToken: creatorUsdc,
        vault,
        tokenProgram: TOKEN_2022_PROGRAM_ID,
      })
      .signers([creator])
      .rpc();
    await waitForDeadline(deadline);
    await program.methods
      .closeFunding()
      .accounts({ creator: creator.publicKey, portfolio })
      .signers([creator])
      .rpc();
    const state = await program.account.portfolio.fetch(portfolio);
    assert.equal(state.status, 2);
    assert.equal(state.totalUnits.toString(), "1000000");
    assert.equal(
      (await getAccount(provider.connection, vault, "confirmed", TOKEN_2022_PROGRAM_ID)).amount.toString(),
      "1000000",
    );
  });

  it("rejects creation when the funding window has already expired", async () => {
    const now = Math.floor(Date.now() / 1000);
    await assertRejected(
      () =>
        createPortfolio(2108, [{ mint: validBasketMint, allocationBps: 10_000 }], {
          fundingStart: now - 20,
          fundingDeadline: now - 1,
        }),
      "A portfolio must not be created with an expired funding deadline",
    );
  });
});
