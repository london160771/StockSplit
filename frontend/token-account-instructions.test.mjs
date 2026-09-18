import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import test from "node:test";
import { createWalletAtaInstruction } from "./token-account-instructions.mjs";

test("ATA creation makes the connected wallet the sole signer, never the destination ATA", () => {
  const wallet = { address: "connected-member" };
  const associatedToken = { address: "member-token-account" };
  const mint = { address: "mint" };
  const tokenProgram = { address: "token-program" };
  const associatedTokenProgram = { address: "ata-program" };
  const instruction = createWalletAtaInstruction(
    (payer, ata, owner, assetMint, program, ataProgram) => ({
      payer, ata, owner, assetMint, program, ataProgram,
      keys: [{ pubkey: payer, isSigner: true }, { pubkey: ata, isSigner: false }],
    }),
    wallet, associatedToken, mint, tokenProgram, associatedTokenProgram,
  );
  assert.equal(instruction.payer, wallet);
  assert.equal(instruction.ata, associatedToken);
  assert.equal(instruction.owner, wallet);
  assert.equal(instruction.assetMint, mint);
  assert.equal(instruction.program, tokenProgram);
  assert.equal(instruction.ataProgram, associatedTokenProgram);
  assert.deepEqual(instruction.keys.filter((key) => key.isSigner).map((key) => key.pubkey), [wallet]);
});

test("WithdrawMember IDL requires only the member wallet signature", () => {
  const idl = JSON.parse(readFileSync(new URL("../target/idl/stock_split_phase0.json", import.meta.url), "utf8"));
  const instruction = idl.instructions.find((item) => item.name === "withdraw_member");
  assert.ok(instruction);
  assert.deepEqual(instruction.accounts.filter((account) => account.signer).map((account) => account.name), ["member_wallet"]);
});

test("Cancel and Refund IDL require only their respective initiating wallets", () => {
  const idl = JSON.parse(readFileSync(new URL("../target/idl/stock_split_phase0.json", import.meta.url), "utf8"));
  const cancel = idl.instructions.find((item) => item.name === "cancel_portfolio");
  const refund = idl.instructions.find((item) => item.name === "refund_member");
  assert.ok(cancel);
  assert.ok(refund);
  assert.deepEqual(cancel.accounts.filter((account) => account.signer).map((account) => account.name), ["creator"]);
  assert.deepEqual(refund.accounts.filter((account) => account.signer).map((account) => account.name), ["member_wallet"]);
  assert.equal(idl.address, "9nLrXyjgLTwMxnyBJ2GnKqnHZiu5koYNHrpKXezVGDmm");
});

test("generated Cancel and Refund discriminators match Anchor and frontend IDL bytes", () => {
  const generated = readFileSync(new URL("../target/idl/stock_split_phase0.json", import.meta.url));
  const frontend = readFileSync(new URL("./dist/stock_split_phase0.json", import.meta.url));
  assert.deepEqual(frontend, generated, "frontend must serve the exact generated IDL");
  const idl = JSON.parse(generated.toString("utf8"));
  for (const name of ["cancel_portfolio", "refund_member"]) {
    const instruction = idl.instructions.find((item) => item.name === name);
    assert.ok(instruction, `generated IDL must include ${name}`);
    const canonical = [...createHash("sha256").update(`global:${name}`).digest().subarray(0, 8)];
    assert.deepEqual(instruction.discriminator, canonical, `${name} must use its canonical Anchor discriminator`);
  }
});
