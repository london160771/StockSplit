import { FUNDING_ENDED_MESSAGE } from "./funding-deadline.mjs";
import { APPROVAL_EXPIRED_MESSAGE } from "./transaction-expiry.mjs";

export function isWithdrawalAlreadyCompletedError(error) {
  const raw = [error?.message, error?.logs?.join(" "), error?.code, error?.error?.errorCode?.code,
    error?.error?.errorCode?.number].filter((value) => value != null).join(" ");
  return /WithdrawalAlreadyCompleted|custom program error:\s*0x17a7|\b6055\b/i.test(raw);
}

export function isRefundAlreadyCompletedError(error) {
  const raw = [error?.message, error?.logs?.join(" "), error?.code, error?.error?.errorCode?.code,
    error?.error?.errorCode?.number].filter((value) => value != null).join(" ");
  return /RefundAlreadyCompleted|custom program error:\s*0x17a9|\b6057\b/i.test(raw);
}

export function friendlyActionError(error, action = "") {
  const raw = [error?.message, error?.logs?.join(" "), error?.code, error?.error?.errorCode?.code,
    error?.error?.errorCode?.number].filter((value) => value != null).join(" ");
  if (isWithdrawalAlreadyCompletedError(error)) return "You already withdrew from this portfolio.";
  if (isRefundAlreadyCompletedError(error)) return "You already claimed your refund from this portfolio.";
  if (/NoRefundAvailable|custom program error:\s*0x17aa|\b6058\b/i.test(raw)) return "This wallet has no recorded contribution left to refund.";
  if (/InsufficientRefundVaultBalance/i.test(raw)) return "The portfolio vault does not have enough USDC for this refund. Please contact the demo organizer.";
  if (/InvalidRefundDestination|InvalidUsdcMint|InvalidVault/i.test(raw) && /refund/i.test(action)) return "The refund accounts do not match this portfolio. Please refresh and try again.";
  if (/InvalidLifecycle|custom program error:\s*0x177c|\b6012\b/i.test(raw) && /refund/i.test(action)) return "This portfolio is not cancelled, so refunds are unavailable.";
  if (/InvalidLifecycle|DeploymentAlreadyStarted|custom program error:\s*0x177c|custom program error:\s*0x17a8|\b6012\b|\b6056\b/i.test(raw) && /cancel/i.test(action)) return "This portfolio cannot be cancelled after investment begins.";
  if (error?.code === "WALLET_SIGNATURE_MISSING") {
    return "Phantom did not sign this transaction with the selected Solana account. Check that this account supports v0 transactions, then approve again. Nothing was sent.";
  }
  if (/FundingWindowExpired|custom program error: 0x177e|\b6014\b/i.test(raw)) return FUNDING_ENDED_MESSAGE;
  if (/TargetExceeded/i.test(raw)) return "This contribution would exceed the portfolio target.";
  if (/UnauthorizedMember/i.test(raw)) return "This wallet is not invited to contribute to this portfolio.";
  if (/FundingNotOpen/i.test(raw)) return "Funding has not opened yet.";
  if (/Approval took too long|approval window expired/i.test(raw)) return APPROVAL_EXPIRED_MESSAGE;
  if (/Wallet changed transaction message|Network or wallet account changed/i.test(raw)) return "The wallet or network changed during approval. Review the transaction and try again.";
  if (/deploy|invest/i.test(action)) return "Investment could not be completed. Try again.";
  if (/simulation|Program log:|SendTransactionError|custom program error|logs:/i.test(raw)) return "Transaction could not be completed. Please try again.";
  return error?.message || "Transaction could not be completed. Please try again.";
}
