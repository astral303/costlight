import { describe, expect, test } from "bun:test";
import { parseLiteLlmCatalog, parseModelsDevCatalog } from "../../src/pricing/remote-catalogs";

describe("remote pricing catalogs", () => {
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
