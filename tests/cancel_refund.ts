import * as anchor from "@coral-xyz/anchor";
import { assert } from "chai";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  createAssociatedTokenAccount, createMint, getAccount, getAssociatedTokenAddressSync,
  mintTo, TOKEN_2022_PROGRAM_ID,
} from "@solana/spl-token";
import { Keypair, LAMPORTS_PER_SOL, PublicKey, SystemProgram, Transaction } from "@solana/web3.js";

describe("StockSplit cancellation and exact USDC refunds", () => {
  const env = anchor.AnchorProvider.env();
  const provider = new anchor.AnchorProvider(env.connection, env.wallet, {
    commitment: "confirmed", preflightCommitment: "confirmed",
  });
  anchor.setProvider(provider);
  const generatedIdl = JSON.parse(readFileSync(resolve(__dirname, "../target/idl/stock_split_phase0.json"), "utf8"));
  const program = new anchor.Program(generatedIdl, provider) as any;
  const creator = (provider.wallet as anchor.Wallet).payer;
  const bob = Keypair.generate();
  const outsider = Keypair.generate();
  let bobProgram: any;
  let usdc: PublicKey;
  let stockA: PublicKey;
  let stockB: PublicKey;
  let creatorAta: PublicKey;
  let bobAta: PublicKey;

  type Scenario = { portfolio: PublicKey; vault: PublicKey; memberCreator: PublicKey; memberBob: PublicKey; outputVaults: PublicKey[] };
  const pda = (seed: string, ...keys: PublicKey[]) => PublicKey.findProgramAddressSync(
    [Buffer.from(seed), ...keys.map((key) => key.toBuffer())], program.programId,
  )[0];
  const ata = (mint: PublicKey, owner: PublicKey) => getAssociatedTokenAddressSync(
    mint, owner, false, TOKEN_2022_PROGRAM_ID,
  );

  async function expectError(action: () => Promise<unknown>, code: string) {
    let actual: unknown;
    try { await action(); } catch (error) { actual = error; }
    assert.isDefined(actual, `Expected ${code} rejection`);
    const error = actual as {
      error?: { errorCode?: { code?: string; number?: number } };
      logs?: string[]; transactionError?: { logs?: string[] }; code?: number;
      getLogs?: (connection: typeof provider.connection) => Promise<string[]>;
    };
    let logs = error.logs ?? error.transactionError?.logs ?? [];
    if (!logs.length && typeof error.getLogs === "function") {
      try { logs = await error.getLogs(provider.connection); } catch { /* Simulation can have no signature. */ }
    }
    const details = [String(actual), ...logs].join("\n");
    let parsed = error.error?.errorCode?.code;
    if (!parsed) {
      parsed = /Error Code:\s*([A-Za-z][A-Za-z0-9_]*)/.exec(details)?.[1];
    }
    if (!parsed) {
      const custom = /custom program error:\s*(0x[0-9a-f]+|[0-9]+)/i.exec(details)?.[1];
      const number = error.error?.errorCode?.number ?? error.code ?? (custom ? Number(custom) : undefined);
      parsed = program.idl.errors?.find((entry: { code: number; name: string }) => entry.code === number)?.name;
    }
    assert.equal(parsed, code, `Expected ${code}, got ${parsed ?? "unparsed error"}. ${details}`);
  }

  async function makeScenario(id: number, basket = [{ mint: stockA, allocationBps: 10_000 }],
    target = 10_000_000n): Promise<Scenario> {
    const idBytes = Buffer.alloc(8);
    idBytes.writeBigUInt64LE(BigInt(id));
    const [canonicalPortfolio] = PublicKey.findProgramAddressSync(
      [Buffer.from("portfolio"), creator.publicKey.toBuffer(), idBytes], program.programId,
    );
    const vault = pda("vault", canonicalPortfolio, usdc);
    const outputVaults = basket.map((asset) => pda("vault", canonicalPortfolio, asset.mint));
    const now = Math.floor(Date.now() / 1000);
    await program.methods.createPortfolio(new anchor.BN(id), `Refund test ${id}`, "Cancellation fixture",
      new anchor.BN(now - 60), new anchor.BN(now + 3600), new anchor.BN(target.toString()), basket)
      .accounts({ creator: creator.publicKey, portfolio: canonicalPortfolio, usdcMint: usdc,
        tokenProgram: TOKEN_2022_PROGRAM_ID, systemProgram: SystemProgram.programId })
      .remainingAccounts(basket.map((asset) => ({ pubkey: asset.mint, isSigner: false, isWritable: false })))
      .rpc();
    for (const mint of [usdc, ...basket.map((asset) => asset.mint)]) {
      await program.methods.initializeVault().accounts({ payer: creator.publicKey, portfolio: canonicalPortfolio,
        mint, vault: pda("vault", canonicalPortfolio, mint), tokenProgram: TOKEN_2022_PROGRAM_ID,
        systemProgram: SystemProgram.programId }).rpc();
    }
    const memberCreator = pda("member", canonicalPortfolio, creator.publicKey);
    const memberBob = pda("member", canonicalPortfolio, bob.publicKey);
    for (const [wallet, member] of [[creator.publicKey, memberCreator], [bob.publicKey, memberBob]] as [PublicKey, PublicKey][]) {
      await program.methods.inviteMember().accounts({ creator: creator.publicKey, portfolio: canonicalPortfolio,
        wallet, member, systemProgram: SystemProgram.programId }).rpc();
    }
    return { portfolio: canonicalPortfolio, vault, memberCreator, memberBob, outputVaults };
  }

  async function contribute(s: Scenario, wallet: PublicKey, member: PublicKey, source: PublicKey, amount: bigint, signer?: Keypair) {
    const method = program.methods.contribute(new anchor.BN(amount.toString())).accounts({
      contributor: wallet, portfolio: s.portfolio, member, mint: usdc, sourceToken: source,
      vault: s.vault, tokenProgram: TOKEN_2022_PROGRAM_ID,
    });
    return (signer ? method.signers([signer]) : method).rpc();
  }

  const cancel = (s: Scenario) => program.methods.cancelPortfolio().accounts({
    creator: creator.publicKey, portfolio: s.portfolio,
  }).rpc();
  const refund = (client: any, s: Scenario, memberWallet: PublicKey, member: PublicKey,
    destination: PublicKey, overrides: { mint?: PublicKey; vault?: PublicKey } = {}) =>
    client.methods.refundMember().accounts({ memberWallet, portfolio: s.portfolio, member,
      usdcMint: overrides.mint ?? usdc, usdcVault: overrides.vault ?? s.vault,
      destinationToken: destination, tokenProgram: TOKEN_2022_PROGRAM_ID });
  const amount = async (account: PublicKey) => (await getAccount(provider.connection, account,
    "confirmed", TOKEN_2022_PROGRAM_ID)).amount;

  before(async () => {
    const airdrops = await Promise.all([bob, outsider].map((wallet) =>
      provider.connection.requestAirdrop(wallet.publicKey, LAMPORTS_PER_SOL)));
    for (const signature of airdrops) await provider.connection.confirmTransaction(signature, "confirmed");
    bobProgram = new anchor.Program(program.idl, new anchor.AnchorProvider(provider.connection,
      new anchor.Wallet(bob), { commitment: "confirmed", preflightCommitment: "confirmed" }));
    usdc = await createMint(provider.connection, creator, creator.publicKey, null, 6,
      Keypair.generate(), { commitment: "confirmed" }, TOKEN_2022_PROGRAM_ID);
    stockA = await createMint(provider.connection, creator, creator.publicKey, null, 6,
      Keypair.generate(), { commitment: "confirmed" }, TOKEN_2022_PROGRAM_ID);
    stockB = await createMint(provider.connection, creator, creator.publicKey, null, 6,
      Keypair.generate(), { commitment: "confirmed" }, TOKEN_2022_PROGRAM_ID);
    creatorAta = await createAssociatedTokenAccount(provider.connection, creator, usdc,
      creator.publicKey, { commitment: "confirmed" }, TOKEN_2022_PROGRAM_ID);
    bobAta = await createAssociatedTokenAccount(provider.connection, creator, usdc,
      bob.publicKey, { commitment: "confirmed" }, TOKEN_2022_PROGRAM_ID);
    for (const destination of [creatorAta, bobAta]) {
      await mintTo(provider.connection, creator, usdc, destination, creator, 50_000_000n,
        [], { commitment: "confirmed" }, TOKEN_2022_PROGRAM_ID);
    }
  });

  it("lets only the creator cancel a DRAFT portfolio and leaves it terminal", async () => {
    const s = await makeScenario(88001);
    await expectError(() => program.methods.cancelPortfolio().accounts({ creator: outsider.publicKey,
      portfolio: s.portfolio }).signers([outsider]).rpc(), "Unauthorized");
    await cancel(s);
    const state = await program.account.portfolio.fetch(s.portfolio);
    assert.equal(state.status, 6);
    assert.equal(state.totalUnits.toString(), "0");
    await expectError(() => program.methods.openFunding().accounts({ creator: creator.publicKey,
      portfolio: s.portfolio }).rpc(), "InvalidLifecycle");
  });

  it("allows exact independent refunds in FUNDING, excluding unsolicited vault surplus", async () => {
    const s = await makeScenario(88002);
    await program.methods.openFunding().accounts({ creator: creator.publicKey, portfolio: s.portfolio }).rpc();
    await contribute(s, creator.publicKey, s.memberCreator, creatorAta, 2_000_000n);
    await contribute(s, bob.publicKey, s.memberBob, bobAta, 3_000_000n, bob);
    await mintTo(provider.connection, creator, usdc, s.vault, creator, 1_000_000n,
      [], { commitment: "confirmed" }, TOKEN_2022_PROGRAM_ID);
    await cancel(s);
    const creatorBefore = await amount(creatorAta);
    const bobBefore = await amount(bobAta);
    await refund(bobProgram, s, bob.publicKey, s.memberBob, bobAta).rpc();
    assert.equal((await amount(bobAta) - bobBefore).toString(), "3000000");
    assert.equal((await amount(s.vault)).toString(), "3000000");
    const bobState = await program.account.member.fetch(s.memberBob);
    assert.equal(bobState.totalContributed.toString(), "0");
    assert.equal(bobState.ownershipUnits.toString(), "0");
    assert.equal(bobState.withdrawalStatus, 2);
    await expectError(() => refund(bobProgram, s, bob.publicKey, s.memberBob, bobAta).rpc(),
      "RefundAlreadyCompleted");
    await refund(program, s, creator.publicKey, s.memberCreator, creatorAta).rpc();
    assert.equal((await amount(creatorAta) - creatorBefore).toString(), "2000000");
    assert.equal((await amount(s.vault)).toString(), "1000000", "unsolicited surplus stays in vault");
    const state = await program.account.portfolio.fetch(s.portfolio);
    assert.equal(state.status, 6);
    assert.equal(state.totalUnits.toString(), "0");
    assert.equal(state.totalContributed.toString(), "0");
  });

  it("rejects wrong USDC mint, vault, and noncanonical destination", async () => {
    const s = await makeScenario(88003);
    const other = await makeScenario(88004);
    await program.methods.openFunding().accounts({ creator: creator.publicKey, portfolio: s.portfolio }).rpc();
    await contribute(s, bob.publicKey, s.memberBob, bobAta, 2_000_000n, bob);
    await cancel(s);
    await expectError(() => refund(bobProgram, s, bob.publicKey, s.memberBob, bobAta,
      { mint: stockA }).rpc(), "InvalidUsdcMint");
    await expectError(() => refund(bobProgram, s, bob.publicKey, s.memberBob, bobAta,
      { vault: other.vault }).rpc(), "ConstraintSeeds");
    const creatorStockAta = await createAssociatedTokenAccount(provider.connection, creator,
      stockA, creator.publicKey, { commitment: "confirmed" }, TOKEN_2022_PROGRAM_ID);
    await expectError(() => refund(bobProgram, s, bob.publicKey, s.memberBob,
      creatorStockAta).rpc(), "InvalidRefundDestination");
    assert.equal((await amount(s.vault)).toString(), "2000000");
  });

  it("rolls back a refund if a later instruction fails, then allows retry", async () => {
    const s = await makeScenario(88005);
    await program.methods.openFunding().accounts({ creator: creator.publicKey, portfolio: s.portfolio }).rpc();
    await contribute(s, bob.publicKey, s.memberBob, bobAta, 2_000_000n, bob);
    await cancel(s);
    const beforeVault = await amount(s.vault);
    const beforeBob = await amount(bobAta);
    const beforeMember = await program.account.member.fetch(s.memberBob);
    const beforePortfolio = await program.account.portfolio.fetch(s.portfolio);
    const ix = await refund(bobProgram, s, bob.publicKey, s.memberBob, bobAta).instruction();
    await expectError(() => bobProgram.provider.sendAndConfirm(new Transaction().add(ix, ix), []),
      "RefundAlreadyCompleted");
    assert.equal((await amount(s.vault)).toString(), beforeVault.toString());
    assert.equal((await amount(bobAta)).toString(), beforeBob.toString());
    const memberAfterFailure = await program.account.member.fetch(s.memberBob);
    const portfolioAfterFailure = await program.account.portfolio.fetch(s.portfolio);
    assert.equal(memberAfterFailure.totalContributed.toString(), beforeMember.totalContributed.toString());
    assert.equal(memberAfterFailure.withdrawalStatus, 0);
    assert.equal(portfolioAfterFailure.totalUnits.toString(), beforePortfolio.totalUnits.toString());
    await refund(bobProgram, s, bob.publicKey, s.memberBob, bobAta).rpc();
    assert.equal((await amount(s.vault)).toString(), "0");
    assert.equal((await amount(bobAta) - beforeBob).toString(), "2000000");
  });

  it("permits FUNDING_CLOSED cancellation before any leg", async () => {
    const s = await makeScenario(88006, undefined, 2_000_000n);
    await program.methods.openFunding().accounts({ creator: creator.publicKey, portfolio: s.portfolio }).rpc();
    await contribute(s, creator.publicKey, s.memberCreator, creatorAta, 2_000_000n);
    await program.methods.closeFunding().accounts({ creator: creator.publicKey, portfolio: s.portfolio }).rpc();
    await cancel(s);
    assert.equal((await program.account.portfolio.fetch(s.portfolio)).status, 6);
    await refund(program, s, creator.publicKey, s.memberCreator, creatorAta).rpc();
    assert.equal((await amount(s.vault)).toString(), "0");
  });

  it("forbids cancellation after even a zero-allocation deployment leg", async () => {
    const s = await makeScenario(88007, [
      { mint: stockA, allocationBps: 1 }, { mint: stockB, allocationBps: 9_999 },
    ], 1n);
    await program.methods.openFunding().accounts({ creator: creator.publicKey, portfolio: s.portfolio }).rpc();
    await contribute(s, creator.publicKey, s.memberCreator, creatorAta, 1n);
    await program.methods.closeFunding().accounts({ creator: creator.publicKey, portfolio: s.portfolio }).rpc();
    await program.methods.deployLeg(0, new anchor.BN(0), new anchor.BN(0), new anchor.BN(0), 0, Buffer.alloc(0))
      .accounts({ caller: creator.publicKey, portfolio: s.portfolio, inputMint: usdc, usdcVault: s.vault,
        outputMint: stockA, outputVault: s.outputVaults[0], tokenProgram: TOKEN_2022_PROGRAM_ID,
        outputTokenProgram: TOKEN_2022_PROGRAM_ID,
        jupiterProgram: new PublicKey("JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4") }).rpc();
    const state = await program.account.portfolio.fetch(s.portfolio);
    assert.equal(state.status, 3);
    assert.equal(state.deploymentLegs[0].status, 1);
    await expectError(() => cancel(s), "DeploymentAlreadyStarted");
    assert.equal((await program.account.portfolio.fetch(s.portfolio)).status, 3);
  });
});
