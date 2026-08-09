export interface CatalogRate {
  cacheCreationNanoPerToken: number;
  cacheReadNanoPerToken: number;
  confidence: "exact" | "alias" | "inferred" | "override" | "bundled";
  effectiveAtMs: number | null;
  inputNanoPerToken: number;
  modelKey: string;
  outputNanoPerToken: number;
  provider: string;
  rawAlias: string | null;
  sourceName: string;
}

interface BundledUsdRate {
  cacheReadUsdPerMillion: number;
  inputUsdPerMillion: number;
  modelKey: string;
  outputUsdPerMillion: number;
}

const BUNDLED_SOURCE = "bundled-kimi-2026-08-09";

const bundledUsdRates: readonly BundledUsdRate[] = [
  { modelKey: "kimi-k3", inputUsdPerMillion: 3, cacheReadUsdPerMillion: 0.3, outputUsdPerMillion: 15 },
  { modelKey: "kimi-k2.7-code", inputUsdPerMillion: 0.95, cacheReadUsdPerMillion: 0.19, outputUsdPerMillion: 4 },
  { modelKey: "kimi-k2.7-code-highspeed", inputUsdPerMillion: 1.9, cacheReadUsdPerMillion: 0.38, outputUsdPerMillion: 8 },
  { modelKey: "kimi-k2.6", inputUsdPerMillion: 0.95, cacheReadUsdPerMillion: 0.16, outputUsdPerMillion: 4 },
  { modelKey: "kimi-k2.5", inputUsdPerMillion: 0.6, cacheReadUsdPerMillion: 0.1, outputUsdPerMillion: 3 },
  { modelKey: "kimi-k2-thinking", inputUsdPerMillion: 0.6, cacheReadUsdPerMillion: 0.15, outputUsdPerMillion: 2.5 },
  { modelKey: "kimi-k2-thinking-turbo", inputUsdPerMillion: 1.15, cacheReadUsdPerMillion: 0.15, outputUsdPerMillion: 8 },
  { modelKey: "kimi-k2-0905-preview", inputUsdPerMillion: 0.6, cacheReadUsdPerMillion: 0.15, outputUsdPerMillion: 2.5 },
  { modelKey: "kimi-k2-0711-preview", inputUsdPerMillion: 0.6, cacheReadUsdPerMillion: 0.15, outputUsdPerMillion: 2.5 },
  { modelKey: "kimi-k2-turbo-preview", inputUsdPerMillion: 1.15, cacheReadUsdPerMillion: 0.15, outputUsdPerMillion: 8 },
];

export const bundledRates: readonly CatalogRate[] = bundledUsdRates.map((rate) => ({
  cacheCreationNanoPerToken: usdPerMillionToNanoPerToken(rate.inputUsdPerMillion),
  cacheReadNanoPerToken: usdPerMillionToNanoPerToken(rate.cacheReadUsdPerMillion),
  confidence: "bundled",
  effectiveAtMs: null,
  inputNanoPerToken: usdPerMillionToNanoPerToken(rate.inputUsdPerMillion),
  modelKey: rate.modelKey,
  outputNanoPerToken: usdPerMillionToNanoPerToken(rate.outputUsdPerMillion),
  provider: "moonshotai",
  rawAlias: null,
  sourceName: BUNDLED_SOURCE,
}));

export function usdPerMillionToNanoPerToken(usdPerMillion: number): number {
  return Math.round(usdPerMillion * 1_000);
}

export function usdPerTokenToNanoPerToken(usdPerToken: number): number {
  return Math.round(usdPerToken * 1_000_000_000);
}
