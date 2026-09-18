import assert from "node:assert/strict";
import test from "node:test";
import { compareMessageSemantics, selectWalletSignedTransaction, snapshotTransaction } from "./transaction-message.mjs";

const key = (value) => ({ toBase58: () => value });

function transaction(serializedByte = 1, signatureByte = 0) {
  return {
    message: {
      version: 0,
      header: {
        numRequiredSignatures: 1,
        numReadonlySignedAccounts: 0,
        numReadonlyUnsignedAccounts: 1,
      },
      recentBlockhash: "original-blockhash",
      staticAccountKeys: [key("connected-wallet"), key("stocksplit-program")],
      compiledInstructions: [{
        programIdIndex: 1,
        accountKeyIndexes: Uint8Array.from([0, 1]),
        data: Uint8Array.from([7, 8, 9]),
      }],
      addressTableLookups: [{
        accountKey: key("lookup-table"),
        writableIndexes: Uint8Array.from([2]),
        readonlyIndexes: Uint8Array.from([3]),
      }],
      serialize: () => Uint8Array.from([serializedByte]),
    },
    signatures: [new Uint8Array(64).fill(signatureByte)],
  };
}

test("accepts a new signed instance with identical semantics despite different serialization", () => {
  const before = snapshotTransaction(transaction(1, 0));
  const after = snapshotTransaction(transaction(2, 5));
  assert.notEqual(before.serializedMessage, after.serializedMessage);
  assert.notDeepEqual(before.signatures, after.signatures);
  assert.deepEqual(compareMessageSemantics(before, after), []);
});

test("captures a detached pre-sign snapshot even if the wallet mutates the original", () => {
  const original = transaction();
  const before = snapshotTransaction(original);
  original.message.compiledInstructions[0].data[0] = 99;
  assert.deepEqual(compareMessageSemantics(before, snapshotTransaction(original)), [
    "compiledInstructions[0].data",
  ]);
});

test("rejects each protected message field when it changes", () => {
  const before = snapshotTransaction(transaction());
  const cases = [
    ["version", (after) => { after.message.version = "legacy"; }],
    ["header.numRequiredSignatures", (after) => { after.message.header.numRequiredSignatures = 2; }],
    ["header.numReadonlySignedAccounts", (after) => { after.message.header.numReadonlySignedAccounts = 1; }],
    ["header.numReadonlyUnsignedAccounts", (after) => { after.message.header.numReadonlyUnsignedAccounts = 0; }],
    ["recentBlockhash", (after) => { after.message.recentBlockhash = "different-blockhash"; }],
    ["feePayer", (after) => { after.message.feePayer = "different-payer"; }],
    ["staticAccountKeys[0]", (after) => { after.message.staticAccountKeys[0] = "different-payer"; }],
    ["staticAccountKeys.length", (after) => { after.message.staticAccountKeys.push("new-account"); }],
    ["compiledInstructions[0].programIdIndex", (after) => { after.message.compiledInstructions[0].programIdIndex = 0; }],
    ["compiledInstructions[0].programId", (after) => { after.message.compiledInstructions[0].programId = "different-program"; }],
    ["compiledInstructions[0].accountKeyIndexes[0]", (after) => { after.message.compiledInstructions[0].accountKeyIndexes[0] = 1; }],
    ["compiledInstructions[0].data", (after) => { after.message.compiledInstructions[0].data = "00"; }],
    ["compiledInstructions.length", (after) => { after.message.compiledInstructions.push({}); }],
    ["addressTableLookups[0].accountKey", (after) => { after.message.addressTableLookups[0].accountKey = "different-table"; }],
    ["addressTableLookups[0].writableIndexes[0]", (after) => { after.message.addressTableLookups[0].writableIndexes[0] = 4; }],
    ["addressTableLookups[0].readonlyIndexes[0]", (after) => { after.message.addressTableLookups[0].readonlyIndexes[0] = 4; }],
    ["addressTableLookups.length", (after) => { after.message.addressTableLookups.push({}); }],
  ];

  for (const [field, mutate] of cases) {
    const after = structuredClone(before);
    mutate(after);
    assert.ok(compareMessageSemantics(before, after).includes(field), field);
  }
});

test("accepts a returned wallet-signed v0 transaction", () => {
  const supplied = transaction();
  const returned = transaction(1, 9);
  const selected = selectWalletSignedTransaction(snapshotTransaction(supplied), returned, supplied);
  assert.equal(selected.transaction, returned);
  assert.equal(selected.source, "returned");
});

test("accepts a wallet that signs the supplied instance but returns an unsigned copy", () => {
  const supplied = transaction();
  const before = snapshotTransaction(supplied);
  supplied.signatures[0].fill(7);
  const returned = transaction();
  const selected = selectWalletSignedTransaction(before, returned, supplied);
  assert.equal(selected.transaction, supplied);
  assert.equal(selected.source, "supplied");
});

test("never broadcasts an unsigned or message-mutated wallet result", () => {
  const supplied = transaction();
  const before = snapshotTransaction(supplied);
  assert.throws(() => selectWalletSignedTransaction(before, transaction(), supplied),
    (error) => error.code === "WALLET_SIGNATURE_MISSING");
  const changed = transaction(1, 7);
  changed.message.compiledInstructions[0].data[0] = 99;
  assert.throws(() => selectWalletSignedTransaction(before, changed, supplied), /message fields/);
});
