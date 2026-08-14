import { describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { openDashboardDatabase } from "../../src/app/database";
import {
  extractCcusageTotalUsd,
  queryKimiAuditTotals,
} from "../../src/call-accounting/ccusage-audit";
import {
  type CallPricing,
  CallLedger,
  type RateResolver,
} from "../../src/call-accounting/ledger";

describe("extractCcusageTotalUsd", () => {
  test("reads aggregate and daily report shapes", () => {
    expect(extractCcusageTotalUsd({ totals: { totalCost: 12.5 } })).toBe(12.5);
    expect(extractCcusageTotalUsd({ daily: [{ totalCost: 1.25 }, { totalCost: 2.5 }] })).toBe(3.75);
    expect(extractCcusageTotalUsd([{ totalCost: 4 }, { totalCost: 5 }])).toBe(9);
  });
});

describe("queryKimiAuditTotals", () => {
  test("excludes Claude calls from the Kimi ccusage comparison", () => {
    const database = openDashboardDatabase(":memory:");
    try {
      insertSource(database, "kimi-session", "moonshotai", "kimi-wire");
      insertSource(database, "claude-session", "anthropic", "claude-wire");
      const ledger = new CallLedger(database, callPricing(() => ({
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
      })));
      recordUsage(ledger, "kimi-session", "kimi-wire", "moonshot-ai/kimi-k3");
      recordUsage(ledger, "claude-session", "claude-wire", "claude-fable-5");

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
