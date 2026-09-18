import assert from "node:assert/strict";
import test from "node:test";
import { CLAIM_AMOUNT, CLAIM_TYPE_SOL, CLAIM_TYPE_USDC, ClaimStore, FaucetError } from "./claim-store.mjs";

test("fixed 25-token policy and one concurrent reservation per wallet", () => {
  const store = new ClaimStore(":memory:");
  try {
    assert.equal(CLAIM_AMOUNT, 25_000_000n);
    const challenge = store.issueChallenge("wallet", 1000);
    assert.deepEqual(store.issueChallenge("wallet", 1001), challenge);
    assert.match(challenge.message, /Claim: 25 TEST-USDC to this wallet only/);
    store.reserveClaim("wallet", challenge.nonce, 1001);
    assert.throws(() => store.reserveClaim("wallet", challenge.nonce, 1002), (error) => error instanceof FaucetError && error.status === 409);
    store.markSubmitted("wallet", "signature", "blockhash", 200, 1003);
    store.markConfirmed("wallet", "signature", 1004);
    assert.equal(store.getClaim("wallet").status, "confirmed");
    assert.throws(() => store.issueChallenge("wallet", 1005), FaucetError);
  } finally { store.close(); }
});

test("expired approvals fail; unsuccessful reservations can be retried", () => {
  const store = new ClaimStore(":memory:");
  try {
    const old = store.issueChallenge("wallet", 0);
    assert.throws(() => store.reserveClaim("wallet", old.nonce, old.expiresAt + 1), FaucetError);
    const fresh = store.issueChallenge("wallet", 1_000_000);
    store.reserveClaim("wallet", fresh.nonce, 1_000_001);
    store.releaseReserved("wallet");
    assert.equal(store.getClaim("wallet"), null);
    assert.ok(store.issueChallenge("wallet", 1_000_002).nonce);
  } finally { store.close(); }
});

test("claim types are independent for the same wallet", () => {
  const store = new ClaimStore(":memory:");
  try {
    const usdc = store.issueChallenge("wallet", CLAIM_TYPE_USDC, 1000);
    const sol = store.issueChallenge("wallet", CLAIM_TYPE_SOL, 1000, "0.2 Devnet SOL");
    assert.match(usdc.message, /Asset: TEST-USDC/);
    assert.match(sol.message, /Claim: 0.2 Devnet SOL/);
    store.reserveClaim("wallet", usdc.nonce, CLAIM_TYPE_USDC, 1001);
    store.reserveClaim("wallet", sol.nonce, CLAIM_TYPE_SOL, 1001);
    assert.equal(store.getClaim("wallet", CLAIM_TYPE_USDC).status, "reserved");
    assert.equal(store.getClaim("wallet", CLAIM_TYPE_SOL).status, "reserved");
  } finally { store.close(); }
});
