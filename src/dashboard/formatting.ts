import type { TimeseriesResolution } from "./contracts";

/** Observations averaged for the trailing-cost and cache-hit-ratio lines. */
export const TRAILING_WINDOW = 20;

/**
 * Names the trailing window in the reader's units. Buckets skip idle periods, so twenty
 * hour-buckets span twenty active hours, not a contiguous day — hence "active".
 */
export function formatTrailingWindow(resolution: TimeseriesResolution | undefined): string {
  if (resolution === "call") {
    return `${TRAILING_WINDOW} calls`;
  }
  if (resolution === undefined) {
    return `${TRAILING_WINDOW} buckets`;
  }
  return `${TRAILING_WINDOW} active ${resolution}s`;
}

export function formatUsdNano(nanodollars: number): string {
  const dollars = nanodollars / 1_000_000_000;
  return new Intl.NumberFormat(undefined, {
    currency: "USD",
    maximumFractionDigits: dollars < 0.01 && dollars !== 0 ? 4 : 2,
    minimumFractionDigits: 2,
    style: "currency",
  }).format(dollars);
}
