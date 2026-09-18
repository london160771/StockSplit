import { assert } from "chai";
import fixture from "./fixtures/jupiter-route-v2-usdc-nvdax-build.json";
import sharedFixture from "./fixtures/jupiter-v2-shared-accounts-route-build.json";
import {
  portfolioBuildRequest,
  rewriteBuildForPortfolio,
} from "../scripts/jupiter-build";

describe("StockSplit Phase 2 live Jupiter compatibility fixture", () => {
  it("is a current legacy-USDC to real Token-2022 NVDAx build", () => {
    assert.equal(fixture.inputMint, "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v");
    assert.equal(fixture.outputMint, "Xsc9qvGR1efVDFGLrVsmkzv3qi45LTBjeUKSPmx9qEh");
    assert.equal(fixture.swapInstruction.accounts.length, 26);
    assert.equal(fixture.swapInstruction.accounts[5].pubkey, "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
    assert.equal(fixture.swapInstruction.accounts[6].pubkey, "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb");
    assert.isAbove(fixture.swapInstruction.data.length, 0);
  });

  it("builds with the portfolio PDA and rewrites every generated source ATA occurrence", () => {
    const portfolioPda = fixture.taker!;
    const usdcVault = "11111111111111111111111111111111";
    const outputVault = "SysvarRent111111111111111111111111111111111";
    const sourceAta = fixture.swapInstruction.accounts[1].pubkey;
    const outputAta = fixture.swapInstruction.accounts[2].pubkey;
    const sourceOccurrences = fixture.swapInstruction.accounts.filter(
      (account) => account.pubkey === sourceAta,
    );
    const outputOccurrences = fixture.swapInstruction.accounts.filter(
      (account) => account.pubkey === outputAta,
    );
    const rewritten = rewriteBuildForPortfolio(
      fixture,
      portfolioPda,
      usdcVault,
      outputVault,
    );

    assert.equal(rewritten.taker, portfolioPda);
    assert.equal(rewritten.swapInstruction.accounts[0].pubkey, portfolioPda);
    assert.equal(rewritten.swapInstruction.accounts[2].pubkey, outputVault);
    assert.equal(
      rewritten.swapInstruction.accounts.filter((account) => account.pubkey === sourceAta).length,
      0,
    );
    assert.equal(
      rewritten.swapInstruction.accounts.filter((account) => account.pubkey === usdcVault).length,
      sourceOccurrences.length,
    );
    assert.equal(
      rewritten.swapInstruction.accounts.filter((account) => account.pubkey === outputVault).length,
      outputOccurrences.length,
    );
    assert.deepEqual(
      rewritten.swapInstruction.accounts.map((account) => account.isWritable),
      fixture.swapInstruction.accounts.map((account) => account.isWritable),
    );
    assert.isTrue(
      rewritten.swapInstruction.accounts.every((account) => !account.isSigner),
      "every outer Jupiter account meta must be non-signer",
    );
  });

  it("sets taker and destinationTokenAccount explicitly for /build", () => {
    const params = portfolioBuildRequest({
      inputMint: fixture.inputMint,
      outputMint: fixture.outputMint,
      amount: fixture.inAmount,
      portfolioPda: fixture.taker!,
      outputVault: "SysvarRent111111111111111111111111111111111",
      slippageBps: fixture.slippageBps,
    });
    assert.equal(params.taker, fixture.taker);
    assert.equal(params.destinationTokenAccount, "SysvarRent111111111111111111111111111111111");
    assert.equal(params.amount, fixture.inAmount);
  });

  it("keeps the SharedAccountsRouteV2 fixture on the verified discriminator", () => {
    const data = Buffer.from(sharedFixture.swapInstruction.data, "base64");
    assert.deepEqual(
      [...data.subarray(0, 8)],
      [209, 152, 83, 147, 124, 254, 216, 233],
    );
    assert.equal(
      sharedFixture.swapInstruction.fixedAccounts[0].pubkey,
      "2MFoS3MPtvyQ4Wh4M9pdfPjz6UhVoNbFbGJAskCPCj3h",
    );
  });
});
