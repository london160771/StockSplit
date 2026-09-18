function bytes(value) {
  return Array.from(value || []);
}

function hex(value) {
  return bytes(value).map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function keyString(value) {
  if (!value || typeof value.toBase58 !== "function") {
    throw new Error("Transaction message contains an invalid public key");
  }
  return value.toBase58();
}

export function snapshotTransaction(transaction) {
  const message = transaction?.message;
  if (!message?.header || !Array.isArray(message.staticAccountKeys)
      || !Array.isArray(message.compiledInstructions)
      || !Array.isArray(message.addressTableLookups)
      || typeof message.serialize !== "function"
      || !Array.isArray(transaction.signatures)) {
    throw new Error("Wallet returned an invalid versioned transaction");
  }

  return {
    message: {
      version: message.version,
      header: {
        numRequiredSignatures: message.header.numRequiredSignatures,
        numReadonlySignedAccounts: message.header.numReadonlySignedAccounts,
        numReadonlyUnsignedAccounts: message.header.numReadonlyUnsignedAccounts,
      },
      recentBlockhash: message.recentBlockhash,
      feePayer: keyString(message.staticAccountKeys[0]),
      staticAccountKeys: message.staticAccountKeys.map(keyString),
      compiledInstructions: message.compiledInstructions.map((instruction) => ({
        programIdIndex: instruction.programIdIndex,
        programId: keyString(message.staticAccountKeys[instruction.programIdIndex]),
        accountKeyIndexes: bytes(instruction.accountKeyIndexes),
        data: hex(instruction.data),
      })),
      addressTableLookups: message.addressTableLookups.map((lookup) => ({
        accountKey: keyString(lookup.accountKey),
        writableIndexes: bytes(lookup.writableIndexes),
        readonlyIndexes: bytes(lookup.readonlyIndexes),
      })),
    },
    signatures: transaction.signatures.map(hex),
    serializedMessage: hex(message.serialize()),
  };
}

function compareArray(before, after, path, differences) {
  if (before.length !== after.length) {
    differences.push(`${path}.length`);
  }
  for (let index = 0; index < Math.min(before.length, after.length); index++) {
    if (before[index] !== after[index]) differences.push(`${path}[${index}]`);
  }
}

export function compareMessageSemantics(before, after) {
  const differences = [];
  const a = before.message;
  const b = after.message;

  if (a.version !== b.version) differences.push("version");
  for (const field of ["numRequiredSignatures", "numReadonlySignedAccounts", "numReadonlyUnsignedAccounts"]) {
    if (a.header[field] !== b.header[field]) differences.push(`header.${field}`);
  }
  if (a.recentBlockhash !== b.recentBlockhash) differences.push("recentBlockhash");
  if (a.feePayer !== b.feePayer) differences.push("feePayer");
  compareArray(a.staticAccountKeys, b.staticAccountKeys, "staticAccountKeys", differences);

  if (a.compiledInstructions.length !== b.compiledInstructions.length) {
    differences.push("compiledInstructions.length");
  }
  for (let index = 0; index < Math.min(a.compiledInstructions.length, b.compiledInstructions.length); index++) {
    const original = a.compiledInstructions[index];
    const signed = b.compiledInstructions[index];
    if (original.programIdIndex !== signed.programIdIndex) {
      differences.push(`compiledInstructions[${index}].programIdIndex`);
    }
    if (original.programId !== signed.programId) {
      differences.push(`compiledInstructions[${index}].programId`);
    }
    compareArray(original.accountKeyIndexes, signed.accountKeyIndexes,
      `compiledInstructions[${index}].accountKeyIndexes`, differences);
    if (original.data !== signed.data) differences.push(`compiledInstructions[${index}].data`);
  }

  if (a.addressTableLookups.length !== b.addressTableLookups.length) {
    differences.push("addressTableLookups.length");
  }
  for (let index = 0; index < Math.min(a.addressTableLookups.length, b.addressTableLookups.length); index++) {
    const original = a.addressTableLookups[index];
    const signed = b.addressTableLookups[index];
    if (original.accountKey !== signed.accountKey) {
      differences.push(`addressTableLookups[${index}].accountKey`);
    }
    compareArray(original.writableIndexes, signed.writableIndexes,
      `addressTableLookups[${index}].writableIndexes`, differences);
    compareArray(original.readonlyIndexes, signed.readonlyIndexes,
      `addressTableLookups[${index}].readonlyIndexes`, differences);
  }

  return differences;
}

function hasWalletSignature(transaction) {
  const signature = transaction?.signatures?.[0];
  return signature?.length === 64 && signature.some((byte) => byte !== 0);
}

// Injected wallets may return a new transaction or sign the supplied instance.
// Both paths must preserve the complete compiled message before we broadcast.
export function selectWalletSignedTransaction(unsigned, returned, supplied) {
  const returnedSnapshot = snapshotTransaction(returned);
  const differences = compareMessageSemantics(unsigned, returnedSnapshot);
  if (differences.length) {
    throw new Error(`Wallet changed transaction message fields: ${differences.join(", ")}`);
  }
  if (returnedSnapshot.message.header.numRequiredSignatures !== 1 || returned.signatures.length !== 1) {
    throw new Error("This transaction requires an unexpected signer. Nothing was sent.");
  }
  if (hasWalletSignature(returned)) return { transaction: returned, source: "returned" };

  const suppliedSnapshot = snapshotTransaction(supplied);
  const suppliedDifferences = compareMessageSemantics(unsigned, suppliedSnapshot);
  if (suppliedDifferences.length) {
    throw new Error(`Wallet changed transaction message fields: ${suppliedDifferences.join(", ")}`);
  }
  if (supplied.signatures.length === 1 && hasWalletSignature(supplied)) {
    return { transaction: supplied, source: "supplied" };
  }
  const error = new Error("The connected wallet did not sign this v0 transaction. Nothing was sent.");
  error.code = "WALLET_SIGNATURE_MISSING";
  throw error;
}
