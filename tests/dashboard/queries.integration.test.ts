import { describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import {
  type CallPricing,
  CallLedger,
  type RateResolver,
} from "../../src/call-accounting/ledger";
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
      const ledger = new CallLedger(database, callPricing(() => ({
        basis: "test catalog",
        cacheCreation1hNanoPerToken: 4,
        cacheCreation5mNanoPerToken: 4,
        cacheCreationNanoPerToken: 4,
        cacheReadNanoPerToken: 2,
        confidence: "exact",
        inputNanoPerToken: 3,
        outputNanoPerToken: 5,
        rateId: null,
        resolvedModelKey: "moonshotai/kimi-k3",
      })));
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
      const ledger = new CallLedger(database, callPricing(() => ({
        basis: "test catalog",
        cacheCreation1hNanoPerToken: 1_000_000,
        cacheCreation5mNanoPerToken: 1_000_000,
        cacheCreationNanoPerToken: 1_000_000,
        cacheReadNanoPerToken: 1_000_000,
        confidence: "exact",
        inputNanoPerToken: 1_000_000,
        outputNanoPerToken: 1_000_000,
        rateId: null,
        resolvedModelKey: "moonshotai/kimi-k3",
      })));
      ledger.recordUsage({
        agentId: "main",
        generation: 0,
        sessionId: "session-a",
        sourcePath: "wire-a",
      }, createUsage("session-request", 1_000));

      const options = queryFilterOptions(database, false, undefined, 100);

      expect(options.sessions).toEqual([{
        label: `0m · $0.46 · ${"A".repeat(47)}… · wd_project_123`,
        provider: "moonshotai",
        recencyGroup: "Last 24 hours",
        value: "session-a",
        workspace: "wd_project_123",
      }]);
      expect(options.providers).toEqual([{ label: "Kimi", value: "moonshotai" }]);
    } finally {
      database.close();
    }
  });

  test("returns every canonical call when one session is selected", () => {
    const database = openDashboardDatabase(":memory:");
    try {
      insertSource(database, "session-a", "main", "main", 100, "wire-a");
      const ledger = new CallLedger(database, callPricing(() => ({
        basis: "test catalog",
        cacheCreation1hNanoPerToken: 1_000_000,
        cacheCreation5mNanoPerToken: 1_000_000,
        cacheCreationNanoPerToken: 1_000_000,
        cacheReadNanoPerToken: 1_000_000,
        confidence: "exact",
        inputNanoPerToken: 1_000_000,
        outputNanoPerToken: 1_000_000,
        rateId: null,
        resolvedModelKey: "moonshotai/kimi-k3",
      })));
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
      expect(timeseries.points.map((point) => point.promptTokens)).toEqual([420, 420]);
      expect(timeseries.points.map((point) => point.peakMainPromptTokens)).toEqual([420, 420]);
      expect(timeseries.points.map((point) => point.peakSubagentPromptTokens)).toEqual([0, 0]);
      expect(timeseries.points.map((point) => point.cacheReadTokens)).toEqual([300, 300]);
      // Without a stored rate row the counterfactual has nothing to price against.
      expect(timeseries.points.map((point) => point.noCacheExtraCostNano)).toEqual([0, 0]);
      expect(timeseries.points.at(-1)?.cumulativeNoCacheCostNano).toBe(920_000_000);
    } finally {
      database.close();
    }
  });

  test("splits the peak prompt between main and subagent calls", () => {
    const database = openDashboardDatabase(":memory:");
    try {
      insertSource(database, "session-a", "main", "main", 100, "wire-a");
      insertSource(database, "session-b", "agent-0", "sub", 200, "wire-b");
      const ledger = new CallLedger(database, callPricing(() => ({
        basis: "test catalog",
        cacheCreation1hNanoPerToken: 1_000_000,
        cacheCreation5mNanoPerToken: 1_000_000,
        cacheCreationNanoPerToken: 1_000_000,
        cacheReadNanoPerToken: 1_000_000,
        confidence: "exact",
        inputNanoPerToken: 1_000_000,
        outputNanoPerToken: 1_000_000,
        rateId: null,
        resolvedModelKey: "moonshotai/kimi-k3",
      })));
      ledger.recordUsage({
        agentId: "main",
        generation: 0,
        sessionId: "session-a",
        sourcePath: "wire-a",
      }, createUsage("main-request", 1_000));
      ledger.recordUsage({
        agentId: "agent-0",
        generation: 0,
        sessionId: "session-b",
        sourcePath: "wire-b",
      }, createUsage("subagent-request", 2_000));

      const bucketed = queryTimeseries(database, { ...filters, bucket: "day" });
      const subagentCalls = queryTimeseries(database, { ...filters, sessionId: "session-b" });

      expect(bucketed.resolution).toBe("day");
      expect(bucketed.points).toHaveLength(1);
      expect(bucketed.points[0]?.peakMainPromptTokens).toBe(420);
      expect(bucketed.points[0]?.peakSubagentPromptTokens).toBe(420);
      expect(subagentCalls.points.map((point) => point.peakMainPromptTokens)).toEqual([0]);
      expect(subagentCalls.points.map((point) => point.peakSubagentPromptTokens)).toEqual([420]);
    } finally {
      database.close();
    }
  });

  test("prices the no-cache counterfactual from each call's stored rate", () => {
    const database = openDashboardDatabase(":memory:");
    try {
      insertSource(database, "session-a", "main", "main", 100, "wire-a");
      database.query(`
        INSERT INTO model_rates (
          rate_id, provider, model_key, input_nano_per_token, output_nano_per_token,
          cache_read_nano_per_token, cache_creation_nano_per_token,
          source_name, confidence, created_at_ms
        ) VALUES (7, 'moonshotai', 'moonshotai/kimi-k3', 1000, 5000, 100, 1250, 'test catalog', 'exact', 0)
      `).run();
      const ledger = new CallLedger(database, callPricing(() => ({
        basis: "test catalog",
        cacheCreation1hNanoPerToken: 1_250,
        cacheCreation5mNanoPerToken: 1_250,
        cacheCreationNanoPerToken: 1_250,
        cacheReadNanoPerToken: 100,
        confidence: "exact",
        inputNanoPerToken: 1_000,
        outputNanoPerToken: 5_000,
        rateId: 7,
        resolvedModelKey: "moonshotai/kimi-k3",
      })));
      ledger.recordUsage({
        agentId: "main",
        generation: 0,
        sessionId: "session-a",
        sourcePath: "wire-a",
      }, createUsage("priced-request", 1_000));

      const timeseries = queryTimeseries(database, { ...filters, sessionId: "session-a" });

      // 300 cache-read tokens at the 1_000 input rate instead of the 100 read rate.
      const expectedExtraNano = 300 * 1_000 - 300 * 100;
      expect(timeseries.points.map((point) => point.noCacheExtraCostNano))
        .toEqual([expectedExtraNano]);
      expect(timeseries.points.at(-1)?.cumulativeNoCacheCostNano)
        .toBe((timeseries.points.at(-1)?.cumulativeTotalCostNano ?? 0) + expectedExtraNano);
    } finally {
      database.close();
    }
  });

  test("excludes non-metered calls from every visible aggregate and filter", () => {
    const database = openDashboardDatabase(":memory:");
    try {
      insertSource(database, "metered", "main", "main", 100, "metered-wire", {
        provider: "anthropic",
        title: "Metered Fable",
      });
      insertSource(database, "excluded", "main", "main", 200, "excluded-wire", {
        provider: "anthropic",
        title: "Subscription Opus",
      });
      const ledger = new CallLedger(
        database,
        callPricing(() => ({
          basis: "test catalog",
          cacheCreation1hNanoPerToken: 1,
          cacheCreation5mNanoPerToken: 1,
          cacheCreationNanoPerToken: 1,
          cacheReadNanoPerToken: 1,
          confidence: "exact",
          inputNanoPerToken: 1,
          outputNanoPerToken: 1,
          rateId: null,
          resolvedModelKey: "anthropic/test",
        })),
        (_provider, model) => ({
          accountStateId: null,
          basis: model === "claude-fable-5" ? "pro-fable" : "pro-subscription-excluded",
          isMetered: model === "claude-fable-5",
        }),
      );
      ledger.recordUsage(
        { agentId: "main", generation: 0, sessionId: "metered", sourcePath: "metered-wire" },
        { ...createUsage("metered", 1_000), model: "claude-fable-5" },
      );
      ledger.recordUsage(
        { agentId: "main", generation: 0, sessionId: "excluded", sourcePath: "excluded-wire" },
        { ...createUsage("excluded", 2_000), model: "claude-opus-5" },
      );

      expect(querySummary(database, filters, 3_000).callCount).toBe(1);
      expect(queryTimeseries(database, filters).points).toHaveLength(1);
      expect(querySessions(database, filters, false).map((session) => session.sessionId))
        .toEqual(["metered"]);
      expect(queryModels(database, filters).map((model) => model.rawModel))
        .toEqual(["claude-fable-5"]);
      expect(queryFilterOptions(database, false, undefined).sessions.map((session) => session.value))
        .toEqual(["metered"]);
      expect(database.query<{ count: number }, []>(`
        SELECT COUNT(*) AS count FROM usage_occurrences
      `).get()?.count).toBe(2);
    } finally {
      database.close();
    }
  });

  test("scopes filter options to a provider and groups Claude runs by role", () => {
    const database = openDashboardDatabase(":memory:");
    try {
      insertSource(database, "claude-session", "claude-run-1", "sub", 100, "claude-wire", {
        agentKey: "agent:Explore",
        agentLabel: "Explore",
        provider: "anthropic",
        title: "Claude work",
        workspaceKey: "claude-workspace",
      });
      insertSource(database, "claude-session-2", "claude-run-2", "sub", 150, "claude-wire-2", {
        agentKey: "agent:Explore",
        agentLabel: "Explore",
        provider: "anthropic",
        title: "More Claude work",
        workspaceKey: "claude-workspace",
      });
      database.query(`
        INSERT INTO agents (
          session_id, agent_id, agent_key, agent_label, agent_type,
          parent_agent_id, source_directory
        ) VALUES (
          'claude-session', 'claude-run-3', 'agent:Explore', 'Explore',
          'sub', 'main', 'claude-wire-3'
        )
      `).run();
      database.query(`
        INSERT INTO source_files (path, source_root, session_id, agent_id)
        VALUES ('claude-wire-3', 'root', 'claude-session', 'claude-run-3')
      `).run();
      insertSource(database, "kimi-session", "main", "main", 200, "kimi-wire", {
        provider: "moonshotai",
        title: "Kimi work",
        workspaceKey: "kimi-workspace",
      });
      const ledger = new CallLedger(database, callPricing(() => ({
        basis: "test catalog",
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
      ledger.recordUsage(
        {
          agentId: "claude-run-3",
          generation: 0,
          sessionId: "claude-session",
          sourcePath: "claude-wire-3",
        },
        { ...createUsage("claude-request-3", 1_250), model: "claude-opus-4-1" },
      );
      ledger.recordUsage(
        {
          agentId: "claude-run-2",
          generation: 0,
          sessionId: "claude-session-2",
          sourcePath: "claude-wire-2",
        },
        { ...createUsage("claude-request-2", 1_500), model: "claude-opus-4-1" },
      );
      ledger.recordUsage(
        {
          agentId: "claude-run-1",
          generation: 0,
          sessionId: "claude-session",
          sourcePath: "claude-wire",
        },
        { ...createUsage("claude-request", 1_000), model: "claude-opus-4-1" },
      );
      ledger.recordUsage(
        {
          agentId: "main",
          generation: 0,
          sessionId: "kimi-session",
          sourcePath: "kimi-wire",
        },
        createUsage("kimi-request", 2_000),
      );

      const providerFilters = { ...filters, provider: "anthropic" };
      const options = queryFilterOptions(database, false, "anthropic", 3_000);

      expect(options.providers).toEqual([
        { label: "Claude", value: "anthropic" },
        { label: "Kimi", value: "moonshotai" },
      ]);
      expect(options.workspaces).toEqual([
        { label: "claude-workspace", value: "claude-workspace" },
      ]);
      expect(options.models).toEqual([
        { label: "claude-opus-4-1", value: "claude-opus-4-1" },
      ]);
      expect(options.agents).toEqual([
        { label: "Explore", value: "agent:Explore" },
      ]);
      expect(options.sessions.map((session) => session.value)).toEqual([
        "claude-session",
        "claude-session-2",
      ]);
      expect(queryAgents(database, "claude-session", providerFilters)).toHaveLength(1);
      expect(queryAgents(database, "claude-session", providerFilters)[0]).toMatchObject({
        agentKey: "agent:Explore",
        agentLabel: "Explore",
        agentType: "sub",
        callCount: 2,
      });
      expect(querySummary(database, {
        ...providerFilters,
        agentKey: "agent:Explore",
      }).callCount).toBe(3);
    } finally {
      database.close();
    }
  });

  test("groups session filters by recency and orders each group by cost", () => {
    const database = openDashboardDatabase(":memory:");
    const minuteMs = 60 * 1_000;
    const dayMs = 24 * 60 * minuteMs;
    const nowMs = 40 * dayMs;
    const sessionData = [
      { ageMs: 15 * minuteMs, cost: 1, id: "recent-low" },
      { ageMs: 7 * 60 * minuteMs, cost: 9, id: "recent-high" },
      { ageMs: 2 * dayMs, cost: 2, id: "archive-two" },
      { ageMs: 3 * dayMs, cost: 8, id: "archive-three" },
      { ageMs: 4 * dayMs, cost: 3, id: "older-four" },
      { ageMs: 10 * dayMs, cost: 7, id: "older-ten" },
      { ageMs: 20 * dayMs, cost: 4, id: "older-twenty" },
      { ageMs: 30 * dayMs, cost: 6, id: "older-thirty" },
    ];
    try {
      const ledger = new CallLedger(database, callPricing(() => ({
        basis: "test catalog",
        cacheCreation1hNanoPerToken: 1,
        cacheCreation5mNanoPerToken: 1,
        cacheCreationNanoPerToken: 1,
        cacheReadNanoPerToken: 1,
        confidence: "exact",
        inputNanoPerToken: 1,
        outputNanoPerToken: 1,
        rateId: null,
        resolvedModelKey: "moonshotai/kimi-k3",
      })));
      for (const session of sessionData) {
        const updatedAtMs = nowMs - session.ageMs;
        insertSource(database, session.id, "main", "main", updatedAtMs, session.id, {
          title: session.id,
        });
        const usage = createUsage(`${session.id}-request`, updatedAtMs);
        ledger.recordUsage({
          agentId: "main",
          generation: 0,
          sessionId: session.id,
          sourcePath: session.id,
        }, {
          ...usage,
          tokens: { ...usage.tokens, output: session.cost * 100 },
        });
      }

      const sessions = queryFilterOptions(database, false, undefined, nowMs).sessions;

      expect(sessions.map(({ recencyGroup, value }) => ({ recencyGroup, value }))).toEqual([
        { recencyGroup: "Last 24 hours", value: "recent-high" },
        { recencyGroup: "Last 24 hours", value: "recent-low" },
        { recencyGroup: "1–3 days ago", value: "archive-three" },
        { recencyGroup: "1–3 days ago", value: "archive-two" },
        { recencyGroup: "4+ days ago", value: "older-ten" },
        { recencyGroup: "4+ days ago", value: "older-thirty" },
        { recencyGroup: "4+ days ago", value: "older-twenty" },
        { recencyGroup: "4+ days ago", value: "older-four" },
      ]);
      expect(sessions.map((session) => session.label.split(" · ")[0])).toEqual([
        "7h", "15m", "3d", "2d", "10d", "30d", "20d", "4d",
      ]);
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
  session: {
    agentKey?: string;
    agentLabel?: string;
    provider?: string;
    title?: string;
    workspaceKey?: string;
  } = {},
): void {
  const workspaceKey = session.workspaceKey ?? "workspace";
  const title = session.title ?? null;
  database.query(`
    INSERT INTO sessions (
      session_id, provider, workspace_key, title, created_at_ms, updated_at_ms, parse_status
    ) VALUES (?, ?, ?, ?, ?, ?, 'ok')
  `).run(
    sessionId,
    session.provider ?? "moonshotai",
    workspaceKey,
    title,
    createdAtMs,
    createdAtMs,
  );
  database.query(`
    INSERT INTO agents (
      session_id, agent_id, agent_key, agent_label, agent_type,
      parent_agent_id, source_directory
    ) VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(
    sessionId,
    agentId,
    session.agentKey ?? agentId,
    session.agentLabel ?? (agentId === "main" ? "Main" : agentId),
    agentType,
    agentType === "sub" ? "main" : null,
    sourcePath,
  );
  if (agentType === "sub") {
    database.query(`
      INSERT INTO agents (
        session_id, agent_id, agent_key, agent_label, agent_type, source_directory
      ) VALUES (?, 'main', 'main', 'Main', 'main', ?)
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
    tokens: {
      cacheCreation: 20,
      cacheCreation1h: 0,
      cacheCreation5m: 0,
      cacheRead: 300,
      inputOther: 100,
      output: 40,
    },
  };
}

function sum(values: readonly number[]): number {
  return values.reduce((total, value) => total + value, 0);
}

function callPricing(resolve: RateResolver): CallPricing {
  return { resolve, resolveByRateId: () => null };
}
