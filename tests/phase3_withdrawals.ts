import * as anchor from "@coral-xyz/anchor";
import { assert } from "chai";
import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  createAccount,
  createAssociatedTokenAccount,
  createFreezeAccountInstruction,
  createMint,
  getAccount,
  getAssociatedTokenAddressSync,
  getMint,
  mintTo,
  TOKEN_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
} from "@solana/spl-token";
import {
  Keypair,
  PublicKey,
  sendAndConfirmTransaction,
  SystemProgram,
  Transaction,
} from "@solana/web3.js";
import { waitForConfirmedState } from "./helpers/confirmed-state";

describe("StockSplit Phase 3: proportional in-kind withdrawals", () => {
  const envProvider = anchor.AnchorProvider.env();
  const provider = new anchor.AnchorProvider(
    envProvider.connection,
    envProvider.wallet,
    { commitment: "confirmed", preflightCommitment: "confirmed" },
  );
  anchor.setProvider(provider);
  const program = anchor.workspace.StockSplitPhase0 as any;
  const creator = (provider.wallet as anchor.Wallet).payer;
  const jupiterProgram = new PublicKey(
    "JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4",
  );
  const eventAuthority = new PublicKey(
    "D8cy77BBepLMngZx6ZukaTff5hCt1HrWyKk3Hnd9oitf",
  );
  const routeDiscriminator = Buffer.from([187, 100, 250, 204, 49, 196, 175, 20]);
  const ALICE_UNITS = 4_000_000n;
  const BOB_UNITS = 6_000_000n;
  const TOTAL_UNITS = ALICE_UNITS + BOB_UNITS;
  const RESIDUAL_USDC = 7n;
  const DEPLOYED_ASSET = 1_000_003n;

  type Scenario = {
    portfolio: PublicKey;
    usdcMint: PublicKey;
    assetMint: PublicKey;
    usdcVault: PublicKey;
    assetVault: PublicKey;
    liquidityVault: PublicKey;
    inputSink: PublicKey;
    alice: Keypair;
    bob: Keypair;
    carol: Keypair;
    aliceMember: PublicKey;
    bobMember: PublicKey;
    aliceUsdc: PublicKey;
    bobUsdc: PublicKey;
    aliceAsset: PublicKey;
    bobAsset: PublicKey;
  };

  function pda(seed: string, ...keys: PublicKey[]): PublicKey {
    return PublicKey.findProgramAddressSync(
      [Buffer.from(seed), ...keys.map((key) => key.toBuffer())],
      program.programId,
    )[0];
  }

  function routeData(inputAmount: bigint, outputAmount: bigint): Buffer {
    const data = Buffer.alloc(41);
    routeDiscriminator.copy(data, 0);
    data.writeBigUInt64LE(inputAmount, 8);
    data.writeBigUInt64LE(outputAmount, 16);
    data.writeUInt16LE(0, 24);
    data.writeUInt16LE(0, 26);
    data.writeUInt16LE(0, 28);
    data.writeUInt32LE(1, 30);
    data[34] = 0x2f;
    data[35] = 0;
    data[36] = 0;
    data.writeUInt16LE(10_000, 37);
    data[39] = 0;
    data[40] = 1;
    return data;
  }

  function routeAccounts(s: Scenario) {
    return [
      { pubkey: s.portfolio, isSigner: false, isWritable: false },
      { pubkey: s.usdcVault, isSigner: false, isWritable: true },
      { pubkey: s.assetVault, isSigner: false, isWritable: true },
      { pubkey: s.usdcMint, isSigner: false, isWritable: false },
      { pubkey: s.assetMint, isSigner: false, isWritable: false },
      { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: TOKEN_2022_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: jupiterProgram, isSigner: false, isWritable: false },
      { pubkey: eventAuthority, isSigner: false, isWritable: false },
      { pubkey: jupiterProgram, isSigner: false, isWritable: false },
      { pubkey: s.portfolio, isSigner: false, isWritable: true },
      { pubkey: s.usdcVault, isSigner: false, isWritable: false },
      { pubkey: s.assetVault, isSigner: false, isWritable: false },
      { pubkey: s.liquidityVault, isSigner: false, isWritable: true },
      { pubkey: s.inputSink, isSigner: false, isWritable: true },
    ];
  }

  function memberPda(s: Scenario, wallet: PublicKey): PublicKey {
    return pda("member", s.portfolio, wallet);
  }

  function withdrawalAccounts(s: Scenario, wallet: Keypair) {
    const isAlice = wallet.publicKey.equals(s.alice.publicKey);
    return [
      { pubkey: s.usdcVault, isSigner: false, isWritable: true },
      { pubkey: isAlice ? s.aliceUsdc : s.bobUsdc, isSigner: false, isWritable: true },
      { pubkey: s.usdcMint, isSigner: false, isWritable: false },
      { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: s.assetVault, isSigner: false, isWritable: true },
      { pubkey: isAlice ? s.aliceAsset : s.bobAsset, isSigner: false, isWritable: true },
      { pubkey: s.assetMint, isSigner: false, isWritable: false },
      { pubkey: TOKEN_2022_PROGRAM_ID, isSigner: false, isWritable: false },
    ];
  }

  async function fundWallet(wallet: PublicKey): Promise<void> {
    const signature = await provider.connection.requestAirdrop(wallet, 2 * anchor.web3.LAMPORTS_PER_SOL);
    await provider.connection.confirmTransaction(signature, "confirmed");
  }

  async function ensureAta(
    mint: PublicKey,
    owner: PublicKey,
    tokenProgram: PublicKey,
  ): Promise<PublicKey> {
    const address = getAssociatedTokenAddressSync(
      mint,
      owner,
      false,
      tokenProgram,
      ASSOCIATED_TOKEN_PROGRAM_ID,
    );
    if (!(await provider.connection.getAccountInfo(address, "confirmed"))) {
      await createAssociatedTokenAccount(
        provider.connection,
        creator,
        mint,
        owner,
        { commitment: "confirmed" },
        tokenProgram,
        ASSOCIATED_TOKEN_PROGRAM_ID,
      );
    }
    await getAccount(provider.connection, address, "confirmed", tokenProgram);
    return address;
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

  async function setupScenario(id: number, activate = true): Promise<Scenario> {
    const alice = creator;
    const bob = Keypair.generate();
    const carol = Keypair.generate();
    await fundWallet(bob.publicKey);
    await fundWallet(carol.publicKey);

    const usdcMint = await createMint(
      provider.connection,
      creator,
      creator.publicKey,
      creator.publicKey,
      6,
      Keypair.generate(),
      { commitment: "confirmed" },
      TOKEN_PROGRAM_ID,
    );
    const assetMint = await createMint(
      provider.connection,
      creator,
      creator.publicKey,
      creator.publicKey,
      6,
      Keypair.generate(),
      { commitment: "confirmed" },
      TOKEN_2022_PROGRAM_ID,
    );
    const idBytes = Buffer.alloc(8);
    idBytes.writeBigUInt64LE(BigInt(id));
    const portfolio = PublicKey.findProgramAddressSync(
      [Buffer.from("portfolio"), creator.publicKey.toBuffer(), idBytes],
      program.programId,
    )[0];
    const usdcVault = pda("vault", portfolio, usdcMint);
    const assetVault = pda("vault", portfolio, assetMint);
    const liquidityVault = await createAccount(
      provider.connection,
      creator,
      assetMint,
      portfolio,
      Keypair.generate(),
      { commitment: "confirmed" },
      TOKEN_2022_PROGRAM_ID,
    );
    const inputSink = await createAccount(
      provider.connection,
      creator,
      usdcMint,
      portfolio,
      Keypair.generate(),
      { commitment: "confirmed" },
      TOKEN_PROGRAM_ID,
    );
    const aliceUsdc = await ensureAta(usdcMint, alice.publicKey, TOKEN_PROGRAM_ID);
    const bobUsdc = await ensureAta(usdcMint, bob.publicKey, TOKEN_PROGRAM_ID);
    const aliceAsset = await ensureAta(assetMint, alice.publicKey, TOKEN_2022_PROGRAM_ID);
    const bobAsset = await ensureAta(assetMint, bob.publicKey, TOKEN_2022_PROGRAM_ID);
    const aliceMember = pda("member", portfolio, alice.publicKey);
    const bobMember = pda("member", portfolio, bob.publicKey);
    const now = Math.floor(Date.now() / 1000);

    await program.methods
      .createPortfolio(
        new anchor.BN(id),
        "Phase 3 withdrawals",
        "Raw proportional exit proof",
        new anchor.BN(now - 10),
        new anchor.BN(now + 3_600),
        new anchor.BN(TOTAL_UNITS.toString()),
        [{ mint: assetMint, allocationBps: 10_000 }],
      )
      .accounts({
        creator: creator.publicKey,
        portfolio,
        usdcMint,
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })
      .remainingAccounts([{ pubkey: assetMint, isSigner: false, isWritable: false }])
      .signers([creator])
      .rpc();

    for (const [mint, vault, tokenProgram] of [
      [usdcMint, usdcVault, TOKEN_PROGRAM_ID],
      [assetMint, assetVault, TOKEN_2022_PROGRAM_ID],
    ] as [PublicKey, PublicKey, PublicKey][]) {
      await program.methods
        .initializeVault()
        .accounts({
          payer: creator.publicKey,
          portfolio,
          mint,
          vault,
          tokenProgram,
          systemProgram: SystemProgram.programId,
        })
        .signers([creator])
        .rpc();
    }

    for (const [wallet, member] of [
      [alice.publicKey, aliceMember],
      [bob.publicKey, bobMember],
    ] as [PublicKey, PublicKey][]) {
      await program.methods
        .inviteMember()
        .accounts({
          creator: creator.publicKey,
          portfolio,
          wallet,
          member,
          systemProgram: SystemProgram.programId,
        })
        .signers([creator])
        .rpc();
    }

    await program.methods
      .openFunding()
      .accounts({ creator: creator.publicKey, portfolio })
      .signers([creator])
      .rpc();

    await mintTo(
      provider.connection,
      creator,
      usdcMint,
      aliceUsdc,
      creator,
      ALICE_UNITS,
      [],
      { commitment: "confirmed" },
      TOKEN_PROGRAM_ID,
    );
    await mintTo(
      provider.connection,
      creator,
      usdcMint,
      bobUsdc,
      creator,
      BOB_UNITS,
      [],
      { commitment: "confirmed" },
      TOKEN_PROGRAM_ID,
    );
    await mintTo(
      provider.connection,
      creator,
      assetMint,
      liquidityVault,
      creator,
      DEPLOYED_ASSET,
      [],
      { commitment: "confirmed" },
      TOKEN_2022_PROGRAM_ID,
    );

    await program.methods
      .contribute(new anchor.BN(ALICE_UNITS.toString()))
      .accounts({
        contributor: alice.publicKey,
        portfolio,
        member: aliceMember,
        mint: usdcMint,
        sourceToken: aliceUsdc,
        vault: usdcVault,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .signers([alice])
      .rpc();
    await program.methods
      .contribute(new anchor.BN(BOB_UNITS.toString()))
      .accounts({
        contributor: bob.publicKey,
        portfolio,
        member: bobMember,
        mint: usdcMint,
        sourceToken: bobUsdc,
        vault: usdcVault,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .signers([bob])
      .rpc();
    await program.methods
      .closeFunding()
      .accounts({ creator: creator.publicKey, portfolio })
      .signers([creator])
      .rpc();

    const scenario: Scenario = {
      portfolio,
      usdcMint,
      assetMint,
      usdcVault,
      assetVault,
      liquidityVault,
      inputSink,
      alice,
      bob,
      carol,
      aliceMember,
      bobMember,
      aliceUsdc,
      bobUsdc,
      aliceAsset,
      bobAsset,
    };

    if (activate) {
      await program.methods
        .deployLeg(
          0,
          new anchor.BN(TOTAL_UNITS.toString()),
          new anchor.BN(DEPLOYED_ASSET.toString()),
          new anchor.BN(DEPLOYED_ASSET.toString()),
          0,
          routeData(TOTAL_UNITS, DEPLOYED_ASSET),
        )
        .accounts({
          caller: creator.publicKey,
          portfolio,
          inputMint: usdcMint,
          usdcVault,
          outputMint: assetMint,
          outputVault: assetVault,
          tokenProgram: TOKEN_PROGRAM_ID,
          outputTokenProgram: TOKEN_2022_PROGRAM_ID,
          jupiterProgram,
        })
        .remainingAccounts(routeAccounts(scenario))
        .signers([creator])
        .rpc();

      // This is unsolicited residual USDC. Withdrawal must include its
      // current raw balance proportionally, despite it not being deployment
      // accounting or a deployment-leg output.
      await mintTo(
        provider.connection,
        creator,
        usdcMint,
        usdcVault,
        creator,
        RESIDUAL_USDC,
        [],
        { commitment: "confirmed" },
        TOKEN_PROGRAM_ID,
      );
    }

    return scenario;
  }

  async function withdraw(s: Scenario, wallet: Keypair, accounts = withdrawalAccounts(s, wallet)) {
    return program.methods
      .withdrawMember()
      .accounts({
        memberWallet: wallet.publicKey,
        portfolio: s.portfolio,
        member: memberPda(s, wallet.publicKey),
      })
      .remainingAccounts(accounts)
      .signers([wallet])
      .rpc();
  }

  it("distributes current raw balances proportionally and closes after the final member", async () => {
    const s = await setupScenario(5101);

    const aliceWithdrawalSignature = await withdraw(s, s.alice);
    const aliceWithdrawalState = await waitForConfirmedState(
      provider.connection,
      aliceWithdrawalSignature,
      async () => {
        const [aliceUsdc, aliceAsset, afterAliceUsdc, afterAliceAsset, afterAlicePortfolio] =
          await Promise.all([
            getAccount(provider.connection, s.aliceUsdc, "confirmed", TOKEN_PROGRAM_ID),
            getAccount(provider.connection, s.aliceAsset, "confirmed", TOKEN_2022_PROGRAM_ID),
            getAccount(provider.connection, s.usdcVault, "confirmed", TOKEN_PROGRAM_ID),
            getAccount(provider.connection, s.assetVault, "confirmed", TOKEN_2022_PROGRAM_ID),
            program.account.portfolio.fetch(s.portfolio, "confirmed"),
          ]);
        return { aliceUsdc, aliceAsset, afterAliceUsdc, afterAliceAsset, afterAlicePortfolio };
      },
      (state) =>
        state.aliceUsdc.amount.toString() === "2" &&
        state.aliceAsset.amount.toString() === "400001" &&
        state.afterAliceUsdc.amount.toString() === "5" &&
        state.afterAliceAsset.amount.toString() === "600002" &&
        state.afterAlicePortfolio.totalUnits.toString() === BOB_UNITS.toString() &&
        state.afterAlicePortfolio.status === 4,
      "Phase 3 first member withdrawal state",
      {
        describe: (state) =>
          state
            ? `aliceUsdc=${state.aliceUsdc.amount.toString()}, aliceAsset=${state.aliceAsset.amount.toString()}, usdcVault=${state.afterAliceUsdc.amount.toString()}, assetVault=${state.afterAliceAsset.amount.toString()}, totalUnits=${state.afterAlicePortfolio.totalUnits.toString()}, status=${state.afterAlicePortfolio.status}`
            : "no snapshot",
      },
    );
    const {
      aliceUsdc,
      aliceAsset,
      afterAliceUsdc,
      afterAliceAsset,
      afterAlicePortfolio,
    } = aliceWithdrawalState;
    assert.equal(aliceUsdc.amount.toString(), "2");
    assert.equal(aliceAsset.amount.toString(), "400001");
    assert.equal(afterAliceUsdc.amount.toString(), "5");
    assert.equal(afterAliceAsset.amount.toString(), "600002");
    assert.equal(afterAlicePortfolio.totalUnits.toString(), BOB_UNITS.toString());
    assert.equal(afterAlicePortfolio.status, 4);

    const aliceState = await program.account.member.fetch(s.aliceMember, "confirmed");
    assert.equal(aliceState.ownershipUnits.toString(), "0");
    assert.equal(aliceState.withdrawalStatus, 1);
    await assertRejected(
      () => withdraw(s, s.alice),
      "A member cannot withdraw twice",
    );

    const bobWithdrawalSignature = await withdraw(s, s.bob);
    const bobWithdrawalState = await waitForConfirmedState(
      provider.connection,
      bobWithdrawalSignature,
      async () => {
        const [bobUsdc, bobAsset, finalUsdc, finalAsset, finalPortfolio] = await Promise.all([
          getAccount(provider.connection, s.bobUsdc, "confirmed", TOKEN_PROGRAM_ID),
          getAccount(provider.connection, s.bobAsset, "confirmed", TOKEN_2022_PROGRAM_ID),
          getAccount(provider.connection, s.usdcVault, "confirmed", TOKEN_PROGRAM_ID),
          getAccount(provider.connection, s.assetVault, "confirmed", TOKEN_2022_PROGRAM_ID),
          program.account.portfolio.fetch(s.portfolio, "confirmed"),
        ]);
        return { bobUsdc, bobAsset, finalUsdc, finalAsset, finalPortfolio };
      },
      (state) =>
        state.bobUsdc.amount.toString() === "5" &&
        state.bobAsset.amount.toString() === "600002" &&
        state.finalUsdc.amount.toString() === "0" &&
        state.finalAsset.amount.toString() === "0" &&
        state.finalPortfolio.totalUnits.toString() === "0" &&
        state.finalPortfolio.status === 5,
      "Phase 3 final member withdrawal state",
    );
    const { bobUsdc, bobAsset, finalUsdc, finalAsset, finalPortfolio } = bobWithdrawalState;
    assert.equal(bobUsdc.amount.toString(), "5");
    assert.equal(bobAsset.amount.toString(), "600002");
    assert.equal(finalUsdc.amount.toString(), "0");
    assert.equal(finalAsset.amount.toString(), "0");
    assert.equal(finalPortfolio.totalUnits.toString(), "0");
    assert.equal(finalPortfolio.status, 5);

  });

  it("rejects unauthorized, early, mismatched, and frozen withdrawal accounts", async () => {
    const early = await setupScenario(5102, false);
    await assertRejected(
      () => withdraw(early, early.alice),
      "Withdrawal before ACTIVE must be rejected",
    );
    await assertRejected(
      () => withdraw(early, early.carol),
      "A wallet without a member PDA cannot withdraw",
    );
    await assertRejected(
      () =>
        program.methods
          .withdrawMember()
          .accounts({
            memberWallet: early.bob.publicKey,
            portfolio: early.portfolio,
            member: early.aliceMember,
          })
          .remainingAccounts(withdrawalAccounts(early, early.alice))
          .signers([early.bob])
          .rpc(),
      "A wallet cannot use another member's PDA",
    );

    const active = await setupScenario(5103);
    await assertRejected(
      () =>
        program.methods
          .withdrawMember()
          .accounts({
            memberWallet: active.alice.publicKey,
            portfolio: Keypair.generate().publicKey,
            member: active.aliceMember,
          })
          .remainingAccounts(withdrawalAccounts(active, active.alice))
          .signers([active.alice])
          .rpc(),
      "A member cannot withdraw against another portfolio",
    );

    const wrongVaultAccounts = withdrawalAccounts(active, active.alice);
    wrongVaultAccounts[4] = {
      pubkey: active.inputSink,
      isSigner: false,
      isWritable: true,
    };
    await assertRejected(
      () => withdraw(active, active.alice, wrongVaultAccounts),
      "A non-canonical vault must be rejected",
    );

    const wrongMintAccounts = withdrawalAccounts(active, active.alice);
    wrongMintAccounts[6] = {
      pubkey: active.usdcMint,
      isSigner: false,
      isWritable: false,
    };
    await assertRejected(
      () => withdraw(active, active.alice, wrongMintAccounts),
      "A mismatched basket mint must be rejected",
    );

    const wrongDestinationAccounts = withdrawalAccounts(active, active.bob);
    wrongDestinationAccounts[5] = {
      pubkey: active.aliceAsset,
      isSigner: false,
      isWritable: true,
    };
    await assertRejected(
      () => withdraw(active, active.bob, wrongDestinationAccounts),
      "A destination owned by another wallet must be rejected",
    );

    const assetMintState = await getMint(
      provider.connection,
      active.assetMint,
      "confirmed",
      TOKEN_2022_PROGRAM_ID,
    );
    assert.equal(
      assetMintState.freezeAuthority?.toBase58(),
      creator.publicKey.toBase58(),
      "the Token-2022 fixture mint must retain the creator freeze authority",
    );
    const assetVaultState = await getAccount(
      provider.connection,
      active.assetVault,
      "confirmed",
      TOKEN_2022_PROGRAM_ID,
    );
    assert.equal(assetVaultState.mint.toBase58(), active.assetMint.toBase58());
    assert.equal(assetVaultState.owner.toBase58(), active.portfolio.toBase58());
    await sendAndConfirmTransaction(
      provider.connection,
      new Transaction().add(
        createFreezeAccountInstruction(
          active.assetVault,
          active.assetMint,
          creator.publicKey,
          [],
          TOKEN_2022_PROGRAM_ID,
        ),
      ),
      [creator],
      { commitment: "confirmed" },
    );
    await assertRejected(
      () => withdraw(active, active.alice),
      "A frozen portfolio vault must be rejected",
    );
  });

  it("rolls back an earlier token transfer when a later vault transfer fails", async () => {
    const s = await setupScenario(5104);
    const badDestinationAccounts = withdrawalAccounts(s, s.alice);
    badDestinationAccounts[5] = {
      pubkey: s.aliceUsdc,
      isSigner: false,
      isWritable: true,
    };

    const beforeUsdc = await getAccount(provider.connection, s.usdcVault, "confirmed", TOKEN_PROGRAM_ID);
    const beforeAliceUsdc = await getAccount(provider.connection, s.aliceUsdc, "confirmed", TOKEN_PROGRAM_ID);
    const beforePortfolio = await program.account.portfolio.fetch(s.portfolio, "confirmed");
    await assertRejected(
      () => withdraw(s, s.alice, badDestinationAccounts),
      "A later invalid transfer must fail the entire withdrawal",
    );
    const afterUsdc = await getAccount(provider.connection, s.usdcVault, "confirmed", TOKEN_PROGRAM_ID);
    const afterAliceUsdc = await getAccount(provider.connection, s.aliceUsdc, "confirmed", TOKEN_PROGRAM_ID);
    const afterPortfolio = await program.account.portfolio.fetch(s.portfolio, "confirmed");
    const afterMember = await program.account.member.fetch(s.aliceMember, "confirmed");
    assert.equal(afterUsdc.amount.toString(), beforeUsdc.amount.toString());
    assert.equal(afterAliceUsdc.amount.toString(), beforeAliceUsdc.amount.toString());
    assert.equal(afterPortfolio.totalUnits.toString(), beforePortfolio.totalUnits.toString());
    assert.equal(afterPortfolio.status, 4);
    assert.equal(afterMember.ownershipUnits.toString(), ALICE_UNITS.toString());
    assert.equal(afterMember.withdrawalStatus, 0);
  });
});
