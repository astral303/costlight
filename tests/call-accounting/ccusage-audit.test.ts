import { describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { openDashboardDatabase } from "../../src/app/database";
import {
  auditClaudeWithCcusage,
  auditKimiWithCcusage,
  type CcusageRunner,
  extractCcusageModelCosts,
  extractCcusageTotalUsd,
  queryClaudeAuditTotals,
  queryKimiAuditTotals,
  queryMeteredClaudeModelKeys,
  splitCostsByMeteredModel,
} from "../../src/call-accounting/ccusage-audit";
import {
  type CallPricing,
  CallLedger,
  type MeteringResolver,
  type RateResolver,
} from "../../src/call-accounting/ledger";

const FABLE_MODEL = "claude-fable-5";
const SONNET_MODEL = "claude-sonnet-5";

describe("extractCcusageTotalUsd", () => {
  test("reads aggregate and daily report shapes", () => {
    expect(extractCcusageTotalUsd({ totals: { totalCost: 12.5 } })).toBe(12.5);
    expect(extractCcusageTotalUsd({ daily: [{ totalCost: 1.25 }, { totalCost: 2.5 }] })).toBe(3.75);
    expect(extractCcusageTotalUsd([{ totalCost: 4 }, { totalCost: 5 }])).toBe(9);
  });
});

describe("extractCcusageModelCosts", () => {
  test("sums each model across days", () => {
    const costs = extractCcusageModelCosts({
      daily: [
        {
          modelBreakdowns: [
            { cost: 1.5, modelName: FABLE_MODEL },
            { cost: 0.25, modelName: SONNET_MODEL },
          ],
        },
        { modelBreakdowns: [{ cost: 2, modelName: FABLE_MODEL }] },
      ],
    });

    expect(costs.get(FABLE_MODEL)).toBe(3.5);
    expect(costs.get(SONNET_MODEL)).toBe(0.25);
  });

  test("reads the bare array shape and strips provider prefixes", () => {
    const costs = extractCcusageModelCosts([
      { modelBreakdowns: [{ cost: 4, modelName: `anthropic/${FABLE_MODEL}` }] },
    ]);

    expect([...costs]).toEqual([[FABLE_MODEL, 4]]);
  });

  test("ignores days without a usable breakdown", () => {
    expect(extractCcusageModelCosts({ daily: [{ totalCost: 3 }, { modelBreakdowns: [] }] }).size)
      .toBe(0);
  });

  test("rejects a report with no recognizable entries", () => {
    expect(() => extractCcusageModelCosts({ totals: { totalCost: 5 } })).toThrow(
      "ccusage JSON did not contain per-model breakdowns.",
    );
  });
});

describe("splitCostsByMeteredModel", () => {
  test("totals only metered models and names the rest without costs", () => {
    const split = splitCostsByMeteredModel(
      new Map([[FABLE_MODEL, 3], [SONNET_MODEL, 40]]),
      new Set([FABLE_MODEL]),
    );

    expect(split).toEqual({ meteredTotalUsd: 3, unmeteredModels: [SONNET_MODEL] });
  });
});

describe("queryKimiAuditTotals", () => {
  test("excludes Claude calls from the Kimi ccusage comparison", () => {
    const database = openDashboardDatabase(":memory:");
    try {
      const ledger = meteringLedger(database);
      insertSource(database, "kimi-session", "moonshotai", "kimi-wire");
      insertSource(database, "claude-session", "anthropic", "claude-wire");
      recordUsage(ledger, "kimi-session", "kimi-wire", "moonshot-ai/kimi-k3");
      recordUsage(ledger, "claude-session", "claude-wire", FABLE_MODEL);

      expect(queryKimiAuditTotals(database)).toEqual({
        canonical_call_count: 1,
        occurrence_count: 1,
        total_cost_nano: 4,
      });
    } finally {
      database.close();
    }
  });
});

describe("queryClaudeAuditTotals", () => {
  test("counts only Claude calls the account policy metered", () => {
    const database = openDashboardDatabase(":memory:");
    try {
      seedProAccountCalls(database);

      expect(queryClaudeAuditTotals(database)).toEqual({
        canonical_call_count: 1,
        occurrence_count: 1,
        total_cost_nano: 4,
      });
      expect([...queryMeteredClaudeModelKeys(database)]).toEqual([FABLE_MODEL]);
    } finally {
      database.close();
    }
  });
});

describe("auditKimiWithCcusage", () => {
  test("reports not-detected without running ccusage when no Kimi calls exist", async () => {
    const database = openDashboardDatabase(":memory:");
    try {
      seedProAccountCalls(database);
      const runs: string[][] = [];

      expect(await auditKimiWithCcusage(database, recordingRunner(runs, {}))).toEqual({
        reason: "no moonshotai calls in the ledger",
        status: "not-detected",
      });
      expect(runs).toEqual([]);
    } finally {
      database.close();
    }
  });

  test("reports a ccusage failure instead of throwing", async () => {
    const database = openDashboardDatabase(":memory:");
    try {
      insertSource(database, "kimi-session", "moonshotai", "kimi-wire");
      recordUsage(meteringLedger(database), "kimi-session", "kimi-wire", "moonshot-ai/kimi-k3");

      const report = await auditKimiWithCcusage(database, () => {
        throw new Error("ccusage audit failed with exit code 1: not installed");
      });

      expect(report).toEqual({
        error: "ccusage audit failed with exit code 1: not installed",
        status: "failed",
      });
    } finally {
      database.close();
    }
  });
});

describe("auditClaudeWithCcusage", () => {
  test("compares only the models metered under the account policy", async () => {
    const database = openDashboardDatabase(":memory:");
    try {
      seedProAccountCalls(database);
      const runs: string[][] = [];
      const report = await auditClaudeWithCcusage(database, recordingRunner(runs, {
        daily: [{
          modelBreakdowns: [
            { cost: 0.000_000_004, modelName: FABLE_MODEL },
            { cost: 25, modelName: SONNET_MODEL },
          ],
        }],
      }));

      expect(runs).toEqual([["ccusage", "claude", "daily", "--json", "--mode", "calculate"]]);
      expect(report).toEqual({
        canonicalCallCount: 1,
        ccusageTotalUsd: 0.000_000_004,
        differenceUsd: 0,
        localTotalUsd: 0.000_000_004,
        meteredModels: [FABLE_MODEL],
        meteringPolicy: null,
        occurrenceCount: 1,
        replayExcludedCount: 0,
        status: "compared",
        subscriptionType: null,
        unmeteredModels: [SONNET_MODEL],
      });
    } finally {
      database.close();
    }
  });

  test("reports not-detected without running ccusage when no Claude calls exist", async () => {
    const database = openDashboardDatabase(":memory:");
    try {
      insertSource(database, "kimi-session", "moonshotai", "kimi-wire");
      recordUsage(meteringLedger(database), "kimi-session", "kimi-wire", "moonshot-ai/kimi-k3");
      const runs: string[][] = [];

      expect(await auditClaudeWithCcusage(database, recordingRunner(runs, {}))).toEqual({
        reason: "no anthropic calls in the ledger",
        status: "not-detected",
      });
      expect(runs).toEqual([]);
    } finally {
      database.close();
    }
  });

  test("separates an unmetered Claude account from a zero-difference comparison", async () => {
    const database = openDashboardDatabase(":memory:");
    try {
      insertSource(database, "claude-session", "anthropic", "claude-wire");
      recordUsage(
        meteringLedger(database, () => meterNothing()),
        "claude-session",
        "claude-wire",
        SONNET_MODEL,
      );
      const runs: string[][] = [];
      const report = await auditClaudeWithCcusage(database, recordingRunner(runs, {}));

      expect(report).toEqual({
        meteringPolicy: null,
        reason: "Claude calls exist but the undetected account policy meters none of them.",
        status: "nothing-metered",
        subscriptionType: null,
      });
      expect(runs).toEqual([]);
    } finally {
      database.close();
    }
  });
});

function seedProAccountCalls(database: Database): void {
  const ledger = meteringLedger(database, (_provider, rawModel) => ({
    accountStateId: null,
    basis: rawModel === FABLE_MODEL ? "pro-fable" : "pro-subscription-excluded",
    isMetered: rawModel === FABLE_MODEL,
  }));
  insertSource(database, "fable-session", "anthropic", "fable-wire");
  insertSource(database, "sonnet-session", "anthropic", "sonnet-wire");
  recordUsage(ledger, "fable-session", "fable-wire", FABLE_MODEL);
  recordUsage(ledger, "sonnet-session", "sonnet-wire", SONNET_MODEL);
}

function meterNothing(): ReturnType<MeteringResolver> {
  return { accountStateId: null, basis: "account-status-unavailable", isMetered: false };
}

function recordingRunner(runs: string[][], response: unknown): CcusageRunner {
  return (commandArguments) => {
    runs.push([...commandArguments]);
    return Promise.resolve(response);
  };
}

function meteringLedger(database: Database, resolveMetering?: MeteringResolver): CallLedger {
  return new CallLedger(
    database,
    callPricing(() => ({
      basis: "test",
      cacheCreation1hNanoPerToken: 1,
      cacheCreation5mNanoPerToken: 1,
      cacheCreationNanoPerToken: 1,
      cacheReadNanoPerToken: 1,
      confidence: "exact",
      inputNanoPerToken: 1,
      outputNanoPerToken: 1,
      rateId: null,
      resolvedModelKey: "test/model",
    })),
    resolveMetering,
  );
}

function insertSource(
  database: Database,
  sessionId: string,
  provider: string,
  sourcePath: string,
): void {
  database.query(`
    INSERT INTO sessions (
      session_id, provider, workspace_key, created_at_ms, updated_at_ms, parse_status
    ) VALUES (?, ?, 'workspace', 1, 1, 'ok')
  `).run(sessionId, provider);
  database.query(`
    INSERT INTO agents (session_id, agent_id, agent_type, source_directory)
    VALUES (?, 'main', 'main', ?)
  `).run(sessionId, sourcePath);
  database.query(`
    INSERT INTO source_files (path, source_root, session_id, agent_id)
    VALUES (?, 'root', ?, 'main')
  `).run(sourcePath, sessionId);
}

function recordUsage(
  ledger: CallLedger,
  sessionId: string,
  sourcePath: string,
  model: string,
): void {
  ledger.recordUsage({ agentId: "main", generation: 0, sessionId, sourcePath }, {
    byteOffset: 1,
    model,
    providerRequestId: `${sessionId}-request`,
    requestMetadata: null,
    stepUuid: null,
    timestampMs: 1,
    tokens: {
      cacheCreation: 1,
      cacheCreation1h: 0,
      cacheCreation5m: 0,
      cacheRead: 1,
      inputOther: 1,
      output: 1,
    },
  });
}

function callPricing(resolve: RateResolver): CallPricing {
  return { resolve, resolveByRateId: () => null };
}
