import { createPublicKey, verify } from "node:crypto";

const ED25519_SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex");

export function verifyClaimSignature(walletBytes, message, encodedSignature) {
  if (!(walletBytes instanceof Uint8Array) || walletBytes.length !== 32 || typeof encodedSignature !== "string") return false;
  const signature = Buffer.from(encodedSignature, "base64");
  if (signature.length !== 64 || signature.toString("base64") !== encodedSignature) return false;
  const key = createPublicKey({
    key: Buffer.concat([ED25519_SPKI_PREFIX, Buffer.from(walletBytes)]),
    format: "der",
    type: "spki",
  });
  return verify(null, Buffer.from(message, "utf8"), key, signature);
}
