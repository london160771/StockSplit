import assert from "node:assert/strict";
import test from "node:test";
import { APPROVAL_EXPIRED_MESSAGE, ApprovalExpiredError, assertBlockhashActive, runWithFreshBlockhashRetry } from "./transaction-expiry.mjs";

test("a blockhash remains usable at its last valid block height", async () => {
  const calls = [];
  const connection = {
    getBlockHeight: async (commitment) => { calls.push(commitment); return 100; },
  };
  assert.equal(await assertBlockhashActive(connection, 100), 100);
  assert.deepEqual(calls, ["confirmed"]);
});

test("an expired approval is rejected before simulation or broadcast", async () => {
  const connection = { getBlockHeight: async () => 101 };
  await assert.rejects(() => assertBlockhashActive(connection, 100), (error) => {
    assert.ok(error instanceof ApprovalExpiredError);
    assert.equal(error.message, APPROVAL_EXPIRED_MESSAGE);
    return true;
  });
});

test("approval within the blockhash window succeeds without rebuilding", async () => {
  const builds = [];
  const approvals = [];
  const connection = {
    getLatestBlockhash: async (commitment) => {
      assert.equal(commitment, "confirmed");
      return { blockhash: "fresh-1", lastValidBlockHeight: 200 };
    },
  };
  const result = await runWithFreshBlockhashRetry(
    connection,
    (latest) => { builds.push(latest.blockhash); return { recentBlockhash: latest.blockhash }; },
    async (transaction) => { approvals.push(transaction.recentBlockhash); return "signature-1"; },
  );
  assert.equal(result, "signature-1");
  assert.deepEqual(builds, ["fresh-1"]);
  assert.deepEqual(approvals, ["fresh-1"]);
});

test("stale approval rebuilds with a fresh blockhash and requires approval again", async () => {
  const blockhashes = [
    { blockhash: "stale-1", lastValidBlockHeight: 100 },
    { blockhash: "fresh-2", lastValidBlockHeight: 250 },
  ];
  const builds = [];
  const walletApprovals = [];
  let sends = 0;
  const connection = {
    getLatestBlockhash: async (commitment) => {
      assert.equal(commitment, "confirmed");
      return blockhashes.shift();
    },
  };
  const result = await runWithFreshBlockhashRetry(
    connection,
    (latest) => { builds.push(latest.blockhash); return { recentBlockhash: latest.blockhash }; },
    async (transaction) => {
      walletApprovals.push(transaction.recentBlockhash);
      if (walletApprovals.length === 1) throw new ApprovalExpiredError();
      sends += 1;
      return "signature-2";
    },
  );
  assert.equal(result, "signature-2");
  assert.deepEqual(builds, ["stale-1", "fresh-2"]);
  assert.deepEqual(walletApprovals, ["stale-1", "fresh-2"]);
  assert.equal(sends, 1);
});

test("sendRawTransaction BlockhashNotFound is not retried", async () => {
  let builds = 0;
  let approvals = 0;
  let sends = 0;
  const connection = {
    getLatestBlockhash: async () => ({ blockhash: `block-${++builds}`, lastValidBlockHeight: 100 }),
  };
  await assert.rejects(() => runWithFreshBlockhashRetry(
    connection,
    (latest) => ({ recentBlockhash: latest.blockhash }),
    async () => {
      approvals += 1;
      sends += 1;
      throw new Error("BlockhashNotFound during broadcast");
    },
  ), /BlockhashNotFound/);
  assert.equal(builds, 1);
  assert.equal(approvals, 1);
  assert.equal(sends, 1);
});

test("generic send error is not retried", async () => {
  let builds = 0;
  let approvals = 0;
  let sends = 0;
  const connection = {
    getLatestBlockhash: async () => ({ blockhash: `block-${++builds}`, lastValidBlockHeight: 100 }),
  };
  await assert.rejects(() => runWithFreshBlockhashRetry(
    connection,
    (latest) => ({ recentBlockhash: latest.blockhash }),
    async () => {
      approvals += 1;
      sends += 1;
      throw new Error("RPC timeout during broadcast");
    },
  ), /RPC timeout/);
  assert.equal(builds, 1);
  assert.equal(approvals, 1);
  assert.equal(sends, 1);
});

test("confirmation error is not retried", async () => {
  let builds = 0;
  let approvals = 0;
  let sends = 0;
  const connection = {
    getLatestBlockhash: async () => ({ blockhash: `block-${++builds}`, lastValidBlockHeight: 100 }),
  };
  await assert.rejects(() => runWithFreshBlockhashRetry(
    connection,
    (latest) => ({ recentBlockhash: latest.blockhash }),
    async () => {
      approvals += 1;
      sends += 1;
      throw new Error("Transaction confirmation failed");
    },
  ), /confirmation failed/);
  assert.equal(builds, 1);
  assert.equal(approvals, 1);
  assert.equal(sends, 1);
});

test("a second stale approval stops without another execution attempt", async () => {
  let latestCall = 0;
  let walletApprovals = 0;
  let sends = 0;
  const connection = {
    getLatestBlockhash: async () => ({ blockhash: `block-${++latestCall}`, lastValidBlockHeight: 100 + latestCall }),
  };
  await assert.rejects(() => runWithFreshBlockhashRetry(
    connection,
    (latest) => ({ recentBlockhash: latest.blockhash }),
    async () => {
      walletApprovals += 1;
      throw new ApprovalExpiredError();
    },
  ), (error) => error instanceof ApprovalExpiredError);
  assert.equal(walletApprovals, 2);
  assert.equal(sends, 0);
});
