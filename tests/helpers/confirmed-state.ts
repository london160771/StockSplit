import { Commitment, Connection } from "@solana/web3.js";

type WaitForOptions<T> = {
  commitment?: Commitment;
  intervalMs?: number;
  timeoutMs?: number;
  describe?: (value: T | undefined) => string;
};

function formatValue(value: unknown): string {
  try {
    return JSON.stringify(value, (_key, nestedValue) => {
      if (typeof nestedValue === "bigint") {
        return nestedValue.toString();
      }
      return nestedValue;
    }) ?? String(value);
  } catch {
    return String(value);
  }
}

/**
 * Confirm a state-changing transaction and wait for the requested account
 * snapshot to become visible at the same commitment. Read errors are allowed
 * to propagate; only a valid snapshot that does not yet satisfy `ready` is
 * retried.
 */
export async function waitForConfirmedState<T>(
  connection: Connection,
  signature: string,
  read: () => Promise<T>,
  ready: (value: T) => boolean,
  label: string,
  options: WaitForOptions<T> = {},
): Promise<T> {
  const commitment = options.commitment ?? "confirmed";
  const intervalMs = options.intervalMs ?? 75;
  const timeoutMs = options.timeoutMs ?? 5_000;

  const confirmation = await connection.confirmTransaction(signature, commitment);
  if (confirmation.value.err) {
    throw new Error(
      `${label}: transaction ${signature} failed at ${commitment}: ${formatValue(confirmation.value.err)}`,
    );
  }

  const deadline = Date.now() + timeoutMs;
  let last: T | undefined;
  while (true) {
    last = await read();
    if (ready(last)) {
      return last;
    }

    if (Date.now() >= deadline) {
      const observed = options.describe ? options.describe(last) : formatValue(last);
      throw new Error(
        `${label}: timed out after ${timeoutMs}ms waiting for confirmed state; last observed: ${observed}`,
      );
    }

    await new Promise<void>((resolve) => setTimeout(resolve, intervalMs));
  }
}
