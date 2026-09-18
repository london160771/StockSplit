export const APPROVAL_EXPIRED_MESSAGE = "The approval window expired. A fresh transaction has been prepared — please approve it again.";

export class ApprovalExpiredError extends Error {
  constructor() {
    super(APPROVAL_EXPIRED_MESSAGE);
    this.name = "ApprovalExpiredError";
  }
}

export async function assertBlockhashActive(connection, lastValidBlockHeight) {
  const currentBlockHeight = await connection.getBlockHeight("confirmed");
  if (currentBlockHeight > lastValidBlockHeight) throw new ApprovalExpiredError();
  return currentBlockHeight;
}

export async function runWithFreshBlockhashRetry(
  connection,
  buildTransaction,
  approveAndSend,
  { maxRetries = 1 } = {},
) {
  let retryCount = 0;
  while (true) {
    const latest = await connection.getLatestBlockhash("confirmed");
    const transaction = buildTransaction(latest);
    if (!transaction) throw new Error("Transaction was not constructed");
    try {
      return await approveAndSend(transaction, latest);
    } catch (error) {
      if (!(error instanceof ApprovalExpiredError) || retryCount >= maxRetries) throw error;
      retryCount += 1;
    }
  }
}
