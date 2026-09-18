import { readFile } from "node:fs/promises";

const expected = "9nLrXyjgLTwMxnyBJ2GnKqnHZiu5koYNHrpKXezVGDmm";
const path = process.env.PROGRAM_KEYPAIR;

if (!path) {
  throw new Error("Set PROGRAM_KEYPAIR to the deployment keypair path");
}

const bytes = JSON.parse(await readFile(path, "utf8"));
if (
  !Array.isArray(bytes) ||
  bytes.length !== 64 ||
  bytes.some((value) => !Number.isInteger(value) || value < 0 || value > 255)
) {
  throw new Error("PROGRAM_KEYPAIR must be a Solana 64-byte keypair JSON file");
}

const alphabet = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
let value = 0n;
for (const byte of bytes.slice(32)) {
  value = value * 256n + BigInt(byte);
}

let publicKey = "";
while (value > 0n) {
  publicKey = alphabet[Number(value % 58n)] + publicKey;
  value /= 58n;
}
for (const byte of bytes.slice(32)) {
  if (byte !== 0) break;
  publicKey = `1${publicKey}`;
}

if (publicKey !== expected) {
  throw new Error(`PROGRAM_KEYPAIR resolves to ${publicKey}, expected ${expected}`);
}

console.log(`program identity verified: ${publicKey}`);
