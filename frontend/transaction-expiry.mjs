export class ApprovalExpiredError extends Error {
  constructor() {
    super("Approval took too long. Please approve the new transaction promptly.");
    this.name = "ApprovalExpiredError";
  }
}

export async function assertBlockhashActive(connection, lastValidBlockHeight) {
  const currentBlockHeight = await connection.getBlockHeight("processed");
  if (currentBlockHeight > lastValidBlockHeight) throw new ApprovalExpiredError();
  return currentBlockHeight;
}
