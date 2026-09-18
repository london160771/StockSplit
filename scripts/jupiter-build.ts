export type JupiterBuildAccount = {
  pubkey: string;
  isSigner: boolean;
  isWritable: boolean;
};

export type JupiterBuildInstruction = {
  programId: string;
  accounts: JupiterBuildAccount[];
  data: string;
};

export type JupiterBuildResponse = {
  taker?: string;
  inputMint: string;
  outputMint: string;
  inAmount: string;
  outAmount: string;
  otherAmountThreshold: string;
  slippageBps: number;
  routePlan: unknown[];
  swapInstruction: JupiterBuildInstruction;
};

export type PortfolioBuildRequest = {
  inputMint: string;
  outputMint: string;
  amount: string;
  portfolioPda: string;
  outputVault: string;
  slippageBps: number;
};

/**
 * Parameters for Jupiter's current /build endpoint. The taker and destination
 * are PDA-controlled accounts; no user ATA is used for the swap proof.
 */
export function portfolioBuildRequest(
  request: PortfolioBuildRequest,
): Record<string, string> {
  return {
    inputMint: request.inputMint,
    outputMint: request.outputMint,
    amount: request.amount,
    taker: request.portfolioPda,
    destinationTokenAccount: request.outputVault,
    slippageBps: String(request.slippageBps),
  };
}

/**
 * Rewrites the ordered RouteV2 account list returned by /build for CPI.
 *
 * The response is intentionally copied. Account order and privilege flags are
 * preserved, every generated source/output ATA occurrence in the swap
 * instruction is replaced by the matching portfolio vault.
 */
export function rewriteBuildForPortfolio(
  build: JupiterBuildResponse,
  portfolioPda: string,
  usdcVault: string,
  outputVault: string,
): JupiterBuildResponse {
  const swapAccounts = build.swapInstruction.accounts;
  if (swapAccounts.length < 3) {
    throw new Error("Jupiter swap instruction is missing fixed accounts");
  }
  if (swapAccounts[0].pubkey !== portfolioPda) {
    throw new Error("Jupiter build taker is not the portfolio PDA");
  }

  const generatedSourceAta = swapAccounts[1].pubkey;
  const generatedOutputAta = swapAccounts[2].pubkey;
  const rewritten: JupiterBuildResponse = JSON.parse(JSON.stringify(build));
  rewritten.taker = portfolioPda;

  rewritten.swapInstruction.accounts = rewritten.swapInstruction.accounts.map(
    (account) => ({
      ...account,
      pubkey:
        account.pubkey === generatedSourceAta
          ? usdcVault
          : account.pubkey === generatedOutputAta
            ? outputVault
            : account.pubkey,
      // Jupiter's outer signer bit is never trusted. The StockSplit program
      // restores signing only for the validated PDA authority inside CPI.
      isSigner: false,
    }),
  );
  return rewritten;
}
