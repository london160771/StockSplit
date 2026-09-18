import * as anchor from "@coral-xyz/anchor";
import { assert } from "chai";
import {
  createAssociatedTokenAccount,
  createMint,
  getAccount,
  getAssociatedTokenAddressSync,
  getMint,
  mintTo,
  TOKEN_2022_PROGRAM_ID,
} from "@solana/spl-token";
import { Keypair, PublicKey, sendAndConfirmTransaction, SystemProgram, Transaction } from "@solana/web3.js";
import { waitForConfirmedState } from "./helpers/confirmed-state";

const envProvider = anchor.AnchorProvider.env();
const provider = new anchor.AnchorProvider(envProvider.connection, envProvider.wallet, {
  commitment: "confirmed", preflightCommitment: "confirmed",
});
anchor.setProvider(provider);
const program = anchor.workspace.StockSplitPhase0 as any;
const creator = (provider.wallet as anchor.Wallet).payer;
const TEST_USDC = new PublicKey("HfstGSPF1MJsD8hrpYTcPhqT6uxXTvCFSeuBYLsZJ26J");
const OUTPUTS = [
  { label: "TEST-NVDAx", mint: new PublicKey("Cedwf76ynoKGU5jRxHNx2Y1B2b8VNuEEuf2jDevy7L9F") },
  { label: "TEST-AAPLx", mint: new PublicKey("7DB6cCsaG1sFvPzX8DUL3GfetHbQyEMYmYHuShdhiNDW") },
  { label: "TEST-TSLAx", mint: new PublicKey("AzkzmLNh2SzTTdHnYmaC4GAxiLnngCJkPeLDCNLRbPWm") },
  { label: "TEST-SPYx", mint: new PublicKey("8DrsDuwYPsSY8LaLGKpiBFyCkz5bLFzdZAk6kbqKADJ9") },
] as const;

type Scenario = {
  portfolio: PublicKey;
  usdcVault: PublicKey;
  outputVaults: PublicKey[];
  basket: Array<{ mint: PublicKey; allocationBps: number }>;
  total: bigint;
};

type LegSnapshot = {
  slot: number;
  usdc: bigint;
  output: bigint;
  liquidity: bigint;
  sink: bigint;
  portfolioData: Buffer;
  state: any;
};

function pda(seed: string, ...keys: PublicKey[]): PublicKey {
  return PublicKey.findProgramAddressSync([Buffer.from(seed), ...keys.map((key) => key.toBuffer())], program.programId)[0];
}

function intendedInput(s: Scenario, index: number): bigint {
  if (index === s.basket.length - 1) {
    return s.total - s.basket.slice(0, index).reduce((sum, asset) => sum + s.total * BigInt(asset.allocationBps) / 10_000n, 0n);
  }
  return s.total * BigInt(s.basket[index].allocationBps) / 10_000n;
}

async function assertRejected(action: () => Promise<unknown>, expected: string | string[]): Promise<void> {
  let rejection: unknown;
  try {
    await action();
  } catch (error) {
    rejection = error;
  }
  const expectedCodes = Array.isArray(expected) ? expected : [expected];
  assert.isDefined(rejection, `Expected ${expectedCodes.join(" or ")} rejection`);
  const error = rejection as {
    error?: { errorCode?: { code?: string; number?: number } };
    code?: number;
    logs?: string[];
    transactionError?: { logs?: string[] };
    getLogs?: (connection: typeof provider.connection) => Promise<string[]>;
  };
  let logs = Array.isArray(error.logs) ? error.logs : error.transactionError?.logs ?? [];
  if (!logs.length && typeof error.getLogs === "function") {
    try { logs = await error.getLogs(provider.connection); } catch { /* The simulation may have no transaction signature. */ }
  }
  const details = [String(rejection), ...logs].join("\n");
  let actual = error.error?.errorCode?.code;
  if (!actual) {
    const anchorLog = [...logs].reverse().find((line) => line.includes("AnchorError") && line.includes("Error Code:"));
    actual = /Error Code:\s*([A-Za-z][A-Za-z0-9_]*)/.exec(anchorLog ?? details)?.[1];
  }
  if (!actual) {
    const customCode = /custom program error:\s*(0x[0-9a-f]+|[0-9]+)/i.exec(details)?.[1];
    const number = error.error?.errorCode?.number ?? error.code ?? (customCode ? Number(customCode) : undefined);
    actual = program.idl.errors?.find((entry: { code: number; name: string }) => entry.code === number)?.name;
  }
  assert.isTrue(typeof actual === "string" && expectedCodes.includes(actual),
    `Expected ${expectedCodes.join(" or ")}, received ${actual ?? "unparsed error"}. ${details}`);
}

const demoDescribe = typeof program.methods.deployDemoLeg === "function" ? describe : describe.skip;
demoDescribe("StockSplit feature-enabled Devnet demo settlement (local validator only)", () => {
  const demoAuthority = pda("demo-authority");
  const demoUsdcSink = pda("demo-sink", TEST_USDC);
  const liquidity = OUTPUTS.map((asset) => pda("demo-liquidity", asset.mint));
  let main: Scenario;
  let negative: Scenario;
  let rollback: Scenario;

  async function makeScenario(id: number, selected: number[], total: bigint): Promise<Scenario> {
    const idBytes = Buffer.alloc(8);
    idBytes.writeBigUInt64LE(BigInt(id));
    const portfolio = PublicKey.findProgramAddressSync(
      [Buffer.from("portfolio"), creator.publicKey.toBuffer(), idBytes], program.programId,
    )[0];
    const basket = selected.map((assetIndex, index) => ({
      mint: OUTPUTS[assetIndex].mint,
      allocationBps: index === selected.length - 1 ? 10_000 - Math.floor(10_000 / selected.length) * index : Math.floor(10_000 / selected.length),
    }));
    const now = Math.floor(Date.now() / 1000);
    await program.methods.createPortfolio(
      new anchor.BN(id), `Demo test ${id}`, "Local-only fixed-mint settlement",
      new anchor.BN(now - 10), new anchor.BN(now + 3600), new anchor.BN(total.toString()), basket,
    ).accounts({
      creator: creator.publicKey, portfolio, usdcMint: TEST_USDC,
      tokenProgram: TOKEN_2022_PROGRAM_ID, systemProgram: SystemProgram.programId,
    }).remainingAccounts(basket.map((asset) => ({ pubkey: asset.mint, isSigner: false, isWritable: false }))).rpc();

    const usdcVault = pda("vault", portfolio, TEST_USDC);
    const outputVaults = basket.map((asset) => pda("vault", portfolio, asset.mint));
    for (const [index, mint] of [TEST_USDC, ...basket.map((asset) => asset.mint)].entries()) {
      await program.methods.initializeVault().accounts({
        payer: creator.publicKey, portfolio, mint, vault: index === 0 ? usdcVault : outputVaults[index - 1],
        tokenProgram: TOKEN_2022_PROGRAM_ID, systemProgram: SystemProgram.programId,
      }).rpc();
    }
    const member = pda("member", portfolio, creator.publicKey);
    await program.methods.inviteMember().accounts({
      creator: creator.publicKey, portfolio, wallet: creator.publicKey, member,
      systemProgram: SystemProgram.programId,
    }).rpc();
    await program.methods.openFunding().accounts({ creator: creator.publicKey, portfolio }).rpc();
    const sourceToken = getAssociatedTokenAddressSync(TEST_USDC, creator.publicKey, false, TOKEN_2022_PROGRAM_ID);
    if (!(await provider.connection.getAccountInfo(sourceToken, "confirmed"))) {
      await createAssociatedTokenAccount(provider.connection, creator, TEST_USDC, creator.publicKey,
        { commitment: "confirmed" }, TOKEN_2022_PROGRAM_ID);
    }
    await mintTo(provider.connection, creator, TEST_USDC, sourceToken, creator, total, [],
      { commitment: "confirmed" }, TOKEN_2022_PROGRAM_ID);
    await program.methods.contribute(new anchor.BN(total.toString())).accounts({
      contributor: creator.publicKey, portfolio, member, mint: TEST_USDC,
      sourceToken, vault: usdcVault, tokenProgram: TOKEN_2022_PROGRAM_ID,
    }).rpc();
    await program.methods.closeFunding().accounts({ creator: creator.publicKey, portfolio }).rpc();
    return { portfolio, usdcVault, outputVaults, basket, total };
  }

  function deployMethod(s: Scenario, index: number, override: { mint?: PublicKey; vault?: PublicKey; caller?: PublicKey } = {}) {
    const mint = override.mint ?? s.basket[index].mint;
    const outputIndex = OUTPUTS.findIndex((asset) => asset.mint.equals(mint));
    const amount = intendedInput(s, index);
    return program.methods.deployDemoLeg(index, new anchor.BN(amount.toString()), new anchor.BN(amount.toString()))
      .accounts({
        caller: override.caller ?? creator.publicKey,
        portfolio: s.portfolio,
        inputMint: TEST_USDC,
        usdcVault: s.usdcVault,
        outputMint: mint,
        outputVault: override.vault ?? s.outputVaults[index],
        demoAuthority,
        demoUsdcSink,
        demoOutputLiquidity: outputIndex < 0 ? liquidity[0] : liquidity[outputIndex],
        tokenProgram: TOKEN_2022_PROGRAM_ID,
      });
  }

  async function readLegSnapshot(s: Scenario, index: number, minContextSlot?: number): Promise<LegSnapshot> {
    const liquidityIndex = OUTPUTS.findIndex((asset) => asset.mint.equals(s.basket[index].mint));
    if (liquidityIndex < 0) throw new Error("Scenario contains an unapproved demo output mint.");
    const response = await provider.connection.getMultipleAccountsInfoAndContext([
      s.usdcVault, s.outputVaults[index], liquidity[liquidityIndex],
      demoUsdcSink, s.portfolio,
    ], { commitment: "confirmed", minContextSlot });
    const [usdcInfo, outputInfo, liquidityInfo, sinkInfo, portfolioInfo] = response.value;
    if (!usdcInfo || !outputInfo || !liquidityInfo || !sinkInfo || !portfolioInfo) {
      throw new Error("A canonical demo settlement account is missing from the confirmed local snapshot.");
    }
    function tokenAmount(info: typeof usdcInfo, mint: PublicKey, owner: PublicKey): bigint {
      assert.isTrue(info.owner.equals(TOKEN_2022_PROGRAM_ID), "token account program must be Token-2022");
      assert.isAtLeast(info.data.length, 72, "token account data is truncated");
      assert.isTrue(info.data.subarray(0, 32).equals(mint.toBuffer()), "token account mint mismatch");
      assert.isTrue(info.data.subarray(32, 64).equals(owner.toBuffer()), "token account authority mismatch");
      return info.data.readBigUInt64LE(64);
    }
    assert.isTrue(portfolioInfo.owner.equals(program.programId), "portfolio account owner mismatch");
    return {
      slot: response.context.slot,
      usdc: tokenAmount(usdcInfo, TEST_USDC, s.portfolio),
      output: tokenAmount(outputInfo, s.basket[index].mint, s.portfolio),
      liquidity: tokenAmount(liquidityInfo, s.basket[index].mint, demoAuthority),
      sink: tokenAmount(sinkInfo, TEST_USDC, demoAuthority),
      portfolioData: Buffer.from(portfolioInfo.data),
      state: program.coder.accounts.decode("portfolio", portfolioInfo.data),
    };
  }

  before(async () => {
    assert.equal(program.programId.toBase58(), "9nLrXyjgLTwMxnyBJ2GnKqnHZiu5koYNHrpKXezVGDmm");
    for (const [label, mint] of [["TEST-USDC", TEST_USDC], ...OUTPUTS.map((asset) => [asset.label, asset.mint])] as [string, PublicKey][]) {
      assert.isNotNull(
        await provider.connection.getAccountInfo(mint, "confirmed"),
        `Local ${label} mint ${mint.toBase58()} is missing; start the validator with pnpm test:local-demo.`,
      );
      const localMint = await getMint(provider.connection, mint, "confirmed", TOKEN_2022_PROGRAM_ID);
      assert.equal(localMint.decimals, 6);
      assert.equal(localMint.mintAuthority?.toBase58(), creator.publicKey.toBase58(),
        `Local ${label} mint authority must be the ephemeral harness wallet.`);
    }
    for (const [index, asset] of OUTPUTS.entries()) {
      await program.methods.prepareDemoRouter().accounts({
        payer: creator.publicKey, inputMint: TEST_USDC, outputMint: asset.mint,
        demoAuthority, demoUsdcSink, demoOutputLiquidity: liquidity[index],
        tokenProgram: TOKEN_2022_PROGRAM_ID,
      }).rpc();
    }
    main = await makeScenario(99001, [0, 1, 2, 3], 8_000_003n);
    negative = await makeScenario(99002, [0, 1], 5_000_000n);
    rollback = await makeScenario(99003, [0], 4_000_000n);
    for (const [index, asset] of OUTPUTS.entries()) {
      const expectedLiquidity = intendedInput(main, index);
      const signature = await mintTo(provider.connection, creator, asset.mint, liquidity[index], creator,
        expectedLiquidity, [], { commitment: "confirmed" }, TOKEN_2022_PROGRAM_ID);
      await waitForConfirmedState(
        provider.connection,
        signature,
        () => getAccount(provider.connection, liquidity[index], "confirmed", TOKEN_2022_PROGRAM_ID),
        (account) => account.amount === expectedLiquidity,
        `${asset.label} initial demo liquidity`,
      );
    }
  });

  for (const [index, asset] of OUTPUTS.entries()) {
    it(`settles ${asset.label} at exact 1:1 raw units into its canonical vault`, async () => {
      const amount = intendedInput(main, index);
      const before = await readLegSnapshot(main, index);
      const signature = await deployMethod(main, index).rpc();
      const after = await waitForConfirmedState(
        provider.connection,
        signature,
        () => readLegSnapshot(main, index, before.slot),
        (snapshot) => before.usdc - snapshot.usdc === amount
          && snapshot.output - before.output === amount
          && before.liquidity - snapshot.liquidity === amount
          && snapshot.sink - before.sink === amount
          && snapshot.state.deploymentLegs[index].status === 1,
        `${asset.label} exact 1:1 settlement`,
        {
          timeoutMs: 15_000,
          describe: (snapshot) => `slot=${snapshot?.slot} usdc=${snapshot?.usdc} output=${snapshot?.output} liquidity=${snapshot?.liquidity} sink=${snapshot?.sink} leg=${snapshot?.state.deploymentLegs[index].status}`,
        },
      );
      const state = after.state;
      assert.equal((before.usdc - after.usdc).toString(), amount.toString());
      assert.equal((after.output - before.output).toString(), amount.toString());
      assert.equal((before.liquidity - after.liquidity).toString(), amount.toString());
      assert.equal((after.sink - before.sink).toString(), amount.toString());
      assert.equal(state.deploymentLegs[index].status, 1);
      assert.equal(state.deploymentLegs[index].inputAmount.toString(), amount.toString());
      assert.equal(state.deploymentLegs[index].outputAmount.toString(), amount.toString());
      assert.equal(state.totalUnits.toString(), main.total.toString(), "deployment must not change ownership");
      assert.equal(state.status, index === OUTPUTS.length - 1 ? 4 : 3, "only the final leg activates the portfolio");
    });
  }

  it("requires the portfolio creator to authorize a demo leg", async () => {
    const outsider = Keypair.generate();
    await assertRejected(
      () => deployMethod(negative, 0, { caller: outsider.publicKey }).signers([outsider]).rpc(),
      "Unauthorized",
    );
  });

  it("rejects an approved mint from the wrong basket index", async () => {
    await assertRejected(() => deployMethod(negative, 0, { mint: OUTPUTS[1].mint, vault: negative.outputVaults[1] }).rpc(), "InvalidSwapMint");
  });

  it("rejects a noncanonical output vault", async () => {
    await assertRejected(() => deployMethod(negative, 0, { vault: negative.outputVaults[1] }).rpc(), "ConstraintSeeds");
  });

  it("rejects an arbitrary Token-2022 output mint", async () => {
    const arbitrary = await createMint(provider.connection, creator, creator.publicKey, null, 6,
      Keypair.generate(), { commitment: "confirmed" }, TOKEN_2022_PROGRAM_ID);
    await assertRejected(() => deployMethod(negative, 0, { mint: arbitrary }).rpc(), "InvalidSwapMint");
  });

  it("rejects insufficient liquidity without spending USDC or completing the leg", async () => {
    const sourceBefore = (await getAccount(provider.connection, negative.usdcVault, "confirmed", TOKEN_2022_PROGRAM_ID)).amount;
    await assertRejected(() => deployMethod(negative, 0).rpc(), "SlippageExceeded");
    assert.equal((await getAccount(provider.connection, negative.usdcVault, "confirmed", TOKEN_2022_PROGRAM_ID)).amount.toString(), sourceBefore.toString());
    assert.equal((await program.account.portfolio.fetch(negative.portfolio)).deploymentLegs[0].status, 0);
  });

  it("rejects a completed non-final leg while the portfolio is still DEPLOYING", async () => {
    const amount = intendedInput(negative, 0);
    const liquidityBefore = (await readLegSnapshot(negative, 0)).liquidity;
    const fundingSignature = await mintTo(provider.connection, creator, OUTPUTS[0].mint, liquidity[0], creator, amount, [],
      { commitment: "confirmed" }, TOKEN_2022_PROGRAM_ID);
    const before = await waitForConfirmedState(
      provider.connection,
      fundingSignature,
      () => readLegSnapshot(negative, 0),
      (snapshot) => snapshot.liquidity - liquidityBefore === amount,
      "non-final duplicate test liquidity funding",
    );
    const signature = await deployMethod(negative, 0).rpc();
    const completed = await waitForConfirmedState(
      provider.connection,
      signature,
      () => readLegSnapshot(negative, 0, before.slot),
      (snapshot) => before.usdc - snapshot.usdc === amount
        && snapshot.output - before.output === amount
        && before.liquidity - snapshot.liquidity === amount
        && snapshot.sink - before.sink === amount
        && snapshot.state.deploymentLegs[0].status === 1
        && snapshot.state.deploymentLegs[1].status === 0
        && snapshot.state.status === 3,
      "non-final demo leg completion",
      { timeoutMs: 15_000 },
    );
    await assertRejected(() => deployMethod(negative, 0).rpc(), "DeploymentAlreadyCompleted");
    const afterReplay = await readLegSnapshot(negative, 0, completed.slot);
    assert.equal(afterReplay.usdc.toString(), completed.usdc.toString());
    assert.equal(afterReplay.output.toString(), completed.output.toString());
    assert.equal(afterReplay.liquidity.toString(), completed.liquidity.toString());
    assert.equal(afterReplay.sink.toString(), completed.sink.toString());
    assert.equal(afterReplay.state.status, 3);
    assert.equal(afterReplay.state.deploymentLegs[0].status, 1);
    assert.equal(afterReplay.state.deploymentLegs[1].status, 0);
    assert.isTrue(afterReplay.portfolioData.equals(completed.portfolioData), "replay changed portfolio or leg state");
  });

  it("rolls back a completed first instruction when a second instruction fails, then retries", async () => {
    const amount = intendedInput(rollback, 0);
    const liquidityBefore = (await readLegSnapshot(rollback, 0)).liquidity;
    const fundingSignature = await mintTo(provider.connection, creator, OUTPUTS[0].mint, liquidity[0], creator, amount, [],
      { commitment: "confirmed" }, TOKEN_2022_PROGRAM_ID);
    const before = await waitForConfirmedState(
      provider.connection,
      fundingSignature,
      () => readLegSnapshot(rollback, 0),
      (snapshot) => snapshot.liquidity - liquidityBefore === amount,
      "rollback test liquidity funding",
    );
    const instruction = await deployMethod(rollback, 0).instruction();
    await assertRejected(
      () => sendAndConfirmTransaction(provider.connection, new Transaction().add(instruction, instruction), [creator], { commitment: "confirmed" }),
      ["DeploymentAlreadyCompleted", "InvalidLifecycle"],
    );
    const afterFailed = await readLegSnapshot(rollback, 0, before.slot);
    assert.equal(afterFailed.usdc.toString(), before.usdc.toString());
    assert.equal(afterFailed.output.toString(), before.output.toString());
    assert.equal(afterFailed.liquidity.toString(), before.liquidity.toString());
    assert.equal(afterFailed.sink.toString(), before.sink.toString());
    assert.isTrue(afterFailed.portfolioData.equals(before.portfolioData), "failed transaction changed portfolio or leg state");
    assert.equal(afterFailed.state.deploymentLegs[0].status, 0);
    assert.equal(afterFailed.state.status, 2);
    const retrySignature = await deployMethod(rollback, 0).rpc();
    const afterRetry = await waitForConfirmedState(
      provider.connection,
      retrySignature,
      () => readLegSnapshot(rollback, 0, before.slot),
      (snapshot) => before.usdc - snapshot.usdc === amount
        && snapshot.output - before.output === amount
        && before.liquidity - snapshot.liquidity === amount
        && snapshot.sink - before.sink === amount
        && snapshot.state.deploymentLegs[0].status === 1
        && snapshot.state.status === 4,
      "atomic demo leg retry",
      { timeoutMs: 15_000 },
    );
    assert.equal(afterRetry.state.status, 4);
    await assertRejected(() => deployMethod(rollback, 0).rpc(), ["InvalidLifecycle", "DeploymentAlreadyCompleted"]);
    const afterActiveReplay = await readLegSnapshot(rollback, 0, afterRetry.slot);
    assert.equal(afterActiveReplay.usdc.toString(), afterRetry.usdc.toString());
    assert.equal(afterActiveReplay.output.toString(), afterRetry.output.toString());
    assert.equal(afterActiveReplay.liquidity.toString(), afterRetry.liquidity.toString());
    assert.equal(afterActiveReplay.sink.toString(), afterRetry.sink.toString());
    assert.equal(afterActiveReplay.state.status, 4);
    assert.equal(afterActiveReplay.state.deploymentLegs[0].status, 1);
    assert.isTrue(afterActiveReplay.portfolioData.equals(afterRetry.portfolioData), "ACTIVE replay changed portfolio or leg state");
  });
});
