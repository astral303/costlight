import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDashboardDatabase } from "../../src/app/database";
import { CallLedger } from "../../src/call-accounting/ledger";
import { PricingCatalog } from "../../src/pricing/catalog";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) => rm(directory, { force: true, recursive: true })),
  );
});

describe("PricingCatalog", () => {
  test("resolves the bundled direct Kimi K3 rate in integer nanodollars", async () => {
    const dataDirectory = await createTemporaryDirectory();
    const database = openDashboardDatabase(":memory:");
    try {
      const catalog = new PricingCatalog(database, dataDirectory);
      await catalog.initialize();

      expect(catalog.resolve("moonshot-ai/kimi-k3", Date.now())).toMatchObject({
        cacheCreationNanoPerToken: 3_000,
        cacheReadNanoPerToken: 300,
        confidence: "bundled",
        inputNanoPerToken: 3_000,
        outputNanoPerToken: 15_000,
        resolvedModelKey: "moonshotai/kimi-k3",
      });
    } finally {
      database.close();
    }
  });

  test("resolves distinct Claude Fable cache-write TTL rates", async () => {
    const dataDirectory = await createTemporaryDirectory();
    const database = openDashboardDatabase(":memory:");
    try {
      const catalog = new PricingCatalog(database, dataDirectory);
      await catalog.initialize();

      expect(catalog.resolve("claude-fable-5", Date.now())).toMatchObject({
        cacheCreation1hNanoPerToken: 20_000,
        cacheCreation5mNanoPerToken: 12_500,
        cacheCreationNanoPerToken: 12_500,
        cacheReadNanoPerToken: 1_000,
        confidence: "bundled",
        inputNanoPerToken: 10_000,
        outputNanoPerToken: 50_000,
        resolvedModelKey: "anthropic/claude-fable-5",
      });
    } finally {
      database.close();
    }
  });

  test("gives an exact raw-alias override precedence over bundled pricing", async () => {
    const dataDirectory = await createTemporaryDirectory();
    await writeFile(join(dataDirectory, "pricing-overrides.json"), JSON.stringify({
      "moonshot-ai/kimi-k3": {
        cacheCreationInputTokenCost: 0.000004,
        cacheReadInputTokenCost: 0.0000002,
        inputCostPerToken: 0.000002,
        outputCostPerToken: 0.00001,
      },
    }), "utf8");
    const database = openDashboardDatabase(":memory:");
    try {
      const catalog = new PricingCatalog(database, dataDirectory);
      await catalog.initialize();

      expect(catalog.resolve("moonshot-ai/kimi-k3", Date.now())).toMatchObject({
        cacheCreationNanoPerToken: 4_000,
        cacheReadNanoPerToken: 200,
        confidence: "override",
        inputNanoPerToken: 2_000,
        outputNanoPerToken: 10_000,
      });
    } finally {
      database.close();
    }
  });

  test("retains the last known-good catalog when refreshes fail offline", async () => {
    const dataDirectory = await createTemporaryDirectory();
    const database = openDashboardDatabase(":memory:");
    const originalFetch = globalThis.fetch;
    let isOffline = false;
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      if (isOffline) {
        throw new Error("offline");
      }
      const url = String(input);
      if (url.endsWith("pricing.md")) {
        return new Response(anthropicPricingMarkdown(), {
          headers: { "Content-Type": "text/markdown" },
        });
      }
      const body = url.includes("models.dev")
        ? {
          moonshotai: {
            models: { "kimi-k3": { cost: { cache_read: 0.25, input: 2.5, output: 12 } } },
          },
        }
        : {
          "moonshot/kimi-k3": {
            cache_read_input_token_cost: 0.00000025,
            input_cost_per_token: 0.0000025,
            output_cost_per_token: 0.000012,
          },
        };
      return new Response(JSON.stringify(body), {
        headers: { "Content-Type": "application/json", ETag: '"test-catalog"' },
      });
    }) as unknown as typeof fetch;

    try {
      const catalog = new PricingCatalog(database, dataDirectory);
      await catalog.initialize();
      expect((await catalog.forceRefresh()).every((result) => result.status === "refreshed")).toBe(true);
      expect(catalog.resolve("moonshot-ai/kimi-k3", Date.now())?.inputNanoPerToken).toBe(2_500);
      expect(catalog.getProviderPricingStatuses()).toEqual([
        expect.objectContaining({
          isStale: false,
          provider: "anthropic",
          refreshStatus: "succeeded",
          sourceKind: "remote",
          sourceName: "anthropic",
        }),
        expect.objectContaining({
          isStale: false,
          provider: "moonshotai",
          refreshStatus: "succeeded",
          sourceKind: "remote",
          sourceName: expect.any(String),
        }),
      ]);
      expect(await Bun.file(join(dataDirectory, "pricing-anthropic.md")).exists()).toBe(true);
      expect(database.query<{ count: number }, []>(`
        SELECT COUNT(*) AS count
        FROM pricing_snapshots
        WHERE source_name = 'anthropic'
      `).get()?.count).toBe(1);

      isOffline = true;
      expect((await catalog.forceRefresh()).every((result) => result.status === "failed")).toBe(true);
      expect(catalog.resolve("moonshot-ai/kimi-k3", Date.now())?.inputNanoPerToken).toBe(2_500);
      expect(catalog.getProviderPricingStatuses()[0]).toMatchObject({
        provider: "anthropic",
        refreshStatus: "failed",
        sourceKind: "remote",
        sourceName: "anthropic",
      });
    } finally {
      globalThis.fetch = originalFetch;
      database.close();
    }
  });

  test("waits for queued refreshes before shutdown", async () => {
    const dataDirectory = await createTemporaryDirectory();
    const database = openDashboardDatabase(":memory:");
    const originalFetch = globalThis.fetch;
    let completedFetchCount = 0;
    let refresh: Promise<readonly unknown[]> = Promise.resolve([]);
    globalThis.fetch = (async () => {
      await Bun.sleep(5);
      completedFetchCount += 1;
      return Response.json({});
    }) as unknown as typeof fetch;

    try {
      const catalog = new PricingCatalog(database, dataDirectory);
      await catalog.initialize();
      refresh = catalog.forceRefresh();

      await catalog.waitForRefreshes();

      expect(completedFetchCount).toBe(3);
    } finally {
      await refresh;
      globalThis.fetch = originalFetch;
      database.close();
    }
  });

  test("reports bundled pricing separately before remote provider refreshes", async () => {
    const dataDirectory = await createTemporaryDirectory();
    const database = openDashboardDatabase(":memory:");
    try {
      const catalog = new PricingCatalog(database, dataDirectory);
      await catalog.initialize();

      expect(catalog.getProviderPricingStatuses()).toEqual([
        expect.objectContaining({
          provider: "anthropic",
          refreshStatus: "not-attempted",
          sourceKind: "bundled",
          sourceName: "bundled-claude-2026-08-14",
          updatedAtMs: null,
        }),
        expect.objectContaining({
          provider: "moonshotai",
          refreshStatus: "not-attempted",
          sourceKind: "bundled",
          sourceName: "bundled-kimi-2026-08-09",
          updatedAtMs: null,
        }),
      ]);
    } finally {
      database.close();
    }
  });

  test("preserves historical rate IDs while reconciling remote pricing", async () => {
    const dataDirectory = await createTemporaryDirectory();
    const database = openDashboardDatabase(":memory:");
    const originalFetch = globalThis.fetch;
    let anthropicPricing = anthropicPricingMarkdown();
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = String(input);
      return url.endsWith("pricing.md")
        ? new Response(anthropicPricing)
        : Response.json({});
    }) as unknown as typeof fetch;

    try {
      const catalog = new PricingCatalog(database, dataDirectory);
      await catalog.initialize();
      expect((await catalog.forceRefresh())[0]?.status).toBe("refreshed");

      database.query(`
        INSERT INTO sessions (session_id, workspace_key, created_at_ms, updated_at_ms, parse_status)
        VALUES ('remote-session', 'workspace', 1, 1, 'ok')
      `).run();
      database.query(`
        INSERT INTO agents (session_id, agent_id, agent_type, source_directory)
        VALUES ('remote-session', 'main', 'main', 'wire')
      `).run();
      database.query(`
        INSERT INTO source_files (path, source_root, session_id, agent_id)
        VALUES ('remote-wire', 'root', 'remote-session', 'main')
      `).run();
      const ledger = new CallLedger(database, catalog);
      ledger.recordUsage({
        agentId: "main",
        generation: 0,
        sessionId: "remote-session",
        sourcePath: "remote-wire",
      }, {
        byteOffset: 1,
        model: "claude-fable-5",
        providerRequestId: "historical-remote-rate",
        requestMetadata: null,
        stepUuid: "historical-remote-rate-step",
        timestampMs: 1,
        tokens: {
          cacheCreation: 0,
          cacheCreation1h: 0,
          cacheCreation5m: 0,
          cacheRead: 0,
          inputOther: 1,
          output: 1,
        },
      });
      const historicalCall = database.query<{
        rate_id: number;
        total_cost_nano: number;
      }, []>("SELECT rate_id, total_cost_nano FROM api_calls").get();
      if (historicalCall === null) {
        throw new Error("Expected the historical call to be priced.");
      }

      expect((await catalog.forceRefresh())[0]?.status).toBe("refreshed");
      expect(catalog.resolve("claude-fable-5", 1)?.rateId).toBe(historicalCall.rate_id);

      anthropicPricing = anthropicPricingMarkdown(11);
      expect((await catalog.forceRefresh())[0]?.status).toBe("refreshed");
      const currentRate = catalog.resolve("claude-fable-5", 1);
      expect(currentRate).toMatchObject({ inputNanoPerToken: 11_000 });
      expect(currentRate?.rateId).not.toBe(historicalCall.rate_id);
      expect(database.query<{ is_active: number; input_nano_per_token: number }, [number]>(`
        SELECT is_active, input_nano_per_token
        FROM model_rates
        WHERE rate_id = ?
      `).get(historicalCall.rate_id)).toEqual({
        input_nano_per_token: 10_000,
        is_active: 0,
      });
      expect(database.query<{ rate_id: number; total_cost_nano: number }, []>(
        "SELECT rate_id, total_cost_nano FROM api_calls",
      ).get()).toEqual(historicalCall);
    } finally {
      globalThis.fetch = originalFetch;
      database.close();
    }
  });

  test("reports partial provider failure without discarding successful sources", async () => {
    const dataDirectory = await createTemporaryDirectory();
    const database = openDashboardDatabase(":memory:");
    const originalFetch = globalThis.fetch;
    const reportedFailures: { provider: string; sourceName: string }[] = [];
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("pricing.md")) {
        return new Response(anthropicPricingMarkdown());
      }
      if (url.includes("models.dev")) {
        throw new Error("models.dev unavailable");
      }
      return Response.json({
        "moonshot/kimi-k3": {
          input_cost_per_token: 0.000003,
          output_cost_per_token: 0.000015,
        },
      });
    }) as unknown as typeof fetch;

    try {
      const catalog = new PricingCatalog(database, dataDirectory, {
        onRefreshFailure: ({ provider, sourceName }) => {
          reportedFailures.push({ provider, sourceName });
        },
      });
      await catalog.initialize();
      const results = await catalog.forceRefresh();

      expect(results.map((result) => result.status)).toEqual([
        "refreshed",
        "failed",
        "refreshed",
      ]);
      expect(catalog.getProviderPricingStatuses()[1]).toMatchObject({
        provider: "moonshotai",
        refreshStatus: "partial-failure",
        sourceKind: "remote",
        sourceName: "litellm",
      });
      expect(catalog.resolve("moonshot-ai/kimi-k3", Date.now())?.inputNanoPerToken)
        .toBe(3_000);
      expect(reportedFailures).toEqual([{ provider: "moonshotai", sourceName: "models.dev" }]);
    } finally {
      globalThis.fetch = originalFetch;
      database.close();
    }
  });

  test("keeps a bundled rate row referenced by historical calls across restart", async () => {
    const dataDirectory = await createTemporaryDirectory();
    const database = openDashboardDatabase(":memory:");
    try {
      const catalog = new PricingCatalog(database, dataDirectory);
      await catalog.initialize();
      database.query(`
        INSERT INTO sessions (session_id, workspace_key, created_at_ms, updated_at_ms, parse_status)
        VALUES ('session', 'workspace', 1, 1, 'ok')
      `).run();
      database.query(`
        INSERT INTO agents (session_id, agent_id, agent_type, source_directory)
        VALUES ('session', 'main', 'main', 'wire')
      `).run();
      database.query(`
        INSERT INTO source_files (path, source_root, session_id, agent_id)
        VALUES ('wire', 'root', 'session', 'main')
      `).run();
      const ledger = new CallLedger(database, catalog);
      ledger.recordUsage({
        agentId: "main",
        generation: 0,
        sessionId: "session",
        sourcePath: "wire",
      }, {
        byteOffset: 1,
        model: "moonshot-ai/kimi-k3",
        providerRequestId: "historical-rate",
        requestMetadata: null,
        stepUuid: "historical-rate-step",
        timestampMs: 1,
        tokens: {
          cacheCreation: 0,
          cacheCreation1h: 0,
          cacheCreation5m: 0,
          cacheRead: 0,
          inputOther: 1,
          output: 1,
        },
      });
      const originalTotal = database
        .query<{ total_cost_nano: number }, []>("SELECT total_cost_nano FROM api_calls")
        .get()?.total_cost_nano;

      await catalog.initialize();

      expect(database.query<{ total_cost_nano: number }, []>(
        "SELECT total_cost_nano FROM api_calls",
      ).get()?.total_cost_nano).toBe(originalTotal);
    } finally {
      database.close();
    }
  });
});

async function createTemporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "kimi-cost-pricing-test-"));
  temporaryDirectories.push(directory);
  return directory;
}

function anthropicPricingMarkdown(inputPrice = 10): string {
  return `
| Model | Base Input Tokens | 5m Cache Writes | 1h Cache Writes | Cache Hits & Refreshes | Output Tokens |
|---|---:|---:|---:|---:|---:|
| Claude Fable 5 | $${inputPrice} / MTok | $12.50 / MTok | $20 / MTok | $1 / MTok | $50 / MTok |
`;
}
