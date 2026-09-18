import assert from "node:assert/strict";
import { generateKeyPairSync, sign } from "node:crypto";
import test from "node:test";
import { verifyClaimSignature } from "./auth.mjs";

test("only the holder of the claimant wallet key can authorize its exact challenge", () => {
  const wallet = generateKeyPairSync("ed25519");
  const other = generateKeyPairSync("ed25519");
  const walletBytes = wallet.publicKey.export({ format: "der", type: "spki" }).subarray(-32);
  const message = "StockSplit Devnet Demo Funds\nWallet: claimant\nClaim: 25 TEST-USDC";
  const signature = sign(null, Buffer.from(message), wallet.privateKey).toString("base64");
  const wrongSignature = sign(null, Buffer.from(message), other.privateKey).toString("base64");
  assert.equal(verifyClaimSignature(walletBytes, message, signature), true);
  assert.equal(verifyClaimSignature(walletBytes, `${message}\nchanged`, signature), false);
  assert.equal(verifyClaimSignature(walletBytes, message, wrongSignature), false);
  assert.equal(verifyClaimSignature(walletBytes, message, "bad"), false);
});
