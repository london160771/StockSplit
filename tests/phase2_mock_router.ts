import * as anchor from "@coral-xyz/anchor";
import { assert } from "chai";
import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  createAccount,
  createAssociatedTokenAccount,
  createMint,
  getAccount,
  getAssociatedTokenAddressSync,
  mintTo,
  TOKEN_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
} from "@solana/spl-token";
import { Keypair, PublicKey, SystemProgram } from "@solana/web3.js";
import { waitForConfirmedState } from "./helpers/confirmed-state";

describe("StockSplit Phase 2 mock routed CPI", () => {
  type RetryDeploymentState = {
    status: number;
    deploymentLegs: Array<{ status: number }>;
  };

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
  const routeDiscriminator = Buffer.from([
    187, 100, 250, 204, 49, 196, 175, 20,
  ]);

  type Scenario = {
    portfolio: PublicKey;
    usdcMint: PublicKey;
    assetMint: PublicKey;
    usdcVault: PublicKey;
    assetVault: PublicKey;
    liquidityVault: PublicKey;
    inputSink: PublicKey;
    member: PublicKey;
    creatorUsdc: PublicKey;
  };

  function pda(seed: string, ...keys: PublicKey[]): PublicKey {
    return PublicKey.findProgramAddressSync(
      [Buffer.from(seed), ...keys.map((key) => key.toBuffer())],
      program.programId,
    )[0];
  }

  function routeData(
    inputAmount: bigint,
    quotedOutput: bigint,
    slippageBps: number,
    failAfterCpi = false,
  ): Buffer {
    const data = Buffer.alloc(41);
    routeDiscriminator.copy(data, 0);
    data.writeBigUInt64LE(inputAmount, 8);
    data.writeBigUInt64LE(quotedOutput, 16);
    data.writeUInt16LE(slippageBps, 24);
    data.writeUInt16LE(0, 26);
    data.writeUInt16LE(0, 28);
    data.writeUInt32LE(1, 30);
    data[34] = 0x2f;
    data[35] = failAfterCpi ? 1 : 0;
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
      // These protected duplicates deliberately use mixed outer flags. The
      // StockSplit program must derive their intended inner privileges from
      // their bound pubkeys, not from merged AccountInfo writability.
      { pubkey: s.portfolio, isSigner: false, isWritable: true },
      { pubkey: s.usdcVault, isSigner: false, isWritable: false },
      { pubkey: s.assetVault, isSigner: false, isWritable: false },
      { pubkey: s.liquidityVault, isSigner: false, isWritable: true },
      { pubkey: s.inputSink, isSigner: false, isWritable: true },
    ];
  }

  async function setupScenario(id: number): Promise<Scenario> {
    const usdcMint = await createMint(
      provider.connection,
      creator,
      creator.publicKey,
      null,
      6,
      Keypair.generate(),
      { commitment: "confirmed" },
      TOKEN_PROGRAM_ID,
    );
    const assetMint = await createMint(
      provider.connection,
      creator,
      creator.publicKey,
      null,
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
    const member = pda("member", portfolio, creator.publicKey);
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
    const creatorUsdc = getAssociatedTokenAddressSync(
      usdcMint,
      creator.publicKey,
      false,
      TOKEN_PROGRAM_ID,
      ASSOCIATED_TOKEN_PROGRAM_ID,
    );

    const now = Math.floor(Date.now() / 1000);
    await program.methods
      .createPortfolio(
        new anchor.BN(id),
        "Mock routed CPI",
        "Nonzero local router proof",
        new anchor.BN(now - 10),
        new anchor.BN(now + 3_600),
        new anchor.BN("2000000"),
        [{ mint: assetMint, allocationBps: 10_000 }],
      )
      .accounts({
        creator: creator.publicKey,
        portfolio,
        usdcMint,
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })
      .remainingAccounts([
        { pubkey: assetMint, isSigner: false, isWritable: false },
      ])
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

    if (!(await provider.connection.getAccountInfo(creatorUsdc, "confirmed"))) {
      await createAssociatedTokenAccount(
        provider.connection,
        creator,
        usdcMint,
        creator.publicKey,
        { commitment: "confirmed" },
        TOKEN_PROGRAM_ID,
        ASSOCIATED_TOKEN_PROGRAM_ID,
      );
    }

    await mintTo(
      provider.connection,
      creator,
      usdcMint,
      creatorUsdc,
      creator,
      2_000_000n,
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
      1_500_000n,
      [],
      { commitment: "confirmed" },
      TOKEN_2022_PROGRAM_ID,
    );

    const sourceState = await getAccount(
      provider.connection,
      creatorUsdc,
      "confirmed",
      TOKEN_PROGRAM_ID,
    );
    assert.equal(sourceState.mint.toBase58(), usdcMint.toBase58());
    assert.equal(sourceState.owner.toBase58(), creator.publicKey.toBase58());
    assert.equal(sourceState.amount.toString(), "2000000");

    const sinkState = await getAccount(
      provider.connection,
      inputSink,
      "confirmed",
      TOKEN_PROGRAM_ID,
    );
    assert.equal(sinkState.mint.toBase58(), usdcMint.toBase58());
    assert.equal(sinkState.owner.toBase58(), portfolio.toBase58());

    const liquidityState = await getAccount(
      provider.connection,
      liquidityVault,
      "confirmed",
      TOKEN_2022_PROGRAM_ID,
    );
    assert.equal(liquidityState.mint.toBase58(), assetMint.toBase58());
    assert.equal(liquidityState.owner.toBase58(), portfolio.toBase58());
    assert.equal(liquidityState.amount.toString(), "1500000");

    await program.methods
      .contribute(new anchor.BN("2000000"))
      .accounts({
        contributor: creator.publicKey,
        portfolio,
        member,
        mint: usdcMint,
        sourceToken: creatorUsdc,
        vault: usdcVault,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .signers([creator])
      .rpc();

    await program.methods
      .closeFunding()
      .accounts({ creator: creator.publicKey, portfolio })
      .signers([creator])
      .rpc();

    return {
      portfolio,
      usdcMint,
      assetMint,
      usdcVault,
      assetVault,
      liquidityVault,
      inputSink,
      member,
      creatorUsdc,
    };
  }

  async function deploy(s: Scenario, failAfterCpi = false): Promise<string> {
    return program.methods
      .deployLeg(
        0,
        new anchor.BN("2000000"),
        new anchor.BN("1500000"),
        new anchor.BN("1500000"),
        0,
        routeData(2_000_000n, 1_500_000n, 0, failAfterCpi),
      )
      .accounts({
        caller: creator.publicKey,
        portfolio: s.portfolio,
        inputMint: s.usdcMint,
        usdcVault: s.usdcVault,
        outputMint: s.assetMint,
        outputVault: s.assetVault,
        tokenProgram: TOKEN_PROGRAM_ID,
        outputTokenProgram: TOKEN_2022_PROGRAM_ID,
        jupiterProgram,
      })
      .remainingAccounts(routeAccounts(s))
      .signers([creator])
      .rpc();
  }

  it("executes a nonzero PDA-controlled CPI and completes a one-leg portfolio", async () => {
    const s = await setupScenario(4101);
    const outerRouteAccounts = routeAccounts(s);
    assert.isTrue(
      outerRouteAccounts.every((account) => !account.isSigner),
      "the outer Jupiter route must not require a PDA signer",
    );
    assert.isFalse(outerRouteAccounts[0].isSigner);
    assert.isFalse(outerRouteAccounts[0].isWritable);
    const deploySignature = await deploy(s);

    const completedState = await waitForConfirmedState(
      provider.connection,
      deploySignature,
      async () => {
        const [sourceState, outputState, portfolioState] = await Promise.all([
          getAccount(provider.connection, s.usdcVault, "confirmed", TOKEN_PROGRAM_ID),
          getAccount(provider.connection, s.assetVault, "confirmed", TOKEN_2022_PROGRAM_ID),
          program.account.portfolio.fetch(s.portfolio, "confirmed"),
        ]);
        return { sourceState, outputState, portfolioState };
      },
      (state) =>
        state.sourceState.amount.toString() === "0" &&
        state.outputState.amount.toString() === "1500000" &&
        state.portfolioState.status === 4 &&
        state.portfolioState.deploymentLegs[0].status === 1 &&
        state.portfolioState.deploymentLegs[0].inputAmount.toString() === "2000000" &&
        state.portfolioState.deploymentLegs[0].outputAmount.toString() === "1500000",
      "Phase 2 successful mock deployment state",
      {
        describe: (state) =>
          state
            ? `source=${state.sourceState.amount.toString()}, output=${state.outputState.amount.toString()}, status=${state.portfolioState.status}, legStatus=${state.portfolioState.deploymentLegs[0].status}`
            : "no snapshot",
      },
    );

    // The ACTIVE transition proves the StockSplit portfolio account was
    // writable at the outer instruction level. The mock router separately
    // rejects any CPI where the authority is writable, proving sanitization.
    assert.equal(completedState.sourceState.amount.toString(), "0");
    assert.equal(completedState.outputState.amount.toString(), "1500000");

    const state = completedState.portfolioState;
    assert.equal(state.status, 4, "one completed leg must make the portfolio ACTIVE");
    assert.equal(state.deploymentLegs[0].status, 1);
    assert.equal(state.deploymentLegs[0].inputAmount.toString(), "2000000");
    assert.equal(state.deploymentLegs[0].outputAmount.toString(), "1500000");

    let duplicateRejected = false;
    try {
      await deploy(s);
    } catch {
      duplicateRejected = true;
    }
    assert.isTrue(duplicateRejected, "completed deployment legs must reject duplicates");
  });

  it("rolls back failed CPI balances/state and keeps the leg retryable", async () => {
    const s = await setupScenario(4102);
    let failed = false;
    try {
      await deploy(s, true);
    } catch {
      failed = true;
    }
    assert.isTrue(failed, "the mock router must fail after attempting both transfers");

    assert.equal(
      (await getAccount(provider.connection, s.usdcVault, "confirmed", TOKEN_PROGRAM_ID)).amount.toString(),
      "2000000",
    );
    assert.equal(
      (await getAccount(provider.connection, s.assetVault, "confirmed", TOKEN_2022_PROGRAM_ID)).amount.toString(),
      "0",
    );

    const pending = await program.account.portfolio.fetch(s.portfolio);
    assert.equal(pending.status, 2);
    assert.equal(pending.deploymentLegs[0].status, 0);
    assert.equal(pending.deploymentLegs[0].inputAmount.toString(), "0");

    const retrySignature = await deploy(s);
    const completed = await waitForConfirmedState<RetryDeploymentState>(
      provider.connection,
      retrySignature,
      () =>
        program.account.portfolio.fetch(
          s.portfolio,
          "confirmed",
        ) as Promise<RetryDeploymentState>,
      (value) => value.status === 4 && value.deploymentLegs[0].status === 1,
      "Phase 2 retry deployment state",
    );
    assert.equal(completed.status, 4);
    assert.equal(completed.deploymentLegs[0].status, 1);
  });
});
