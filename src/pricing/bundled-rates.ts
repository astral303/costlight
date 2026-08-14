export interface CatalogRate {
  cacheCreation1hNanoPerToken: number;
  cacheCreation5mNanoPerToken: number;
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
  cacheCreation1hUsdPerMillion?: number;
  cacheCreation5mUsdPerMillion?: number;
  cacheReadUsdPerMillion: number;
  inputUsdPerMillion: number;
  modelKey: string;
  outputUsdPerMillion: number;
  provider: string;
  sourceName: string;
}

const KIMI_BUNDLED_SOURCE = "bundled-kimi-2026-08-09";
const CLAUDE_BUNDLED_SOURCE = "bundled-claude-2026-08-14";

const bundledUsdRates: readonly BundledUsdRate[] = [
  kimiRate("kimi-k3", 3, 0.3, 15),
  kimiRate("kimi-k2.7-code", 0.95, 0.19, 4),
  kimiRate("kimi-k2.7-code-highspeed", 1.9, 0.38, 8),
  kimiRate("kimi-k2.6", 0.95, 0.16, 4),
  kimiRate("kimi-k2.5", 0.6, 0.1, 3),
  kimiRate("kimi-k2-thinking", 0.6, 0.15, 2.5),
  kimiRate("kimi-k2-thinking-turbo", 1.15, 0.15, 8),
  kimiRate("kimi-k2-0905-preview", 0.6, 0.15, 2.5),
  kimiRate("kimi-k2-0711-preview", 0.6, 0.15, 2.5),
  kimiRate("kimi-k2-turbo-preview", 1.15, 0.15, 8),
  claudeRate("claude-fable-5", 10, 1, 50),
  claudeRate("claude-opus-5", 5, 0.5, 25),
  claudeRate("claude-haiku-4-5-20251001", 1, 0.1, 5),
];

function kimiRate(
  modelKey: string,
  inputUsdPerMillion: number,
  cacheReadUsdPerMillion: number,
  outputUsdPerMillion: number,
): BundledUsdRate {
  return {
    cacheReadUsdPerMillion,
    inputUsdPerMillion,
    modelKey,
    outputUsdPerMillion,
    provider: "moonshotai",
    sourceName: KIMI_BUNDLED_SOURCE,
  };
}

function claudeRate(
  modelKey: string,
  inputUsdPerMillion: number,
  cacheReadUsdPerMillion: number,
  outputUsdPerMillion: number,
): BundledUsdRate {
  return {
    cacheCreation1hUsdPerMillion: inputUsdPerMillion * 2,
    cacheCreation5mUsdPerMillion: inputUsdPerMillion * 1.25,
    cacheReadUsdPerMillion,
    inputUsdPerMillion,
    modelKey,
    outputUsdPerMillion,
    provider: "anthropic",
    sourceName: CLAUDE_BUNDLED_SOURCE,
  };
}

export const bundledRates: readonly CatalogRate[] = bundledUsdRates.map((rate) => ({
  cacheCreation1hNanoPerToken: usdPerMillionToNanoPerToken(
    rate.cacheCreation1hUsdPerMillion ?? rate.inputUsdPerMillion,
  ),
  cacheCreation5mNanoPerToken: usdPerMillionToNanoPerToken(
    rate.cacheCreation5mUsdPerMillion ?? rate.inputUsdPerMillion,
  ),
  cacheCreationNanoPerToken: usdPerMillionToNanoPerToken(
    rate.cacheCreation5mUsdPerMillion ?? rate.inputUsdPerMillion,
  ),
  cacheReadNanoPerToken: usdPerMillionToNanoPerToken(rate.cacheReadUsdPerMillion),
  confidence: "bundled",
  effectiveAtMs: null,
  inputNanoPerToken: usdPerMillionToNanoPerToken(rate.inputUsdPerMillion),
  modelKey: rate.modelKey,
  outputNanoPerToken: usdPerMillionToNanoPerToken(rate.outputUsdPerMillion),
  provider: rate.provider,
  rawAlias: null,
  sourceName: rate.sourceName,
}));

export function usdPerMillionToNanoPerToken(usdPerMillion: number): number {
  return Math.round(usdPerMillion * 1_000);
}

export function usdPerTokenToNanoPerToken(usdPerToken: number): number {
  return Math.round(usdPerToken * 1_000_000_000);
}
