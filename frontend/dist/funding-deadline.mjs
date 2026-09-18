export const FUNDING_ENDED_MESSAGE = "Funding has ended for this portfolio.";

export function fundingEnded(deadlineSeconds, nowMs = Date.now()) {
  return nowMs >= Number(deadlineSeconds) * 1000;
}

export function fundingCloseLabel(deadlineSeconds, locale = undefined) {
  return new Intl.DateTimeFormat(locale, {
    weekday: "long", year: "numeric", month: "long", day: "numeric",
    hour: "numeric", minute: "2-digit", timeZoneName: "short",
  }).format(new Date(Number(deadlineSeconds) * 1000));
}

export function fundingCountdown(deadlineSeconds, nowMs = Date.now()) {
  const seconds = Math.max(0, Math.ceil((Number(deadlineSeconds) * 1000 - nowMs) / 1000));
  if (!seconds) return FUNDING_ENDED_MESSAGE;
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const remainder = seconds % 60;
  return `${days ? `${days}d ` : ""}${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}:${String(remainder).padStart(2, "0")} remaining`;
}
