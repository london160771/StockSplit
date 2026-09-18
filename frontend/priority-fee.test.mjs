import assert from "node:assert/strict";
import test from "node:test";
import {
  COMPLEX_COMPUTE_UNIT_LIMIT,
  DEFAULT_COMPUTE_UNIT_LIMIT,
  FALLBACK_PRIORITY_FEE_MICROLAMPORTS,
  MAX_PRIORITY_FEE_MICROLAMPORTS,
  choosePriorityFeeMicroLamports,
  priorityFeeForConnection,
  withComputeBudget,
} from "./priority-fee.mjs";

const key = (value) => ({ toBase58: () => value });
const computeBudgetProgram = {
  programId: key("compute-budget"),
  setComputeUnitLimit: ({ units }) => ({ kind: "limit", units, programId: key("compute-budget") }),
  setComputeUnitPrice: ({ microLamports }) => ({ kind: "price", microLamports, programId: key("compute-budget") }),
};

test("prepares both compute-budget instructions before application instructions", () => {
  const applicationInstruction = { kind: "application", programId: key("stocksplit") };
  const result = withComputeBudget(
    [applicationInstruction], computeBudgetProgram, DEFAULT_COMPUTE_UNIT_LIMIT, 1_200,
  );
  assert.deepEqual(result.map((instruction) => instruction.kind), ["limit", "price", "application"]);
  assert.equal(result[0].units, 400_000);
  assert.equal(result[1].microLamports, 1_200);
  assert.strictEqual(result[2], applicationInstruction);
});

test("selects a bounded buffered upper-quartile quote with a Devnet fallback", () => {
  assert.equal(choosePriorityFeeMicroLamports([]), FALLBACK_PRIORITY_FEE_MICROLAMPORTS);
  assert.equal(choosePriorityFeeMicroLamports([{ prioritizationFee: 0 }]), FALLBACK_PRIORITY_FEE_MICROLAMPORTS);
  assert.equal(choosePriorityFeeMicroLamports([100, 1_000, 2_000, 3_000].map(
    (prioritizationFee) => ({ prioritizationFee }),
  )), 2_400);
  assert.equal(choosePriorityFeeMicroLamports([{ prioritizationFee: 1_000_000 }]), MAX_PRIORITY_FEE_MICROLAMPORTS);
});

test("falls back when recent-fee RPC is unavailable", async () => {
  const fee = await priorityFeeForConnection({
    getRecentPrioritizationFees: async () => { throw new Error("RPC unavailable"); },
  });
  assert.equal(fee, FALLBACK_PRIORITY_FEE_MICROLAMPORTS);
});

test("rejects duplicate compute-budget instructions and excessive limits or prices", () => {
  const app = { kind: "application", programId: key("stocksplit") };
  assert.throws(() => withComputeBudget(
    [app, { kind: "duplicate", programId: key("compute-budget") }],
    computeBudgetProgram, DEFAULT_COMPUTE_UNIT_LIMIT, 1_000,
  ), /another compute-budget/);
  assert.throws(() => withComputeBudget(
    [app], computeBudgetProgram, COMPLEX_COMPUTE_UNIT_LIMIT + 1, 1_000,
  ), /Invalid compute-unit limit/);
  assert.throws(() => withComputeBudget(
    [app], computeBudgetProgram, DEFAULT_COMPUTE_UNIT_LIMIT, MAX_PRIORITY_FEE_MICROLAMPORTS + 1,
  ), /Invalid compute-unit price/);
});
