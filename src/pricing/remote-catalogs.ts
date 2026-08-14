import type { CatalogRate } from "./bundled-rates";
import { usdPerMillionToNanoPerToken, usdPerTokenToNanoPerToken } from "./bundled-rates";
import { parseAnthropicPricingMarkdown } from "./anthropic-catalog";

export interface RemoteCatalogDefinition {
  fileExtension: "json" | "md";
  name: "anthropic" | "litellm" | "models.dev";
  parseContent: (content: string) => readonly CatalogRate[];
  provider: "anthropic" | "moonshotai";
  url: string;
}

export const remoteCatalogs: readonly RemoteCatalogDefinition[] = [
  {
    fileExtension: "md",
    name: "anthropic",
    parseContent: parseAnthropicPricingMarkdown,
    provider: "anthropic",
    url: "https://platform.claude.com/docs/en/about-claude/pricing.md",
  },
  {
    fileExtension: "json",
    name: "models.dev",
    parseContent: (content) => parseModelsDevCatalog(JSON.parse(content)),
    provider: "moonshotai",
    url: "https://models.dev/api.json",
  },
  {
    fileExtension: "json",
    name: "litellm",
    parseContent: (content) => parseLiteLlmCatalog(JSON.parse(content)),
    provider: "moonshotai",
    url: "https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json",
  },
];

export function parseModelsDevCatalog(value: unknown): readonly CatalogRate[] {
  if (!isRecord(value)) {
    throw new Error("models.dev returned a non-object catalog.");
  }

  const provider = value.moonshotai;
  if (!isRecord(provider) || !isRecord(provider.models)) {
    throw new Error("models.dev did not include the direct Moonshot provider.");
  }

  const rates: CatalogRate[] = [];
  for (const [modelKey, rawModel] of Object.entries(provider.models)) {
    if (!isRecord(rawModel) || !isRecord(rawModel.cost)) {
      continue;
    }

    const input = nonnegativeNumber(rawModel.cost.input);
    const output = nonnegativeNumber(rawModel.cost.output);
    if (input === null || output === null) {
      continue;
    }
    const cacheRead = nonnegativeNumber(rawModel.cost.cache_read) ?? input;
    const cacheCreation = nonnegativeNumber(rawModel.cost.cache_write);
    rates.push({
      cacheCreation1hNanoPerToken: usdPerMillionToNanoPerToken(cacheCreation ?? input),
      cacheCreation5mNanoPerToken: usdPerMillionToNanoPerToken(cacheCreation ?? input),
      cacheCreationNanoPerToken: usdPerMillionToNanoPerToken(cacheCreation ?? input),
      cacheReadNanoPerToken: usdPerMillionToNanoPerToken(cacheRead),
      confidence: cacheCreation === null ? "inferred" : "exact",
      effectiveAtMs: null,
      inputNanoPerToken: usdPerMillionToNanoPerToken(input),
      modelKey,
      outputNanoPerToken: usdPerMillionToNanoPerToken(output),
      provider: "moonshotai",
      rawAlias: null,
      sourceName: "models.dev",
    });
  }

  if (rates.length === 0) {
    throw new Error("models.dev contained no usable direct Moonshot rates.");
  }
  return rates;
}

export function parseLiteLlmCatalog(value: unknown): readonly CatalogRate[] {
  if (!isRecord(value)) {
    throw new Error("LiteLLM returned a non-object catalog.");
  }

  const rates: CatalogRate[] = [];
  for (const [catalogKey, rawModel] of Object.entries(value)) {
    if (!catalogKey.startsWith("moonshot/") || !isRecord(rawModel)) {
      continue;
    }

    const input = nonnegativeNumber(rawModel.input_cost_per_token);
    const output = nonnegativeNumber(rawModel.output_cost_per_token);
    if (input === null || output === null) {
      continue;
    }
    const cacheRead = nonnegativeNumber(rawModel.cache_read_input_token_cost) ?? input;
    const cacheCreation = nonnegativeNumber(rawModel.cache_creation_input_token_cost);
    rates.push({
      cacheCreation1hNanoPerToken: usdPerTokenToNanoPerToken(cacheCreation ?? input),
      cacheCreation5mNanoPerToken: usdPerTokenToNanoPerToken(cacheCreation ?? input),
      cacheCreationNanoPerToken: usdPerTokenToNanoPerToken(cacheCreation ?? input),
      cacheReadNanoPerToken: usdPerTokenToNanoPerToken(cacheRead),
      confidence: cacheCreation === null ? "inferred" : "exact",
      effectiveAtMs: null,
      inputNanoPerToken: usdPerTokenToNanoPerToken(input),
      modelKey: catalogKey.slice("moonshot/".length),
      outputNanoPerToken: usdPerTokenToNanoPerToken(output),
      provider: "moonshotai",
      rawAlias: null,
      sourceName: "litellm",
    });
  }

  if (rates.length === 0) {
    throw new Error("LiteLLM contained no usable direct Moonshot rates.");
  }
  return rates;
}

function nonnegativeNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
