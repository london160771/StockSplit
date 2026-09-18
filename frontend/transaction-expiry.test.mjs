import assert from "node:assert/strict";
import test from "node:test";
import { ApprovalExpiredError, assertBlockhashActive } from "./transaction-expiry.mjs";

test("a blockhash remains usable at its last valid block height", async () => {
  const calls = [];
  const connection = {
    getBlockHeight: async (commitment) => { calls.push(commitment); return 100; },
  };
  assert.equal(await assertBlockhashActive(connection, 100), 100);
  assert.deepEqual(calls, ["processed"]);
});

test("an expired approval is rejected before simulation or broadcast", async () => {
  const connection = { getBlockHeight: async () => 101 };
  await assert.rejects(() => assertBlockhashActive(connection, 100), (error) => {
    assert.ok(error instanceof ApprovalExpiredError);
    assert.equal(error.message, "Approval took too long. Please approve the new transaction promptly.");
    return true;
  });
});
