export const DEFAULT_COMPUTE_UNIT_LIMIT = 400_000;
export const COMPLEX_COMPUTE_UNIT_LIMIT = 1_400_000;
export const FALLBACK_PRIORITY_FEE_MICROLAMPORTS = 1_000;
export const MAX_PRIORITY_FEE_MICROLAMPORTS = 5_000;

export function choosePriorityFeeMicroLamports(samples) {
  const fees = (Array.isArray(samples) ? samples : [])
    .map((sample) => sample?.prioritizationFee)
    .filter((fee) => Number.isSafeInteger(fee) && fee > 0)
    .sort((left, right) => left - right);
  if (!fees.length) return FALLBACK_PRIORITY_FEE_MICROLAMPORTS;

  const upperQuartile = fees[Math.floor((fees.length - 1) * 0.75)];
  return Math.min(
    MAX_PRIORITY_FEE_MICROLAMPORTS,
    Math.max(FALLBACK_PRIORITY_FEE_MICROLAMPORTS, Math.ceil(upperQuartile * 1.2)),
  );
}

export async function priorityFeeForConnection(connection) {
  try {
    return choosePriorityFeeMicroLamports(await connection.getRecentPrioritizationFees());
  } catch {
    return FALLBACK_PRIORITY_FEE_MICROLAMPORTS;
  }
}

export function withComputeBudget(instructions, computeBudgetProgram, computeUnitLimit, microLamports) {
  if (!Array.isArray(instructions) || !instructions.length) {
    throw new Error("Transaction has no application instructions");
  }
  if (!Number.isSafeInteger(computeUnitLimit)
      || computeUnitLimit <= 0
      || computeUnitLimit > COMPLEX_COMPUTE_UNIT_LIMIT) {
    throw new Error("Invalid compute-unit limit");
  }
  if (!Number.isSafeInteger(microLamports)
      || microLamports < 0
      || microLamports > MAX_PRIORITY_FEE_MICROLAMPORTS) {
    throw new Error("Invalid compute-unit price");
  }
  const budgetProgramId = computeBudgetProgram.programId.toBase58();
  if (instructions.some((instruction) => instruction.programId.toBase58() === budgetProgramId)) {
    throw new Error("Application instructions must not include another compute-budget instruction");
  }

  return [
    computeBudgetProgram.setComputeUnitLimit({ units: computeUnitLimit }),
    computeBudgetProgram.setComputeUnitPrice({ microLamports }),
    ...instructions,
  ];
}
