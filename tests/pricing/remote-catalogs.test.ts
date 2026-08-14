import { describe, expect, test } from "bun:test";
import {
  isProMeteredClaudeModel,
  parseAnthropicPricingMarkdown,
} from "../../src/pricing/anthropic-catalog";
import { parseLiteLlmCatalog, parseModelsDevCatalog } from "../../src/pricing/remote-catalogs";

describe("remote pricing catalogs", () => {
  test("parses the exact official Anthropic model-pricing columns", () => {
    const rates = parseAnthropicPricingMarkdown(`
| Different | Table |
|---|---|
| ignored | ignored |

| Model | Base Input Tokens | 5m Cache Writes | 1h Cache Writes | Cache Hits & Refreshes | Output Tokens |
|---|---:|---:|---:|---:|---:|
| Claude Fable 5 ([details](#fable)) | $10 / MTok | $12.50 / MTok | $20 / MTok | $1 / MTok | $50 / MTok |
`);

    expect(rates).toEqual([{
      cacheCreation1hNanoPerToken: 20_000,
      cacheCreation5mNanoPerToken: 12_500,
      cacheCreationNanoPerToken: 12_500,
      cacheReadNanoPerToken: 1_000,
      confidence: "exact",
      effectiveAtMs: null,
      inputNanoPerToken: 10_000,
      modelKey: "claude-fable-5",
      outputNanoPerToken: 50_000,
      provider: "anthropic",
      rawAlias: null,
      sourceName: "anthropic",
    }]);
  });

  test("rejects malformed official Anthropic prices", () => {
    expect(() => parseAnthropicPricingMarkdown(`
| Model | Base Input Tokens | 5m Cache Writes | 1h Cache Writes | Cache Hits & Refreshes | Output Tokens |
|---|---:|---:|---:|---:|---:|
| Claude Fable 5 | USD 10 | $12.50 / MTok | $20 / MTok | $1 / MTok | $50 / MTok |
`)).toThrow("Invalid Anthropic model price");
  });

  test("rejects official models without an explicit transcript alias", () => {
    expect(() => parseAnthropicPricingMarkdown(`
| Model | Base Input Tokens | 5m Cache Writes | 1h Cache Writes | Cache Hits & Refreshes | Output Tokens |
|---|---:|---:|---:|---:|---:|
| Unknown Claude | $2 / MTok | $2.50 / MTok | $4 / MTok | $0.20 / MTok | $10 / MTok |
`)).toThrow("unmapped model");
  });

  test("recognizes only explicit Pro-metered Fable aliases", () => {
    expect(isProMeteredClaudeModel("claude-fable-5")).toBe(true);
    expect(isProMeteredClaudeModel("anthropic/claude-fable-5")).toBe(true);
    expect(isProMeteredClaudeModel("claude-fable-5-preview")).toBe(false);
    expect(isProMeteredClaudeModel("my-claude-fable-5")).toBe(false);
  });

  test("extracts only direct Moonshot models from models.dev", () => {
    const rates = parseModelsDevCatalog({
      moonshotai: {
        models: {
          "kimi-k3": { cost: { cache_read: 0.3, input: 3, output: 15 } },
        },
      },
      openrouter: {
        models: {
          "moonshotai/kimi-k3": { cost: { cache_read: 0.2, input: 2, output: 10 } },
        },
      },
    });

    expect(rates).toEqual([
      {
        cacheCreation1hNanoPerToken: 3_000,
        cacheCreation5mNanoPerToken: 3_000,
        cacheCreationNanoPerToken: 3_000,
        cacheReadNanoPerToken: 300,
        confidence: "inferred",
        effectiveAtMs: null,
        inputNanoPerToken: 3_000,
        modelKey: "kimi-k3",
        outputNanoPerToken: 15_000,
        provider: "moonshotai",
        rawAlias: null,
        sourceName: "models.dev",
      },
    ]);
  });

  test("uses normal input pricing when LiteLLM omits cache creation pricing", () => {
    const rates = parseLiteLlmCatalog({
      "moonshot/kimi-k2.6": {
        cache_read_input_token_cost: 0.00000016,
        input_cost_per_token: 0.00000095,
        output_cost_per_token: 0.000004,
      },
      "openrouter/moonshotai/kimi-k2.6": {
        input_cost_per_token: 0.0000005,
        output_cost_per_token: 0.000002,
      },
    });

    expect(rates[0]).toMatchObject({
      cacheCreationNanoPerToken: 950,
      cacheReadNanoPerToken: 160,
      confidence: "inferred",
      inputNanoPerToken: 950,
      modelKey: "kimi-k2.6",
      outputNanoPerToken: 4_000,
    });
    expect(rates).toHaveLength(1);
  });
});
