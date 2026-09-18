import { publicKeyEquals, publicKeyText } from "./public-key-utils.mjs";

const STATUS_NAMES = ["DRAFT", "FUNDING", "FUNDING_CLOSED", "DEPLOYING", "ACTIVE", "CLOSED", "CANCELLED"];

export function isCanonicalVault(account, mint, portfolio) {
  return Boolean(account && publicKeyEquals(account.mint, mint) && publicKeyEquals(account.owner, portfolio));
}

export function allVaultsReady(vaults, basketLength) {
  return vaults.length === basketLength + 1 && vaults.every((vault) => vault.initialized);
}

export function portfolioInviteUrl(currentUrl, portfolioAddress) {
  const url = new URL(currentUrl);
  url.search = "";
  url.hash = "";
  url.searchParams.set("portfolio", portfolioAddress);
  return url.toString();
}

export function memberHasWithdrawn(member) {
  return Boolean(member && (Number(member.withdrawalStatus) !== 0
    || BigInt(member.ownershipUnits?.toString?.() ?? "0") === 0n));
}

export function memberClaimRaw(vaultBalance, memberUnits, totalUnits) {
  const units = BigInt(memberUnits?.toString?.() ?? "0");
  const total = BigInt(totalUnits?.toString?.() ?? "0");
  if (units <= 0n || total <= 0n) return 0n;
  return BigInt(vaultBalance) * units / total;
}

export function cancelPortfolioDiagnostics(portfolio, wallet) {
  const legsPresent = Array.isArray(portfolio?.deploymentLegs);
  const legs = legsPresent ? portfolio.deploymentLegs : [];
  const rawStatus = portfolio?.status ?? null;
  const mappedStatus = rawStatus === null ? "UNKNOWN" : STATUS_NAMES[Number(rawStatus)] || "UNKNOWN";
  let reason = null;

  if (!portfolio) reason = "portfolio state is missing";
  else if (!wallet) reason = "connected wallet is missing";
  else if (!publicKeyEquals(portfolio.creator, wallet)) reason = "connected wallet is not the portfolio creator";
  else if (!portfolio.usdcMint) reason = "portfolio contribution mint is missing";
  else if (portfolio.usdcMint?.toBase58?.() === "11111111111111111111111111111111") reason = "portfolio contribution mint is invalid";
  else if (![0, 1, 2].includes(Number(rawStatus))) reason = `portfolio status is ${mappedStatus}`;
  else if (legs.some((leg) => Number(leg?.status) !== 0)) reason = "a deployment leg has executed or is not pending";

  return {
    allowed: reason === null,
    reason,
    portfolio: publicKeyText(portfolio?.publicKey),
    creator: publicKeyText(portfolio?.creator),
    connectedWallet: publicKeyText(wallet),
    rawStatus,
    mappedStatus,
    basketLength: Array.isArray(portfolio?.basket) ? portfolio.basket.length : null,
    deploymentLegCount: legs.length,
    deploymentLegsPresent: legsPresent,
    legStatuses: legs.map((leg) => Number(leg?.status)),
  };
}

export function canCancelPortfolio(portfolio, wallet) {
  return cancelPortfolioDiagnostics(portfolio, wallet).allowed;
}

export function memberRefunded(member) {
  return Number(member?.withdrawalStatus) === 2;
}

export function canClaimRefund(portfolio, member) {
  return Number(portfolio?.status) === 6 && Boolean(member)
    && !memberRefunded(member)
    && Number(member.withdrawalStatus) === 0
    && BigInt(member.totalContributed?.toString?.() ?? "0") > 0n
    && BigInt(member.ownershipUnits?.toString?.() ?? "0") > 0n;
}
