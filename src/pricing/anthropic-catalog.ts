import type { CatalogRate } from "./bundled-rates";
import { usdPerMillionToNanoPerToken } from "./bundled-rates";

const ANTHROPIC_SOURCE_NAME = "anthropic";
const MODEL_PRICING_HEADERS = [
  "Model",
  "Base Input Tokens",
  "5m Cache Writes",
  "1h Cache Writes",
  "Cache Hits & Refreshes",
  "Output Tokens",
] as const;

const officialModelKeys = new Map<string, readonly string[]>([
  ["Claude Fable 5", ["claude-fable-5"]],
  ["Claude Mythos 5", ["claude-mythos-5"]],
  ["Claude Opus 5", ["claude-opus-5"]],
  ["Claude Opus 4.8", ["claude-opus-4-8"]],
  ["Claude Opus 4.7", ["claude-opus-4-7"]],
  ["Claude Opus 4.6", ["claude-opus-4-6"]],
  ["Claude Opus 4.5", ["claude-opus-4-5-20251101"]],
  ["Claude Opus 4.1", ["claude-opus-4-1-20250805"]],
  ["Claude Opus 4", ["claude-opus-4-20250514"]],
  ["Claude Sonnet 5", ["claude-sonnet-5"]],
  ["Claude Sonnet 4.6", ["claude-sonnet-4-6"]],
  ["Claude Sonnet 4.5", ["claude-sonnet-4-5-20250929"]],
  ["Claude Sonnet 4", ["claude-sonnet-4-20250514"]],
  ["Claude Haiku 4.5", ["claude-haiku-4-5-20251001"]],
  ["Claude Haiku 3.5", ["claude-3-5-haiku-20241022"]],
]);

const proMeteredModelKeys = new Set(["claude-fable-5"]);

export function isProMeteredClaudeModel(rawModel: string): boolean {
  return proMeteredModelKeys.has(modelKeyFromRawModel(rawModel));
}

export function parseAnthropicPricingMarkdown(content: string): readonly CatalogRate[] {
  const lines = content.split(/\r?\n/);
  const headerIndex = lines.findIndex((line) => {
    const columns = columnsFromMarkdownRow(line);
    return columns.length === MODEL_PRICING_HEADERS.length
      && columns.every((column, index) => column === MODEL_PRICING_HEADERS[index]);
  });
  if (headerIndex === -1) {
    throw new Error("Anthropic pricing did not include the expected model-pricing table.");
  }

  const rates: CatalogRate[] = [];
  for (const line of lines.slice(headerIndex + 2)) {
    if (!line.trimStart().startsWith("|")) break;
    const columns = columnsFromMarkdownRow(line);
    if (columns.length !== MODEL_PRICING_HEADERS.length) continue;
    const displayName = modelDisplayName(columns[0] ?? "");
    const modelKeys = officialModelKeys.get(displayName);
    if (modelKeys === undefined) {
      throw new Error(`Anthropic pricing included an unmapped model: ${displayName}`);
    }

    const input = parseUsdPerMillion(columns[1]);
    const cacheCreation5m = parseUsdPerMillion(columns[2]);
    const cacheCreation1h = parseUsdPerMillion(columns[3]);
    const cacheRead = parseUsdPerMillion(columns[4]);
    const output = parseUsdPerMillion(columns[5]);
    for (const modelKey of modelKeys) {
      rates.push({
        cacheCreation1hNanoPerToken: usdPerMillionToNanoPerToken(cacheCreation1h),
        cacheCreation5mNanoPerToken: usdPerMillionToNanoPerToken(cacheCreation5m),
        cacheCreationNanoPerToken: usdPerMillionToNanoPerToken(cacheCreation5m),
        cacheReadNanoPerToken: usdPerMillionToNanoPerToken(cacheRead),
        confidence: "exact",
        effectiveAtMs: null,
        inputNanoPerToken: usdPerMillionToNanoPerToken(input),
        modelKey,
        outputNanoPerToken: usdPerMillionToNanoPerToken(output),
        provider: "anthropic",
        rawAlias: null,
        sourceName: ANTHROPIC_SOURCE_NAME,
      });
    }
  }

  if (rates.length === 0) {
    throw new Error("Anthropic pricing contained no recognized model rates.");
  }
  return rates;
}

function columnsFromMarkdownRow(line: string): readonly string[] {
  const trimmed = line.trim();
  if (!trimmed.startsWith("|") || !trimmed.endsWith("|")) return [];
  return trimmed.slice(1, -1).split("|").map((column) => column.trim());
}

function modelDisplayName(value: string): string {
  const annotationIndex = value.indexOf(" ([");
  return annotationIndex === -1 ? value : value.slice(0, annotationIndex);
}

function parseUsdPerMillion(value: string | undefined): number {
  const match = /^\$(\d+(?:\.\d+)?)\s*\/\s*MTok$/.exec(value ?? "");
  const parsed = match === null ? Number.NaN : Number(match[1]);
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new Error(`Invalid Anthropic model price: ${value ?? "missing"}`);
  }
  return parsed;
}

export function modelKeyFromRawModel(rawModel: string): string {
  const separatorIndex = rawModel.indexOf("/");
  return separatorIndex === -1 ? rawModel : rawModel.slice(separatorIndex + 1);
}
