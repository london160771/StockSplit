import { createHash } from "node:crypto";
import type { Connection } from "@solana/web3.js";
import { PublicKey } from "@solana/web3.js";

export type LiveProofBinding = {
  /** Exact base64 bytes passed to deploy_leg. */
  swapInstructionData: string;
  /** Exact ordered Jupiter account metas after source/destination rewriting. */
  accounts: Array<{
    pubkey: string;
    isWritable: boolean;
    isSigner?: boolean;
  }>;
  approvedInputAmount: string;
  quotedOutput: string;
  minimumOutput: string;
  slippageBps: number;
};

/**
 * Hashes only stable execution authorization data. Recent blockhashes are
 * intentionally excluded so a transaction can be rebuilt after simulation.
 */
export function computeLiveProofBindingHash(
  binding: LiveProofBinding,
): string {
  const canonical = JSON.stringify({
    swapInstructionData: binding.swapInstructionData,
    accounts: binding.accounts.map((account) => ({
      pubkey: account.pubkey,
      isWritable: account.isWritable,
      isSigner: Boolean(account.isSigner),
    })),
    approvedInputAmount: binding.approvedInputAmount,
    quotedOutput: binding.quotedOutput,
    minimumOutput: binding.minimumOutput,
    slippageBps: binding.slippageBps,
  });

  return createHash("sha256").update(canonical, "utf8").digest("hex");
}

/**
 * Mainnet is an explicit execution gate. This function never deploys or
 * upgrades a program; it only verifies that the configured program account is
 * present and executable on the already-selected mainnet RPC.
 */
export async function assertMainnetProgramDeployed(
  connection: Connection,
  programId: PublicKey | string,
  network: string,
): Promise<void> {
  if (network !== "mainnet-beta") {
    throw new Error(
      `ABORT: live proof requires NETWORK=mainnet-beta; received ${network}`,
    );
  }

  const resolvedProgramId =
    typeof programId === "string" ? new PublicKey(programId) : programId;
  const account = await connection.getAccountInfo(
    resolvedProgramId,
    "confirmed",
  );

  if (!account) {
    throw new Error(
      `ABORT: configured PROGRAM_ID ${resolvedProgramId.toBase58()} does not exist on mainnet`,
    );
  }
  if (!account.executable) {
    throw new Error(
      `ABORT: configured PROGRAM_ID ${resolvedProgramId.toBase58()} exists but is not executable`,
    );
  }

  console.warn(
    "WARNING: mainnet proof requires this executable to have been deployed from the exact 30/30-tested binary using a fresh deployment keypair stored outside the repository and OneDrive. No deployment is performed automatically.",
  );
}
