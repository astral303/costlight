import { describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { CallLedger } from "../../src/call-accounting/ledger";
import { openDashboardDatabase } from "../../src/app/database";
import type { ParsedUsageRecord } from "../../src/session-import/types";

describe("CallLedger", () => {
  test("charges a replayed provider request once and uses the earliest session", () => {
    const database = openDashboardDatabase(":memory:");
    try {
      insertSource(database, "newer-session", 200, "newer-wire");
      insertSource(database, "older-session", 100, "older-wire");
      const ledger = new CallLedger(database);
      const usage = createUsageRecord("shared-request");

      ledger.recordUsage({
        agentId: "main",
        generation: 0,
        sessionId: "newer-session",
        sourcePath: "newer-wire",
      }, usage);
      ledger.recordUsage({
        agentId: "main",
        generation: 0,
        sessionId: "older-session",
        sourcePath: "older-wire",
      }, usage);

      const canonicalCall = database
        .query<{ session_id: string }, []>("SELECT session_id FROM api_calls")
        .get();
      const occurrenceCounts = database
        .query<{ canonical_count: number; occurrence_count: number }, []>(`
          SELECT COUNT(*) AS occurrence_count, SUM(is_canonical) AS canonical_count
          FROM usage_occurrences
        `)
        .get();
      expect(canonicalCall?.session_id).toBe("older-session");
      expect(occurrenceCounts).toEqual({ canonical_count: 1, occurrence_count: 2 });

      ledger.removeSourceOccurrences("older-wire");
      expect(
        database.query<{ session_id: string }, []>("SELECT session_id FROM api_calls").get()?.session_id,
      ).toBe("newer-session");
    } finally {
      database.close();
    }
  });

  test("preserves historical rates until repricing is explicitly requested", () => {
    const database = openDashboardDatabase(":memory:");
    try {
      insertSource(database, "session-1", 100, "wire-1");
      insertSource(database, "session-2", 200, "wire-2");
      let nanoPerToken = 1;
      const ledger = new CallLedger(database, () => ({
        basis: "test rate",
        cacheCreationNanoPerToken: nanoPerToken,
        cacheReadNanoPerToken: nanoPerToken,
        confidence: "exact",
        inputNanoPerToken: nanoPerToken,
        outputNanoPerToken: nanoPerToken,
        rateId: null,
        resolvedModelKey: "moonshotai/kimi-k3",
      }));
      const usage = createUsageRecord("stable-price-request");
      ledger.recordUsage({
        agentId: "main",
        generation: 0,
        sessionId: "session-1",
        sourcePath: "wire-1",
      }, usage);

      nanoPerToken = 2;
      ledger.recordUsage({
        agentId: "main",
        generation: 0,
        sessionId: "session-2",
        sourcePath: "wire-2",
      }, usage);
      expect(readTotalCost(database)).toBe(460);

      ledger.repriceAllCalls();
      expect(readTotalCost(database)).toBe(920);
    } finally {
      database.close();
    }
  });
});

function insertSource(
  database: Database,
  sessionId: string,
  createdAtMs: number,
  sourcePath: string,
): void {
  database
    .query(`
      INSERT INTO sessions (
        session_id, workspace_key, created_at_ms, updated_at_ms, parse_status
      ) VALUES (?, 'workspace', ?, ?, 'ok')
    `)
    .run(sessionId, createdAtMs, createdAtMs);
  database
    .query(`
      INSERT INTO agents (session_id, agent_id, agent_type, source_directory)
      VALUES (?, 'main', 'main', ?)
    `)
    .run(sessionId, sourcePath);
  database
    .query(`
      INSERT INTO source_files (path, source_root, session_id, agent_id)
      VALUES (?, 'root', ?, 'main')
    `)
    .run(sourcePath, sessionId);
}

function createUsageRecord(providerRequestId: string): ParsedUsageRecord {
  return {
    byteOffset: 10,
    model: "moonshot-ai/kimi-k3",
    providerRequestId,
    requestMetadata: null,
    stepUuid: "step-1",
    timestampMs: 1_785_585_600_000,
    tokens: {
      cacheCreation: 20,
      cacheRead: 300,
      inputOther: 100,
      output: 40,
    },
  };
}

function readTotalCost(database: Database): number | null {
  return database
    .query<{ total_cost_nano: number | null }, []>("SELECT total_cost_nano FROM api_calls")
    .get()?.total_cost_nano ?? null;
}
