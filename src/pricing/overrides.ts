import { readFile } from "node:fs/promises";
import { z } from "zod";
import type { CatalogRate } from "./bundled-rates";
import { usdPerTokenToNanoPerToken } from "./bundled-rates";

const overrideRateSchema = z.object({
  cacheCreation1hInputTokenCost: z.number().nonnegative().optional(),
  cacheCreation5mInputTokenCost: z.number().nonnegative().optional(),
  cacheCreationInputTokenCost: z.number().nonnegative().optional(),
  cacheReadInputTokenCost: z.number().nonnegative().optional(),
  effectiveAt: z.union([z.string(), z.number()]).optional(),
  inputCostPerToken: z.number().nonnegative(),
  outputCostPerToken: z.number().nonnegative(),
});

const overrideFileSchema = z.union([
  z.record(z.string(), overrideRateSchema),
  z.object({ pricingOverrides: z.record(z.string(), overrideRateSchema) })
    .transform(({ pricingOverrides }) => pricingOverrides),
]);

export async function loadPricingOverrides(filePath: string): Promise<readonly CatalogRate[]> {
  let content: string;
  try {
    content = await readFile(filePath, "utf8");
  } catch (error) {
    if (isMissingPathError(error)) {
      return [];
    }
    throw new Error(`Unable to read pricing overrides: ${filePath}`, { cause: error });
  }

  const overrides = overrideFileSchema.parse(JSON.parse(content));
  return Object.entries(overrides).map(([rawAlias, rate]) => {
    const inputNanoPerToken = usdPerTokenToNanoPerToken(rate.inputCostPerToken);
    const cacheCreationNanoPerToken = rate.cacheCreationInputTokenCost === undefined
      ? inputNanoPerToken
      : usdPerTokenToNanoPerToken(rate.cacheCreationInputTokenCost);
    return {
      cacheCreation1hNanoPerToken: rate.cacheCreation1hInputTokenCost === undefined
        ? cacheCreationNanoPerToken
        : usdPerTokenToNanoPerToken(rate.cacheCreation1hInputTokenCost),
      cacheCreation5mNanoPerToken: rate.cacheCreation5mInputTokenCost === undefined
        ? cacheCreationNanoPerToken
        : usdPerTokenToNanoPerToken(rate.cacheCreation5mInputTokenCost),
      cacheCreationNanoPerToken,
      cacheReadNanoPerToken: rate.cacheReadInputTokenCost === undefined
        ? inputNanoPerToken
        : usdPerTokenToNanoPerToken(rate.cacheReadInputTokenCost),
      confidence: "override",
      effectiveAtMs: parseEffectiveAt(rate.effectiveAt),
      inputNanoPerToken,
      modelKey: modelKeyFromAlias(rawAlias),
      outputNanoPerToken: usdPerTokenToNanoPerToken(rate.outputCostPerToken),
      provider: providerFromAlias(rawAlias),
      rawAlias,
      sourceName: "user-override",
    };
  });
}

function parseEffectiveAt(value: string | number | undefined): number | null {
  if (value === undefined) {
    return null;
  }
  if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) {
    return value;
  }

  const timestamp = Date.parse(String(value));
  if (Number.isNaN(timestamp)) {
    throw new Error(`Invalid pricing override effectiveAt value: ${value}`);
  }
  return timestamp;
}

function providerFromAlias(rawAlias: string): string {
  const separatorIndex = rawAlias.indexOf("/");
  if (separatorIndex === -1 && rawAlias.toLowerCase().startsWith("claude-")) {
    return "anthropic";
  }
  const provider = separatorIndex === -1 ? "moonshotai" : rawAlias.slice(0, separatorIndex);
  return provider === "moonshot-ai" || provider === "moonshot" ? "moonshotai" : provider;
}

function modelKeyFromAlias(rawAlias: string): string {
  const separatorIndex = rawAlias.indexOf("/");
  return separatorIndex === -1 ? rawAlias : rawAlias.slice(separatorIndex + 1);
}

function isMissingPathError(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}
