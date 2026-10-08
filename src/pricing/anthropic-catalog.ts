import type { CatalogRate, PromptLengthTier } from "./bundled-rates";
import {
  ANY_PROMPT_LENGTH,
  promptsOver,
  promptsUpTo,
  usdPerMillionToNanoPerToken,
} from "./bundled-rates";

const ANTHROPIC_SOURCE_NAME = "anthropic";
const MODEL_PRICING_HEADERS = [
  "Model",
  "Base input tokens",
  "5m cache writes",
  "1h cache writes",
  "Cache hits and refreshes",
  "Output tokens",
].map(normalizeHeader);

/** Claude 3.x keys put the version before the family name. */
const irregularModelKeys = new Map<string, string>([
  ["Claude Haiku 3.5", "claude-3-5-haiku-20241022"],
]);

const FAMILY_VERSION_DISPLAY_NAME_PATTERN = /^Claude [A-Z][a-z]+ \d+(?:\.\d+)?$/;
const PROMPT_LENGTH_TIER_ANNOTATION_PATTERN =
  / \(for prompts (?<bound>up to|over) (?<promptTokens>\d{1,3}(?:,\d{3})*) tokens\)$/;

const PRO_METERED_MODEL_KEY_PREFIX = "claude-fable-";

/** Pro subscriptions meter every Fable release as external API usage. */
export function isProMeteredClaudeModel(rawModel: string): boolean {
  return modelKeyFromRawModel(rawModel).startsWith(PRO_METERED_MODEL_KEY_PREFIX);
}

export function parseAnthropicPricingMarkdown(content: string): readonly CatalogRate[] {
  const lines = content.split(/\r?\n/);
  const headerIndex = lines.findIndex((line) => {
    const columns = columnsFromMarkdownRow(line).map(normalizeHeader);
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
    const { displayName, promptLengthTier } = splitPromptLengthTier(
      modelDisplayName(columns[0] ?? ""),
    );
    const modelKey = modelKeyFromDisplayName(displayName);
    const input = parseUsdPerMillion(columns[1]);
    const cacheCreation5m = parseUsdPerMillion(columns[2]);
    const cacheCreation1h = parseUsdPerMillion(columns[3]);
    const cacheRead = parseUsdPerMillion(columns[4]);
    const output = parseUsdPerMillion(columns[5]);
    rates.push({
      ...promptLengthTier,
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

  if (rates.length === 0) {
    throw new Error("Anthropic pricing contained no recognized model rates.");
  }
  assertEachModelPricesEveryPromptLengthOnce(rates);
  return rates;
}

function columnsFromMarkdownRow(line: string): readonly string[] {
  const trimmed = line.trim();
  if (!trimmed.startsWith("|") || !trimmed.endsWith("|")) return [];
  return trimmed.slice(1, -1).split("|").map((column) => column.trim());
}

/** The page has switched between title case and sentence case and between `&` and `and`. */
function normalizeHeader(column: string): string {
  return column.toLowerCase().replace("&", "and");
}

function modelDisplayName(value: string): string {
  const annotationIndex = value.indexOf(" ([");
  return annotationIndex === -1 ? value : value.slice(0, annotationIndex);
}

function splitPromptLengthTier(modelName: string): {
  displayName: string;
  promptLengthTier: PromptLengthTier;
} {
  const match = PROMPT_LENGTH_TIER_ANNOTATION_PATTERN.exec(modelName);
  if (match?.groups === undefined) {
    return { displayName: modelName, promptLengthTier: ANY_PROMPT_LENGTH };
  }
  const promptTokens = Number(match.groups.promptTokens?.replaceAll(",", ""));
  return {
    displayName: modelName.slice(0, match.index),
    promptLengthTier: match.groups.bound === "up to"
      ? promptsUpTo(promptTokens)
      : promptsOver(promptTokens),
  };
}

/** A gap would leave some calls unpriced, and an overlap would make their price ambiguous. */
function assertEachModelPricesEveryPromptLengthOnce(rates: readonly CatalogRate[]): void {
  const tiersByModelKey = new Map<string, CatalogRate[]>();
  for (const rate of rates) {
    tiersByModelKey.set(rate.modelKey, [...tiersByModelKey.get(rate.modelKey) ?? [], rate]);
  }
  for (const [modelKey, tiers] of tiersByModelKey) {
    if (!tiersCoverEveryPromptLengthOnce(tiers)) {
      throw new Error(`Anthropic pricing for ${modelKey} does not price every prompt length exactly once.`);
    }
  }
}

function tiersCoverEveryPromptLengthOnce(tiers: readonly PromptLengthTier[]): boolean {
  const orderedTiers = tiers.toSorted((left, right) => (
    (left.promptTokensOver ?? -1) - (right.promptTokensOver ?? -1)
  ));
  return orderedTiers.every((tier, index) => {
    const previousTier = orderedTiers[index - 1];
    const startsWherePreviousTierEnds = previousTier === undefined
      ? tier.promptTokensOver === null
      : previousTier.promptTokensUpTo !== null
        && tier.promptTokensOver === previousTier.promptTokensUpTo;
    const isOpenEnded = tier.promptTokensUpTo === null;
    const isLastTier = index === orderedTiers.length - 1;
    return startsWherePreviousTierEnds && isOpenEnded === isLastTier;
  });
}

/** `Claude Opus 5.5` becomes `claude-opus-5-5`; dated transcript keys reach this rate through `undatedModelKey`. */
function modelKeyFromDisplayName(displayName: string): string {
  const irregularModelKey = irregularModelKeys.get(displayName);
  if (irregularModelKey !== undefined) {
    return irregularModelKey;
  }
  if (!FAMILY_VERSION_DISPLAY_NAME_PATTERN.test(displayName)) {
    throw new Error(
      `Anthropic pricing included a model whose id cannot be derived from its display name: ${displayName}`,
    );
  }
  return displayName.toLowerCase().replaceAll(/[ .]/g, "-");
}

/** A trailing digit after `MTok` is a footnote marker, bare (`MTok1`) or in `<sup>1</sup>`. */
function parseUsdPerMillion(value: string | undefined): number {
  const match = /^\$(\d+(?:\.\d+)?)\s*\/\s*MTok(?:\d|<sup>\d+<\/sup>)?$/.exec(value ?? "");
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

/** The `-YYYYMMDD` suffix is a snapshot date, not part of the pricing key. */
export function undatedModelKey(modelKey: string): string {
  return modelKey.replace(/-\d{8}$/, "");
}
