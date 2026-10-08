/**
 * The prompt lengths a rate prices, in prompt tokens: uncached input plus cache reads and writes.
 * `null` leaves that end of the tier open.
 */
export interface PromptLengthTier {
  promptTokensOver: number | null;
  promptTokensUpTo: number | null;
}

export const ANY_PROMPT_LENGTH: PromptLengthTier = { promptTokensOver: null, promptTokensUpTo: null };

export function promptsUpTo(promptTokens: number): PromptLengthTier {
  return { promptTokensOver: null, promptTokensUpTo: promptTokens };
}

export function promptsOver(promptTokens: number): PromptLengthTier {
  return { promptTokensOver: promptTokens, promptTokensUpTo: null };
}

export interface CatalogRate extends PromptLengthTier {
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
  promptLengthTier: PromptLengthTier;
  provider: string;
  sourceName: string;
}

const KIMI_BUNDLED_SOURCE = "bundled-kimi-2026-08-09";
const CLAUDE_BUNDLED_SOURCE = "bundled-claude-2026-10-08";
const HAIKU_5_5_PROMPT_TIER_BOUNDARY_TOKENS = 100_000;

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
  claudeRate("claude-fable-5-1", 10, 0.25, 50),
  claudeRate("claude-fable-5", 10, 1, 50),
  claudeRate("claude-opus-5-5", 4, 0.2, 20),
  claudeRate("claude-opus-5", 5, 0.5, 25),
  claudeRate("claude-haiku-5-5", 0.1, 0.01, 0.5, promptsUpTo(HAIKU_5_5_PROMPT_TIER_BOUNDARY_TOKENS)),
  claudeRate("claude-haiku-5-5", 0.5, 0.05, 2.5, promptsOver(HAIKU_5_5_PROMPT_TIER_BOUNDARY_TOKENS)),
  claudeRate("claude-haiku-4-5", 1, 0.1, 5),
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
    promptLengthTier: ANY_PROMPT_LENGTH,
    provider: "moonshotai",
    sourceName: KIMI_BUNDLED_SOURCE,
  };
}

function claudeRate(
  modelKey: string,
  inputUsdPerMillion: number,
  cacheReadUsdPerMillion: number,
  outputUsdPerMillion: number,
  promptLengthTier = ANY_PROMPT_LENGTH,
): BundledUsdRate {
  return {
    cacheCreation1hUsdPerMillion: inputUsdPerMillion * 2,
    cacheCreation5mUsdPerMillion: inputUsdPerMillion * 1.25,
    cacheReadUsdPerMillion,
    inputUsdPerMillion,
    modelKey,
    outputUsdPerMillion,
    promptLengthTier,
    provider: "anthropic",
    sourceName: CLAUDE_BUNDLED_SOURCE,
  };
}

export const bundledRates: readonly CatalogRate[] = bundledUsdRates.map((rate) => ({
  ...rate.promptLengthTier,
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
