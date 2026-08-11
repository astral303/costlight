import { describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { CallLedger } from "../../src/call-accounting/ledger";
import { openDashboardDatabase } from "../../src/app/database";
import type { DashboardFilters } from "../../src/dashboard/contracts";
import {
  queryAgents,
  queryFilterOptions,
  queryModels,
  querySessions,
  querySummary,
  queryTimeseries,
} from "../../src/dashboard/queries";
import type { ParsedUsageRecord } from "../../src/session-import/types";

const filters: DashboardFilters = {
  bucket: "auto",
  sessionSort: "cost",
  timeZone: "America/New_York",
};

describe("dashboard queries", () => {
  test("reconciles summary, series, session, model, and agent totals", () => {
    const database = openDashboardDatabase(":memory:");
    try {
      insertSource(database, "session-a", "main", "main", 100, "wire-a");
      insertSource(database, "session-b", "agent-0", "sub", 200, "wire-b");
      const ledger = new CallLedger(database, () => ({
        basis: "test catalog",
        cacheCreationNanoPerToken: 4,
        cacheReadNanoPerToken: 2,
        confidence: "exact",
        inputNanoPerToken: 3,
        outputNanoPerToken: 5,
        rateId: null,
        resolvedModelKey: "moonshotai/kimi-k3",
      }));
      ledger.recordUsage({
        agentId: "main",
        generation: 0,
        sessionId: "session-a",
        sourcePath: "wire-a",
      }, createUsage("shared-request", 1_000));
      ledger.recordUsage({
        agentId: "agent-0",
        generation: 0,
        sessionId: "session-b",
        sourcePath: "wire-b",
      }, createUsage("shared-request", 1_000));
      ledger.recordUsage({
        agentId: "agent-0",
        generation: 0,
        sessionId: "session-b",
        sourcePath: "wire-b",
      }, { ...createUsage("subagent-request", 2_000), byteOffset: 20 });

      const summary = querySummary(database, filters, 3_000);
      const timeseries = queryTimeseries(database, filters);
      const sessions = querySessions(database, filters, false);
      const models = queryModels(database, filters);
      const agents = queryAgents(database, "session-b", filters);

      expect(summary.callCount).toBe(2);
      expect(summary.replayExcludedCount).toBe(1);
      expect(summary.totalCostNano).toBeGreaterThan(0);
      expect(sum(timeseries.points.map((point) => point.totalCostNano))).toBe(summary.totalCostNano);
      expect(sum(sessions.map((session) => session.totalCostNano))).toBe(summary.totalCostNano);
      expect(sum(models.map((model) => model.totalCostNano))).toBe(summary.totalCostNano);
      const subagentSessionCost = sessions.find(
        (session) => session.sessionId === "session-b",
      )?.totalCostNano;
      expect(subagentSessionCost).toBeDefined();
      expect(sum(agents.map((agent) => agent.totalCostNano))).toBe(subagentSessionCost ?? -1);
      expect(timeseries.points.at(-1)?.cumulativeTotalCostNano).toBe(summary.totalCostNano);
    } finally {
      database.close();
    }
  });

  test("labels paid session filters and omits zero-spend sessions", () => {
    const database = openDashboardDatabase(":memory:");
    try {
      const longTitle = `  ${"A".repeat(60)}\nignored spacing  `;
      insertSource(database, "session-a", "main", "main", 100, "wire-a", {
        title: longTitle,
        workspaceKey: "wd_project_123",
      });
      insertSource(database, "session-zero", "main", "main", 200, "wire-zero", {
        title: "No spend",
        workspaceKey: "wd_project_123",
      });
      const ledger = new CallLedger(database, () => ({
        basis: "test catalog",
        cacheCreationNanoPerToken: 1_000_000,
        cacheReadNanoPerToken: 1_000_000,
        confidence: "exact",
        inputNanoPerToken: 1_000_000,
        outputNanoPerToken: 1_000_000,
        rateId: null,
        resolvedModelKey: "moonshotai/kimi-k3",
      }));
      ledger.recordUsage({
        agentId: "main",
        generation: 0,
        sessionId: "session-a",
        sourcePath: "wire-a",
      }, createUsage("session-request", 1_000));

      const options = queryFilterOptions(database, false);

      expect(options.sessions).toEqual([{
        label: `$0.46 · ${"A".repeat(47)}… · wd_project_123`,
        value: "session-a",
        workspace: "wd_project_123",
      }]);
    } finally {
      database.close();
    }
  });

  test("returns every canonical call when one session is selected", () => {
    const database = openDashboardDatabase(":memory:");
    try {
      insertSource(database, "session-a", "main", "main", 100, "wire-a");
      const ledger = new CallLedger(database, () => ({
        basis: "test catalog",
        cacheCreationNanoPerToken: 1_000_000,
        cacheReadNanoPerToken: 1_000_000,
        confidence: "exact",
        inputNanoPerToken: 1_000_000,
        outputNanoPerToken: 1_000_000,
        rateId: null,
        resolvedModelKey: "moonshotai/kimi-k3",
      }));
      ledger.recordUsage({
        agentId: "main",
        generation: 0,
        sessionId: "session-a",
        sourcePath: "wire-a",
      }, createUsage("first-request", 1_000));
      ledger.recordUsage({
        agentId: "main",
        generation: 0,
        sessionId: "session-a",
        sourcePath: "wire-a",
      }, { ...createUsage("second-request", 2_000), byteOffset: 20 });

      const timeseries = queryTimeseries(database, {
        ...filters,
        bucket: "day",
        sessionId: "session-a",
      });

      expect(timeseries.resolution).toBe("call");
      expect(timeseries.points.map((point) => point.bucketStartMs)).toEqual([1_000, 2_000]);
      expect(timeseries.points.map((point) => point.callCount)).toEqual([1, 1]);
      expect(timeseries.points.map((point) => point.totalCostNano)).toEqual([460_000_000, 460_000_000]);
      expect(timeseries.points.at(-1)?.cumulativeTotalCostNano).toBe(920_000_000);
    } finally {
      database.close();
    }
  });
});

function insertSource(
  database: Database,
  sessionId: string,
  agentId: string,
  agentType: "main" | "sub",
  createdAtMs: number,
  sourcePath: string,
  session: { title?: string; workspaceKey?: string } = {},
): void {
  const workspaceKey = session.workspaceKey ?? "workspace";
  const title = session.title ?? null;
  database.query(`
    INSERT INTO sessions (session_id, workspace_key, title, created_at_ms, updated_at_ms, parse_status)
    VALUES (?, ?, ?, ?, ?, 'ok')
  `).run(sessionId, workspaceKey, title, createdAtMs, createdAtMs);
  database.query(`
    INSERT INTO agents (session_id, agent_id, agent_type, parent_agent_id, source_directory)
    VALUES (?, ?, ?, ?, ?)
  `).run(sessionId, agentId, agentType, agentType === "sub" ? "main" : null, sourcePath);
  if (agentType === "sub") {
    database.query(`
      INSERT INTO agents (session_id, agent_id, agent_type, source_directory)
      VALUES (?, 'main', 'main', ?)
    `).run(sessionId, `${sourcePath}-main`);
  }
  database.query(`
    INSERT INTO source_files (path, source_root, session_id, agent_id)
    VALUES (?, 'root', ?, ?)
  `).run(sourcePath, sessionId, agentId);
}

function createUsage(providerRequestId: string, timestampMs: number): ParsedUsageRecord {
  return {
    byteOffset: 10,
    model: "moonshot-ai/kimi-k3",
    providerRequestId,
    requestMetadata: null,
    stepUuid: `${providerRequestId}-step`,
    timestampMs,
    tokens: { cacheCreation: 20, cacheRead: 300, inputOther: 100, output: 40 },
  };
}

function sum(values: readonly number[]): number {
  return values.reduce((total, value) => total + value, 0);
}
