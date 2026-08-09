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

      isOffline = true;
      expect((await catalog.forceRefresh()).every((result) => result.status === "failed")).toBe(true);
      expect(catalog.resolve("moonshot-ai/kimi-k3", Date.now())?.inputNanoPerToken).toBe(2_500);
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

      expect(completedFetchCount).toBe(2);
    } finally {
      await refresh;
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
      const ledger = new CallLedger(database, catalog.resolve.bind(catalog));
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
        tokens: { cacheCreation: 0, cacheRead: 0, inputOther: 1, output: 1 },
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
