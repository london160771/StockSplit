import { strict as assert } from "node:assert";
import { test } from "node:test";
import { assertDevnetCluster, DEVNET_GENESIS_HASH } from "./devnet-cluster";

test("operator guard accepts only the pinned Devnet genesis hash", async () => {
  await assert.doesNotReject(() => assertDevnetCluster({ getGenesisHash: async () => DEVNET_GENESIS_HASH }));
  for (const hash of [
    "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp", // deliberately not Devnet
    "local-test-genesis",
  ]) {
    await assert.rejects(() => assertDevnetCluster({ getGenesisHash: async () => hash }), /unexpected cluster genesis hash/);
  }
});

test("operator guard fails closed when RPC cannot provide cluster identity", async () => {
  await assert.rejects(() => assertDevnetCluster({ getGenesisHash: async () => { throw new Error("RPC unavailable"); } }), /RPC unavailable/);
});
