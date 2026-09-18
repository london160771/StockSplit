import type { Connection } from "@solana/web3.js";

// Solana Devnet's genesis hash, read from the canonical Devnet RPC.
export const DEVNET_GENESIS_HASH = "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG";

export async function assertDevnetCluster(
  connection: Pick<Connection, "getGenesisHash">,
): Promise<void> {
  const genesisHash = await connection.getGenesisHash();
  if (genesisHash !== DEVNET_GENESIS_HASH) {
    throw new Error(`Refusing a Devnet-only operator action: unexpected cluster genesis hash ${genesisHash}.`);
  }
}
