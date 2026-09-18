import * as anchor from "@coral-xyz/anchor";
import { assert } from "chai";
import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  createAssociatedTokenAccount,
  createMint,
  getAccount,
  getAssociatedTokenAddressSync,
  mintTo,
  TOKEN_2022_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import {
  Keypair,
  LAMPORTS_PER_SOL,
  PublicKey,
  SystemProgram,
} from "@solana/web3.js";

describe("StockSplit Phase 2: deployment engine guards", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);
  const program = anchor.workspace.StockSplitPhase0 as any;
  const creator = (provider.wallet as anchor.Wallet).payer;
  const JUPITER_V6_PROGRAM_ID = new PublicKey(
    "JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4",
  );
  const ROUTE_DISCRIMINATOR = Buffer.from([
    187, 100, 250, 204, 49, 196, 175, 20,
  ]);
  const JUPITER_EVENT_AUTHORITY = new PublicKey(
    "D8cy77BBepLMngZx6ZukaTff5hCt1HrWyKk3Hnd9oitf",
  );

  type Scenario = {
    portfolio: PublicKey;
    usdcMint: PublicKey;
    firstMint: PublicKey;
    secondMint: PublicKey;
    usdcVault: PublicKey;
    firstVault: PublicKey;
    secondVault: PublicKey;
    creatorUsdc: PublicKey;
    member: PublicKey;
  };

  async function assertRejected(
    action: () => Promise<unknown>,
    message: string,
  ): Promise<void> {
    let rejected = false;
    try {
      await action();
    } catch {
      rejected = true;
    }
    assert.isTrue(rejected, message);
  }

  function pda(seed: string, ...keys: PublicKey[]): PublicKey {
    return PublicKey.findProgramAddressSync(
      [Buffer.from(seed), ...keys.map((key) => key.toBuffer())],
      program.programId,
    )[0];
  }

  function routeData(
    inputAmount = 4_000_000,
    quotedOutput = 4_000_000,
    slippageBps = 100,
    platformFeeBps = 0,
    positiveSlippageBps = 0,
  ): Buffer {
    const args = Buffer.alloc(8 + 8 + 2 + 2 + 2 + 4 + 1 + 2 + 1 + 1);
    let offset = 0;
    args.writeBigUInt64LE(BigInt(inputAmount), offset);
    offset += 8;
    args.writeBigUInt64LE(BigInt(quotedOutput), offset);
    offset += 8;
    args.writeUInt16LE(slippageBps, offset);
    offset += 2;
    args.writeUInt16LE(platformFeeBps, offset);
    offset += 2;
    args.writeUInt16LE(positiveSlippageBps, offset);
    offset += 2;
    args.writeUInt32LE(1, offset);
    offset += 4;
    args[offset++] = 7;
    args.writeUInt16LE(10_000, offset);
    offset += 2;
    args[offset++] = 0;
    args[offset] = 1;
    return Buffer.concat([ROUTE_DISCRIMINATOR, args]);
  }

  async function tokenAccount(mint: PublicKey, owner: PublicKey): Promise<PublicKey> {
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

  async function mint2022(): Promise<PublicKey> {
    return createMint(
      provider.connection,
      creator,
      creator.publicKey,
      null,
      6,
      Keypair.generate(),
      { commitment: "confirmed" },
      TOKEN_2022_PROGRAM_ID,
    );
  }

  async function scenario(id: number): Promise<Scenario> {
    const usdcMint = await mint2022();
    const firstMint = await mint2022();
    const secondMint = await mint2022();
    const idBytes = Buffer.alloc(8);
    idBytes.writeBigUInt64LE(BigInt(id));
    const portfolio = PublicKey.findProgramAddressSync(
      [Buffer.from("portfolio"), creator.publicKey.toBuffer(), idBytes],
      program.programId,
    )[0];
    const usdcVault = pda("vault", portfolio, usdcMint);
    const firstVault = pda("vault", portfolio, firstMint);
    const secondVault = pda("vault", portfolio, secondMint);
    const creatorUsdc = await tokenAccount(usdcMint, creator.publicKey);

    await mintTo(
      provider.connection,
      creator,
      usdcMint,
      creatorUsdc,
      creator,
      100_000_000n,
      [],
      { commitment: "confirmed" },
      TOKEN_2022_PROGRAM_ID,
    );

    const now = Math.floor(Date.now() / 1000);
    await program.methods
      .createPortfolio(
        new anchor.BN(id),
        "Phase 2 deployment",
        "PDA-controlled one-leg deployment",
        new anchor.BN(now - 10),
        new anchor.BN(now + 3_600),
        new anchor.BN("10000000"),
        [
          { mint: firstMint, allocationBps: 4_000 },
          { mint: secondMint, allocationBps: 6_000 },
        ],
      )
      .accounts({
        creator: creator.publicKey,
        portfolio,
        usdcMint,
        tokenProgram: TOKEN_2022_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })
      .remainingAccounts([
        { pubkey: firstMint, isSigner: false, isWritable: false },
        { pubkey: secondMint, isSigner: false, isWritable: false },
      ])
      .signers([creator])
      .rpc();

    for (const [mint, vault] of [
      [usdcMint, usdcVault],
      [firstMint, firstVault],
      [secondMint, secondVault],
    ] as [PublicKey, PublicKey][]) {
      await program.methods
        .initializeVault()
        .accounts({
          payer: creator.publicKey,
          portfolio,
          mint,
          vault,
          tokenProgram: TOKEN_2022_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
        })
        .signers([creator])
        .rpc();
    }

    const member = pda("member", portfolio, creator.publicKey);
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
    await program.methods
      .contribute(new anchor.BN("10000000"))
      .accounts({
        contributor: creator.publicKey,
        portfolio,
        member,
        mint: usdcMint,
        sourceToken: creatorUsdc,
        vault: usdcVault,
        tokenProgram: TOKEN_2022_PROGRAM_ID,
      })
      .signers([creator])
      .rpc();

    return {
      portfolio,
      usdcMint,
      firstMint,
      secondMint,
      usdcVault,
      firstVault,
      secondVault,
      creatorUsdc,
      member,
    };
  }

  function routeAccounts(
    s: Scenario,
    outputMint = s.firstMint,
    outputVault = s.firstVault,
    inputTokenProgram = TOKEN_2022_PROGRAM_ID,
    outputTokenProgram = TOKEN_2022_PROGRAM_ID,
    dynamicTail: { pubkey: PublicKey; isSigner: boolean; isWritable: boolean }[] = [],
  ) {
    return [
      { pubkey: s.portfolio, isSigner: false, isWritable: false },
      { pubkey: s.usdcVault, isSigner: false, isWritable: true },
      { pubkey: outputVault, isSigner: false, isWritable: true },
      { pubkey: s.usdcMint, isSigner: false, isWritable: false },
      { pubkey: outputMint, isSigner: false, isWritable: false },
      { pubkey: inputTokenProgram, isSigner: false, isWritable: false },
      { pubkey: outputTokenProgram, isSigner: false, isWritable: false },
      { pubkey: JUPITER_V6_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: JUPITER_EVENT_AUTHORITY, isSigner: false, isWritable: false },
      { pubkey: JUPITER_V6_PROGRAM_ID, isSigner: false, isWritable: false },
      ...dynamicTail,
    ];
  }

  async function deployAttempt(
    s: Scenario,
    args: {
      expectedInput?: string;
      quotedOutput?: string;
      minOutput?: string;
      slippageBps?: number;
      outputMint?: PublicKey;
      outputVault?: PublicKey;
      routeData?: Buffer;
      platformFeeBps?: number;
      positiveSlippageBps?: number;
      routeInputTokenProgram?: PublicKey;
      routeOutputTokenProgram?: PublicKey;
      dynamicTail?: { pubkey: PublicKey; isSigner: boolean; isWritable: boolean }[];
    } = {},
  ): Promise<void> {
    await program.methods
      .deployLeg(
        0,
        new anchor.BN(args.expectedInput ?? "4000000"),
        new anchor.BN(args.quotedOutput ?? "4000000"),
        new anchor.BN(args.minOutput ?? "3960000"),
        args.slippageBps ?? 100,
        args.routeData ??
          routeData(
            Number(args.expectedInput ?? "4000000"),
            Number(args.quotedOutput ?? "4000000"),
            args.slippageBps ?? 100,
            args.platformFeeBps ?? 0,
            args.positiveSlippageBps ?? 0,
          ),
      )
      .accounts({
        caller: creator.publicKey,
        portfolio: s.portfolio,
        inputMint: s.usdcMint,
        usdcVault: s.usdcVault,
        outputMint: args.outputMint ?? s.firstMint,
        outputVault: args.outputVault ?? s.firstVault,
        tokenProgram: TOKEN_2022_PROGRAM_ID,
        outputTokenProgram: TOKEN_2022_PROGRAM_ID,
        jupiterProgram: JUPITER_V6_PROGRAM_ID,
      })
      .remainingAccounts(
        routeAccounts(
          s,
          args.outputMint,
          args.outputVault,
          args.routeInputTokenProgram ?? TOKEN_2022_PROGRAM_ID,
          args.routeOutputTokenProgram ?? TOKEN_2022_PROGRAM_ID,
          args.dynamicTail,
        ),
      )
      .signers([creator])
      .rpc();
  }

  before(async () => {
    const signature = await provider.connection.requestAirdrop(
      creator.publicKey,
      2 * LAMPORTS_PER_SOL,
    );
    await provider.connection.confirmTransaction(signature, "confirmed");
  });

  it("derives the first leg from recorded contribution units, not vault balance", async () => {
    const s = await scenario(3001);
    await program.methods
      .closeFunding()
      .accounts({ creator: creator.publicKey, portfolio: s.portfolio })
      .signers([creator])
      .rpc();

    await assertRejected(
      () => deployAttempt(s, { expectedInput: "5000000" }),
      "A 40% leg must reject an input amount not derived from total_contributed",
    );
    await mintTo(
      provider.connection,
      creator,
      s.usdcMint,
      s.usdcVault,
      creator,
      2_000_000n,
      [],
      { commitment: "confirmed" },
      TOKEN_2022_PROGRAM_ID,
    );
    await assertRejected(
      () => deployAttempt(s, { expectedInput: "12000000" }),
      "Unsolicited vault surplus must not change the recorded deployment amount",
    );
    const state = await program.account.portfolio.fetch(s.portfolio);
    assert.equal(state.totalContributed.toString(), "10000000");
    assert.equal(state.deploymentLegs[0].inputAmount.toString(), "0");
  });

  it("rejects deployment before funding is closed", async () => {
    const s = await scenario(3002);
    await assertRejected(
      () => deployAttempt(s),
      "A FUNDING portfolio must not deploy a basket leg",
    );
  });

  it("rejects wrong input/output mints and destinations", async () => {
    const s = await scenario(3003);
    await program.methods
      .closeFunding()
      .accounts({ creator: creator.publicKey, portfolio: s.portfolio })
      .signers([creator])
      .rpc();
    const wrongMint = await mint2022();
    const wrongVault = await tokenAccount(wrongMint, creator.publicKey);

    await assertRejected(
      () =>
        program.methods
          .deployLeg(0, new anchor.BN("4000000"), new anchor.BN("4000000"), new anchor.BN("3960000"), 100, routeData())
          .accounts({
            caller: creator.publicKey,
            portfolio: s.portfolio,
            inputMint: wrongMint,
            usdcVault: s.usdcVault,
            outputMint: s.firstMint,
            outputVault: s.firstVault,
            tokenProgram: TOKEN_2022_PROGRAM_ID,
            outputTokenProgram: TOKEN_2022_PROGRAM_ID,
            jupiterProgram: JUPITER_V6_PROGRAM_ID,
          })
          .remainingAccounts(routeAccounts(s))
          .signers([creator])
          .rpc(),
      "The input mint must be the configured Token-2022 USDC mint",
    );
    await assertRejected(
      () => deployAttempt(s, { outputMint: wrongMint, outputVault: wrongVault }),
      "The output mint must be an immutable basket mint",
    );
    await assertRejected(
      () => deployAttempt(s, { outputVault: wrongVault }),
      "The output destination must be the PDA-derived basket vault",
    );
  });

  it("rejects unauthorized fees, token programs, and protected dynamic accounts", async () => {
    const s = await scenario(3005);
    await program.methods
      .closeFunding()
      .accounts({ creator: creator.publicKey, portfolio: s.portfolio })
      .signers([creator])
      .rpc();

    await assertRejected(
      () => deployAttempt(s, { platformFeeBps: 1 }),
      "A nonzero platform fee must be rejected",
    );
    await assertRejected(
      () => deployAttempt(s, { positiveSlippageBps: 1 }),
      "A nonzero positive-slippage fee must be rejected",
    );
    await assertRejected(
      () => deployAttempt(s, { routeInputTokenProgram: TOKEN_PROGRAM_ID }),
      "The fixed input token program must match the configured USDC program",
    );
    await assertRejected(
      () => deployAttempt(s, { routeOutputTokenProgram: TOKEN_PROGRAM_ID }),
      "The fixed output token program must be Token-2022",
    );
    await assertRejected(
      () =>
        deployAttempt(s, {
          dynamicTail: [{ pubkey: s.secondVault, isSigner: false, isWritable: true }],
        }),
      "A different configured portfolio vault must be rejected from the dynamic tail",
    );
    await assertRejected(
      () =>
        deployAttempt(s, {
          dynamicTail: [{ pubkey: s.portfolio, isSigner: true, isWritable: true }],
        }),
      "A repeated portfolio PDA must never arrive as an outer signer",
    );
    await assertRejected(
      () =>
        deployAttempt(s, {
          dynamicTail: [{ pubkey: s.usdcVault, isSigner: true, isWritable: false }],
        }),
      "A repeated USDC vault must never arrive as an outer signer",
    );
    await assertRejected(
      () =>
        deployAttempt(s, {
          dynamicTail: [{ pubkey: s.firstVault, isSigner: true, isWritable: false }],
        }),
      "A repeated output vault must never arrive as an outer signer",
    );
  });

  it("rejects excessive slippage and keeps an unexecuted leg retryable", async () => {
    const s = await scenario(3004);
    await program.methods
      .closeFunding()
      .accounts({ creator: creator.publicKey, portfolio: s.portfolio })
      .signers([creator])
      .rpc();
    await assertRejected(
      () => deployAttempt(s, { slippageBps: 1_001 }),
      "Slippage above the supported limit must be rejected",
    );
    await assertRejected(
      () => deployAttempt(s),
      "A route that cannot execute must fail without completing the leg",
    );
    const state = await program.account.portfolio.fetch(s.portfolio);
    assert.equal(state.status, 2);
    assert.equal(state.deploymentLegs[0].status, 0);
    assert.equal(state.deploymentLegs[0].inputAmount.toString(), "0");
    assert.equal(
      (await getAccount(provider.connection, s.usdcVault, "confirmed", TOKEN_2022_PROGRAM_ID)).amount.toString(),
      "10000000",
    );
  });
});
