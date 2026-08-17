import { describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { openDashboardDatabase } from "../../src/app/database";
import {
  auditClaudeAgainstUsageReport,
  type ClaudeUsageAuditReport,
  type ClaudeUsageAuditSummary,
  formatUsageComparisonCsv,
  type UsageComparisonRow,
} from "../../src/call-accounting/anthropic-usage-audit";
import type {
  AnthropicUsageReport,
  UsageDayTotals,
  UsageTotals,
} from "../../src/call-accounting/anthropic-usage-report";

const OPUS_MODEL = "claude-opus-4-8";
const SONNET_MODEL = "claude-sonnet-5";
const NANO_PER_USD = 1_000_000_000;
const NOON_AUGUST_3_UTC = Date.UTC(2026, 7, 3, 12);
const NOON_AUGUST_4_UTC = Date.UTC(2026, 7, 4, 12);

interface SeededCall {
  costUsd: number | null;
  isMetered?: boolean;
  modelKey: string;
  timestampMs: number;
  tokens?: Partial<UsageTotals["tokens"]>;
}

interface ComparedAudit {
  rows: readonly UsageComparisonRow[];
  summary: ClaudeUsageAuditSummary;
}

describe("auditClaudeAgainstUsageReport", () => {
  test("compares metered Claude calls against the export day by day", () => {
    withLedger([
      { costUsd: 4, modelKey: OPUS_MODEL, timestampMs: NOON_AUGUST_3_UTC },
      { costUsd: 5, modelKey: OPUS_MODEL, timestampMs: NOON_AUGUST_3_UTC },
      { costUsd: 20, modelKey: OPUS_MODEL, timestampMs: NOON_AUGUST_4_UTC },
    ], (database) => {
      const { rows, summary } = expectCompared(auditClaudeAgainstUsageReport(database, usageReport([
        reportDay({ costUsd: 10, date: "2026-08-03", modelKey: OPUS_MODEL, requestCount: 155 }),
        reportDay({ costUsd: 20, date: "2026-08-04", modelKey: OPUS_MODEL, requestCount: 242 }),
      ]), "UTC"));

      expect(summary.totals).toEqual({
        anthropicUsd: 30,
        costlightUsd: 29,
        differencePercent: (-1 / 30) * 100,
        differenceUsd: -1,
      });
      expect(summary.requestCounts).toEqual({ anthropic: 397, costlight: 3 });
      expect(comparedCosts(rows)).toEqual([["2026-08-03", 10, 9], ["2026-08-04", 20, 20]]);
    });
  });

  test("counts calls the policy left unmetered and metered calls no rate priced", () => {
    withLedger([
      { costUsd: 6, modelKey: OPUS_MODEL, timestampMs: NOON_AUGUST_3_UTC },
      { costUsd: null, modelKey: OPUS_MODEL, timestampMs: NOON_AUGUST_3_UTC },
      { costUsd: 40, isMetered: false, modelKey: SONNET_MODEL, timestampMs: NOON_AUGUST_3_UTC },
    ], (database) => {
      const { rows, summary } = expectCompared(auditClaudeAgainstUsageReport(database, usageReport([
        reportDay({ costUsd: 6, date: "2026-08-03", modelKey: OPUS_MODEL }),
      ]), "UTC"));

      expect(summary.ledgerGaps).toEqual({ unmeteredCallCount: 1, unpricedCallCount: 1 });
      expect(summary.totals.costlightUsd).toBe(6);
      expect(summary.requestCounts.costlight).toBe(2);
      expect(rows.map((row) => row.modelKey)).toEqual([OPUS_MODEL]);
    });
  });

  test("keeps a model that only one side recorded and ranks the largest deviation first", () => {
    withLedger([{ costUsd: 3, modelKey: OPUS_MODEL, timestampMs: NOON_AUGUST_3_UTC }], (database) => {
      const { rows, summary } = expectCompared(auditClaudeAgainstUsageReport(database, usageReport([
        reportDay({ costUsd: 25, date: "2026-08-03", modelKey: SONNET_MODEL }),
      ]), "UTC"));

      expect(summary.modelDeviations).toEqual([
        { anthropicUsd: 25, costlightUsd: 0, differenceUsd: -25, modelKey: SONNET_MODEL },
        { anthropicUsd: 0, costlightUsd: 3, differenceUsd: 3, modelKey: OPUS_MODEL },
      ]);
      expect(rows).toHaveLength(2);
    });
  });

  test("assigns each call to a day in the requested time zone", () => {
    const justAfterUtcMidnight = Date.UTC(2026, 7, 4, 1);
    withLedger([
      { costUsd: 7, modelKey: OPUS_MODEL, timestampMs: justAfterUtcMidnight },
    ], (database) => {
      const august3Only = usageReport([
        reportDay({ costUsd: 7, date: "2026-08-03", modelKey: OPUS_MODEL }),
      ]);

      const newYork = expectCompared(
        auditClaudeAgainstUsageReport(database, august3Only, "America/New_York"),
      );
      const utc = expectCompared(auditClaudeAgainstUsageReport(database, august3Only, "UTC"));

      expect(comparedCosts(newYork.rows)).toEqual([["2026-08-03", 7, 7]]);
      expect(comparedCosts(utc.rows)).toEqual([["2026-08-03", 7, 0], ["2026-08-04", 0, 7]]);
    });
  });

  test("reports not-detected when the ledger holds no Claude calls", () => {
    withLedger([], (database) => {
      const report = auditClaudeAgainstUsageReport(database, usageReport([]), "UTC");

      expect(report).toEqual({ reason: "no anthropic calls in the ledger", status: "not-detected" });
    });
  });

  test("separates an unmetered account from a zero-difference comparison", () => {
    withLedger([
      { costUsd: 12, isMetered: false, modelKey: SONNET_MODEL, timestampMs: NOON_AUGUST_3_UTC },
    ], (database) => {
      const report = auditClaudeAgainstUsageReport(database, usageReport([]), "UTC");

      expect(report).toEqual({
        meteringPolicy: null,
        reason: "Claude calls exist but the undetected account policy meters none of them.",
        status: "nothing-metered",
        subscriptionType: null,
      });
    });
  });
});

describe("formatUsageComparisonCsv", () => {
  test("writes Anthropic, Costlight and difference rows for each day and model", () => {
    const row: UsageComparisonRow = {
      anthropic: totals(17.85, 155, { cacheRead: 400, cacheWrite5m: 30, input: 100, output: 200 }),
      costlight: totals(15.2, 140, { cacheRead: 350, cacheWrite5m: 30, input: 90, output: 180 }),
      date: "2026-08-03",
      modelKey: OPUS_MODEL,
    };

    expect(formatUsageComparisonCsv([row], "long")).toBe([
      "date,model,source,cost_usd,requests,input,output,"
      + "cache_read,cache_write_5m,cache_write_1h,cache_write_untyped",
      "2026-08-03,claude-opus-4-8,anthropic,17.8500,155,100,200,400,30,0,0",
      "2026-08-03,claude-opus-4-8,costlight,15.2000,140,90,180,350,30,0,0",
      "2026-08-03,claude-opus-4-8,difference,-2.6500,-15,-10,-20,-50,0,0,0",
      "",
    ].join("\n"));
  });

  test("puts the three sources side by side per measure in the wide layout", () => {
    const row: UsageComparisonRow = {
      anthropic: totals(17.85, 155, { input: 100, output: 200 }),
      costlight: totals(15.2, 140, { input: 90, output: 180 }),
      date: "2026-08-03",
      modelKey: OPUS_MODEL,
    };

    expect(formatUsageComparisonCsv([row], "wide")).toBe([
      "date,model,"
      + "anthropic.cost_usd,costlight.cost_usd,difference.cost_usd,"
      + "anthropic.requests,costlight.requests,difference.requests,"
      + "anthropic.input,costlight.input,difference.input,"
      + "anthropic.output,costlight.output,difference.output,"
      + "anthropic.cache_read,costlight.cache_read,difference.cache_read,"
      + "anthropic.cache_write_5m,costlight.cache_write_5m,difference.cache_write_5m,"
      + "anthropic.cache_write_1h,costlight.cache_write_1h,difference.cache_write_1h,"
      + "anthropic.cache_write_untyped,costlight.cache_write_untyped,"
      + "difference.cache_write_untyped",
      "2026-08-03,claude-opus-4-8,"
      + "17.8500,15.2000,-2.6500,"
      + "155,140,-15,"
      + "100,90,-10,"
      + "200,180,-20,"
      + "0,0,0,0,0,0,0,0,0,0,0,0",
      "",
    ].join("\n"));
  });

  test("quotes a model name that would otherwise split the row", () => {
    const row: UsageComparisonRow = {
      anthropic: totals(1, 1, {}),
      costlight: totals(1, 1, {}),
      date: "2026-08-03",
      modelKey: 'claude,"odd"',
    };

    expect(formatUsageComparisonCsv([row], "long").split("\n")[1])
      .toBe('2026-08-03,"claude,""odd""",anthropic,1.0000,1,0,0,0,0,0,0');
  });
});

function expectCompared(report: ClaudeUsageAuditReport): ComparedAudit {
  if (report.status !== "compared") {
    throw new Error(`expected a comparison but the audit reported ${report.status}`);
  }

  return { rows: report.rows, summary: report.summary };
}

function comparedCosts(
  rows: readonly UsageComparisonRow[],
): readonly (readonly [string, number, number])[] {
  return rows.map((row) => [row.date, row.anthropic.costUsd, row.costlight.costUsd] as const);
}

function withLedger(calls: readonly SeededCall[], assert: (database: Database) => void): void {
  const database = openDashboardDatabase(":memory:");
  try {
    insertSession(database);
    calls.forEach((call, index) => insertCall(database, call, index));
    assert(database);
  } finally {
    database.close();
  }
}

function insertSession(database: Database): void {
  database.query(`
    INSERT INTO sessions (
      session_id, provider, workspace_key, created_at_ms, updated_at_ms, parse_status
    ) VALUES ('claude-session', 'anthropic', 'workspace', 1, 1, 'ok')
  `).run();
  database.query(`
    INSERT INTO agents (session_id, agent_id, agent_type, source_directory)
    VALUES ('claude-session', 'main', 'main', 'claude-wire')
  `).run();
}

function insertCall(database: Database, call: SeededCall, index: number): void {
  const tokens = {
    cacheRead: 0,
    cacheWrite1h: 0,
    cacheWrite5m: 0,
    input: 0,
    output: 0,
    ...call.tokens,
  };
  database.query(`
    INSERT INTO api_calls (
      event_fingerprint, canonical_source_path, canonical_generation, canonical_byte_offset,
      timestamp_ms, provider, raw_model, resolved_model_key, input_other_tokens,
      cache_creation_tokens, cache_creation_5m_tokens, cache_creation_1h_tokens,
      cache_read_tokens, output_tokens, session_id, agent_id, total_cost_nano, is_metered,
      pricing_confidence, pricing_basis
    ) VALUES (
      $fingerprint, 'claude-wire', 0, $fingerprintOffset, $timestampMs, 'anthropic',
      $modelKey, $modelKey, $input, 0, $cacheWrite5m, $cacheWrite1h, $cacheRead, $output,
      'claude-session', 'main', $totalCostNano, $isMetered, 'exact', 'test'
    )
  `).run({
    cacheRead: tokens.cacheRead,
    cacheWrite1h: tokens.cacheWrite1h,
    cacheWrite5m: tokens.cacheWrite5m,
    fingerprint: `call-${index}`,
    fingerprintOffset: index,
    input: tokens.input,
    isMetered: (call.isMetered ?? true) ? 1 : 0,
    modelKey: call.modelKey,
    output: tokens.output,
    timestampMs: call.timestampMs,
    totalCostNano: call.costUsd === null ? null : call.costUsd * NANO_PER_USD,
  });
}

function usageReport(days: readonly UsageDayTotals[]): AnthropicUsageReport {
  return { days, endDate: "2026-08-04", startDate: "2026-08-03" };
}

function reportDay(
  day: { costUsd: number; date: string; modelKey: string; requestCount?: number },
): UsageDayTotals {
  return {
    ...totals(day.costUsd, day.requestCount ?? 1, {}),
    date: day.date,
    modelKey: day.modelKey,
  };
}

function totals(
  costUsd: number,
  requestCount: number,
  tokens: Partial<UsageTotals["tokens"]>,
): UsageTotals {
  return {
    costUsd,
    requestCount,
    tokens: {
      cacheRead: 0,
      cacheWrite1h: 0,
      cacheWrite5m: 0,
      cacheWriteUntyped: 0,
      input: 0,
      output: 0,
      ...tokens,
    },
  };
}
