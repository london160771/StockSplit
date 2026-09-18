import assert from "node:assert/strict";
import test from "node:test";
import { connectInjectedWallet, createWalletEventRegistry, injectedSolanaWallet } from "./wallet-session.mjs";

test("trusted reconnect uses onlyIfTrusted and returns the authorized account", async () => {
  const calls = [];
  const publicKey = { toBase58: () => "trusted-wallet" };
  const provider = {
    isPhantom: true,
    publicKey,
    connect: async (...args) => { calls.push(args); return { publicKey }; },
  };
  const result = await connectInjectedWallet(provider, { onlyIfTrusted: true });
  assert.equal(result, publicKey);
  assert.deepEqual(calls, [[{ onlyIfTrusted: true }]]);
});

test("trusted reconnect failure stays a normal rejected promise", async () => {
  const provider = { connect: async () => { throw new Error("User has not approved this site"); } };
  await assert.rejects(() => connectInjectedWallet(provider, { onlyIfTrusted: true }), /not approved/);
});

test("manual connection does not pass a trusted-reconnect option", async () => {
  const calls = [];
  const provider = { connect: async (...args) => { calls.push(args); return { publicKey: "manual-wallet" }; } };
  await connectInjectedWallet(provider);
  assert.deepEqual(calls, [[]]);
});

test("injected provider discovery and trusted refresh use the same Phantom provider", async () => {
  const provider = { isPhantom: true, connect: async () => ({ publicKey: "trusted-wallet" }) };
  assert.equal(injectedSolanaWallet({ phantom: { solana: provider } }), provider);
  assert.equal(injectedSolanaWallet({ phantom: { solana: { isPhantom: false } } }), null);
  assert.equal(await connectInjectedWallet(provider, { onlyIfTrusted: true }), "trusted-wallet");
});

test("wallet listeners are registered once per provider", () => {
  const registrations = [];
  const provider = { on: (eventName, handler) => registrations.push([eventName, handler]) };
  const registry = createWalletEventRegistry();
  const handlers = {
    accountChanged: () => {},
    networkChanged: () => {},
    chainChanged: () => {},
  };
  assert.equal(registry.attach(provider, handlers), true);
  assert.equal(registry.attach(provider, handlers), false);
  assert.deepEqual(registrations.map(([eventName]) => eventName), ["accountChanged", "networkChanged", "chainChanged"]);
});
