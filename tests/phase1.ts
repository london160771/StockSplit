import * as anchor from "@coral-xyz/anchor";
import { assert } from "chai";
import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  createAssociatedTokenAccount,
  createMint,
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
  SystemProgram,
} from "@solana/web3.js";
import { waitForConfirmedState } from "./helpers/confirmed-state";

describe("StockSplit Phase 1: portfolio and funding", () => {
  type FundingClosedState = {
    status: number;
    ownershipLocked: boolean;
    fundingClosedAt: anchor.BN;
  };

  const envProvider = anchor.AnchorProvider.env();
  const provider = new anchor.AnchorProvider(
    envProvider.connection,
    envProvider.wallet,
    { commitment: "confirmed", preflightCommitment: "confirmed" },
  );
  anchor.setProvider(provider);
  const program = anchor.workspace.StockSplitPhase0 as any;
  const alice = (provider.wallet as anchor.Wallet).payer;
  const bob = Keypair.generate();
  const carol = Keypair.generate();
  const portfolioId = new anchor.BN(1001);
  const portfolioIdBytes = Buffer.alloc(8);
  portfolioIdBytes.writeBigUInt64LE(1001n);

  const STATUS_DRAFT = 0;
  const STATUS_FUNDING = 1;
  const STATUS_FUNDING_CLOSED = 2;
  const CONTRIBUTION_ALICE = 25_000_000n;
  const CONTRIBUTION_BOB = 15_000_000n;
  const TARGET = CONTRIBUTION_ALICE + CONTRIBUTION_BOB;

  let testUsdcMint: PublicKey;
  let testXStockMint: PublicKey;
  let portfolio: PublicKey;
  let usdcVault: PublicKey;
  let aliceUsdc: PublicKey;
  let bobUsdc: PublicKey;
  let carolUsdc: PublicKey;
  let aliceMember: PublicKey;
  let bobMember: PublicKey;
  let carolMember: PublicKey;

  async function fundWallet(wallet: PublicKey): Promise<void> {
    const signature = await provider.connection.requestAirdrop(wallet, 2 * LAMPORTS_PER_SOL);
    await provider.connection.confirmTransaction(signature, "confirmed");
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
        alice,
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

  function memberPda(wallet: PublicKey): PublicKey {
    return PublicKey.findProgramAddressSync(
      [Buffer.from("member"), portfolio.toBuffer(), wallet.toBuffer()],
      program.programId,
    )[0];
  }

  async function assertRejected(action: () => Promise<unknown>, message: string): Promise<void> {
    let rejected = false;
    try {
      await action();
    } catch {
      rejected = true;
    }
    assert.isTrue(rejected, message);
  }

  async function contribute(
    contributor: Keypair,
    member: PublicKey,
    sourceToken: PublicKey,
    amount: bigint,
  ): Promise<string> {
    return program.methods
      .contribute(new anchor.BN(amount.toString()))
      .accounts({
        contributor: contributor.publicKey,
        portfolio,
        member,
        mint: testUsdcMint,
        sourceToken,
        vault: usdcVault,
        tokenProgram: TOKEN_2022_PROGRAM_ID,
      })
      .signers([contributor])
      .rpc();
  }

  async function legacyWithdraw(amount: bigint = 1n): Promise<void> {
    await program.methods
      .withdraw(new anchor.BN(amount.toString()))
      .accounts({
        creator: alice.publicKey,
        portfolio,
        mint: testUsdcMint,
        vault: usdcVault,
        destinationToken: aliceUsdc,
        tokenProgram: TOKEN_2022_PROGRAM_ID,
      })
      .signers([alice])
      .rpc();
  }

  async function legacyDeposit(amount: bigint = 1n): Promise<void> {
    await program.methods
      .deposit(new anchor.BN(amount.toString()))
      .accounts({
        depositor: alice.publicKey,
        portfolio,
        mint: testUsdcMint,
        sourceToken: aliceUsdc,
        vault: usdcVault,
        tokenProgram: TOKEN_2022_PROGRAM_ID,
      })
      .signers([alice])
      .rpc();
  }

  before(async () => {
    await Promise.all([fundWallet(bob.publicKey), fundWallet(carol.publicKey)]);

    testUsdcMint = await createMint(
      provider.connection,
      alice,
      alice.publicKey,
      null,
      6,
      Keypair.generate(),
      { commitment: "confirmed" },
      TOKEN_2022_PROGRAM_ID,
    );
    testXStockMint = await createMint(
      provider.connection,
      alice,
      alice.publicKey,
      null,
      6,
      Keypair.generate(),
      { commitment: "confirmed" },
      TOKEN_2022_PROGRAM_ID,
    );

    assert.equal(
      (await getMint(provider.connection, testUsdcMint, "confirmed", TOKEN_2022_PROGRAM_ID)).decimals,
      6,
    );
    assert.equal(
      (await getMint(provider.connection, testXStockMint, "confirmed", TOKEN_2022_PROGRAM_ID)).decimals,
      6,
    );

    aliceUsdc = await createTokenAccount(testUsdcMint, alice.publicKey);
    bobUsdc = await createTokenAccount(testUsdcMint, bob.publicKey);
    carolUsdc = await createTokenAccount(testUsdcMint, carol.publicKey);

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
      testUsdcMint,
      carolUsdc,
      alice,
      100_000_000n,
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

    const now = Math.floor(Date.now() / 1000);
    await program.methods
      .createPortfolio(
        portfolioId,
        "Phase 1 Circle",
        "Invite-only funding mechanics",
        new anchor.BN(now - 60),
        new anchor.BN(now + 3600),
        new anchor.BN(TARGET.toString()),
        [{ mint: testXStockMint, allocationBps: 10_000 }],
      )
      .accounts({
        creator: alice.publicKey,
        portfolio,
        usdcMint: testUsdcMint,
        tokenProgram: TOKEN_2022_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })
      .remainingAccounts([
        { pubkey: testXStockMint, isSigner: false, isWritable: false },
      ])
      .signers([alice])
      .rpc();

    await program.methods
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
      .rpc();

    aliceMember = memberPda(alice.publicKey);
    bobMember = memberPda(bob.publicKey);
    carolMember = memberPda(carol.publicKey);

    for (const [wallet, member] of [
      [alice.publicKey, aliceMember],
      [bob.publicKey, bobMember],
    ] as [PublicKey, PublicKey][]) {
      await program.methods
        .inviteMember()
        .accounts({
          creator: alice.publicKey,
          portfolio,
          wallet,
          member,
          systemProgram: SystemProgram.programId,
        })
        .signers([alice])
        .rpc();
    }
  });

  it("creates the portfolio with fixed metadata, basket, target, and funding window", async () => {
    const state = await program.account.portfolio.fetch(portfolio);
    assert.equal(state.creator.toBase58(), alice.publicKey.toBase58());
    assert.equal(state.status, STATUS_DRAFT);
    assert.equal(state.targetUsdc.toString(), TARGET.toString());
    assert.equal(state.totalUnits.toString(), "0");
    assert.equal(state.totalContributed.toString(), "0");
    assert.isTrue(state.basketLocked);
    assert.equal(state.basket.length, 1);
    assert.equal(state.basket[0].mint.toBase58(), testXStockMint.toBase58());
    assert.equal(state.basket[0].allocationBps, 10_000);

    await assertRejected(
      () => legacyWithdraw(),
      "The legacy creator withdrawal path must reject a Phase 1 DRAFT portfolio",
    );
    await assertRejected(
      () => legacyDeposit(),
      "The legacy deposit path must reject a Phase 1 portfolio",
    );
    await assertRejected(
      () =>
        program.methods
          .initializePortfolio(portfolioId)
          .accounts({
            creator: alice.publicKey,
            portfolio,
            systemProgram: SystemProgram.programId,
          })
          .signers([alice])
          .rpc(),
      "The Phase 0 initializer must not reinitialize a Phase 1 portfolio PDA",
    );
  });

  it("records invited members before funding begins", async () => {
    const aliceState = await program.account.member.fetch(aliceMember);
    const bobState = await program.account.member.fetch(bobMember);
    assert.equal(aliceState.wallet.toBase58(), alice.publicKey.toBase58());
    assert.equal(bobState.wallet.toBase58(), bob.publicKey.toBase58());
    assert.equal(aliceState.ownershipUnits.toString(), "0");
    assert.equal(bobState.ownershipUnits.toString(), "0");
  });

  it("rejects a contribution before funding is opened", async () => {
    await assertRejected(
      () => contribute(alice, aliceMember, aliceUsdc, 1_000_000n),
      "A DRAFT portfolio must reject contributions",
    );
  });

  it("rejects unauthorized invite and open attempts", async () => {
    await assertRejected(
      () =>
        program.methods
          .inviteMember()
          .accounts({
            creator: bob.publicKey,
            portfolio,
            wallet: carol.publicKey,
            member: carolMember,
            systemProgram: SystemProgram.programId,
          })
          .signers([bob])
          .rpc(),
      "Only the portfolio creator may invite members",
    );

    await assertRejected(
      () =>
        program.methods
          .openFunding()
          .accounts({ creator: bob.publicKey, portfolio })
          .signers([bob])
          .rpc(),
      "Only the portfolio creator may open funding",
    );
  });

  it("opens funding and records two members' exact contribution units", async () => {
    await program.methods
      .openFunding()
      .accounts({ creator: alice.publicKey, portfolio })
      .signers([alice])
      .rpc();

    await assertRejected(
      () =>
        program.methods
          .closeFunding()
          .accounts({ creator: alice.publicKey, portfolio })
          .signers([alice])
          .rpc(),
      "Funding cannot close before the target or deadline",
    );

    await contribute(alice, aliceMember, aliceUsdc, CONTRIBUTION_ALICE);
    const bobContributionSignature = await contribute(
      bob,
      bobMember,
      bobUsdc,
      CONTRIBUTION_BOB,
    );

    await assertRejected(
      () => contribute(alice, aliceMember, aliceUsdc, 1n),
      "A contribution above the explicit target cap must be rejected",
    );

    await assertRejected(
      () => legacyWithdraw(),
      "The legacy creator withdrawal path must reject a Phase 1 FUNDING portfolio",
    );

    const contributionState = await waitForConfirmedState(
      provider.connection,
      bobContributionSignature,
      async () => {
        const [portfolioState, aliceState, bobState, vaultState] = await Promise.all([
          program.account.portfolio.fetch(portfolio, "confirmed"),
          program.account.member.fetch(aliceMember, "confirmed"),
          program.account.member.fetch(bobMember, "confirmed"),
          getAccount(provider.connection, usdcVault, "confirmed", TOKEN_2022_PROGRAM_ID),
        ]);
        return { portfolioState, aliceState, bobState, vaultState };
      },
      (state) =>
        state.portfolioState.status === STATUS_FUNDING &&
        state.portfolioState.totalContributed.toString() === TARGET.toString() &&
        state.portfolioState.totalUnits.toString() === TARGET.toString() &&
        state.aliceState.totalContributed.toString() === CONTRIBUTION_ALICE.toString() &&
        state.aliceState.ownershipUnits.toString() === CONTRIBUTION_ALICE.toString() &&
        state.bobState.totalContributed.toString() === CONTRIBUTION_BOB.toString() &&
        state.bobState.ownershipUnits.toString() === CONTRIBUTION_BOB.toString() &&
        state.vaultState.amount.toString() === TARGET.toString(),
      "Phase 1 contribution state",
      {
        describe: (state) =>
          state
            ? `totalContributed=${state.portfolioState.totalContributed.toString()}, totalUnits=${state.portfolioState.totalUnits.toString()}, alice=${state.aliceState.totalContributed.toString()}, bob=${state.bobState.totalContributed.toString()}, vault=${state.vaultState.amount.toString()}`
            : "no snapshot",
      },
    );

    const { portfolioState, aliceState, bobState, vaultState } = contributionState;
    assert.equal(portfolioState.status, STATUS_FUNDING);
    assert.equal(portfolioState.totalContributed.toString(), TARGET.toString());
    assert.equal(portfolioState.totalUnits.toString(), TARGET.toString());
    assert.equal(aliceState.totalContributed.toString(), CONTRIBUTION_ALICE.toString());
    assert.equal(aliceState.ownershipUnits.toString(), CONTRIBUTION_ALICE.toString());
    assert.equal(bobState.totalContributed.toString(), CONTRIBUTION_BOB.toString());
    assert.equal(bobState.ownershipUnits.toString(), CONTRIBUTION_BOB.toString());
    assert.equal(
      vaultState.amount.toString(),
      TARGET.toString(),
    );
  });

  it("rejects an unauthorized wallet even when it has funded test USDC", async () => {
    await assertRejected(
      () => contribute(carol, carolMember, carolUsdc, 1_000_000n),
      "A wallet without a member PDA must not contribute",
    );
  });

  it("closes funding, locks units, and rejects late contributions", async () => {
    await assertRejected(
      () =>
        program.methods
          .closeFunding()
          .accounts({ creator: bob.publicKey, portfolio })
          .signers([bob])
          .rpc(),
      "Only the portfolio creator may close funding",
    );

    const closeFundingSignature = await program.methods
      .closeFunding()
      .accounts({ creator: alice.publicKey, portfolio })
      .signers([alice])
      .rpc();

    const state = await waitForConfirmedState<FundingClosedState>(
      provider.connection,
      closeFundingSignature,
      () =>
        program.account.portfolio.fetch(
          portfolio,
          "confirmed",
        ) as Promise<FundingClosedState>,
      (value) => value.status === STATUS_FUNDING_CLOSED && value.ownershipLocked,
      "Phase 1 funding close state",
    );
    assert.equal(state.status, STATUS_FUNDING_CLOSED);
    assert.isTrue(state.ownershipLocked);
    assert.isAbove(state.fundingClosedAt.toNumber(), 0);

    await assertRejected(
      () => legacyWithdraw(),
      "The legacy creator withdrawal path must reject a Phase 1 FUNDING_CLOSED portfolio",
    );

    await assertRejected(
      () => contribute(bob, bobMember, bobUsdc, 1n),
      "A FUNDING_CLOSED portfolio must reject contributions",
    );
    assert.equal(
      (await getAccount(provider.connection, usdcVault, "confirmed", TOKEN_2022_PROGRAM_ID)).amount.toString(),
      TARGET.toString(),
    );
  });
});
