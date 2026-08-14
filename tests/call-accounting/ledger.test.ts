import { describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import {
  type CallPricing,
  CallLedger,
  type RateResolver,
} from "../../src/call-accounting/ledger";
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
      const ledger = new CallLedger(database, callPricing(() => ({
        basis: "test rate",
        cacheCreation1hNanoPerToken: nanoPerToken,
        cacheCreation5mNanoPerToken: nanoPerToken,
        cacheCreationNanoPerToken: nanoPerToken,
        cacheReadNanoPerToken: nanoPerToken,
        confidence: "exact",
        inputNanoPerToken: nanoPerToken,
        outputNanoPerToken: nanoPerToken,
        rateId: null,
        resolvedModelKey: "moonshotai/kimi-k3",
      })));
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

  test("uses final usage while retaining the original session attribution", () => {
    const database = openDashboardDatabase(":memory:");
    try {
      insertSource(database, "original-session", 100, "original-wire");
      insertSource(database, "replayed-session", 200, "replayed-wire");
      const ledger = new CallLedger(database, callPricing(() => ({
        basis: "test rate",
        cacheCreation1hNanoPerToken: 1,
        cacheCreation5mNanoPerToken: 1,
        cacheCreationNanoPerToken: 1,
        cacheReadNanoPerToken: 1,
        confidence: "exact",
        inputNanoPerToken: 1,
        outputNanoPerToken: 10,
        rateId: null,
        resolvedModelKey: "anthropic/claude-fable-5",
      })));
      const partial = {
        ...createUsageRecord("progressive-request"),
        model: "claude-fable-5",
        tokens: { ...createUsageRecord("progressive-request").tokens, output: 10 },
      };
      const complete = {
        ...partial,
        byteOffset: 20,
        tokens: { ...partial.tokens, output: 20 },
      };

      ledger.recordUsage({
        agentId: "main",
        generation: 0,
        sessionId: "original-session",
        sourcePath: "original-wire",
      }, partial);
      ledger.recordUsage({
        agentId: "main",
        generation: 0,
        sessionId: "replayed-session",
        sourcePath: "replayed-wire",
      }, complete);

      expect(database.query<{
        output_tokens: number;
        session_id: string;
        total_cost_nano: number;
      }, []>(`
        SELECT output_tokens, session_id, total_cost_nano FROM api_calls
      `).get()).toEqual({
        output_tokens: 20,
        session_id: "original-session",
        total_cost_nano: 620,
      });
    } finally {
      database.close();
    }
  });

  test("keeps original metering context while a replay supplies final usage", () => {
    const database = openDashboardDatabase(":memory:");
    try {
      insertSource(database, "original", 100, "original-wire");
      insertSource(database, "replay", 200, "replay-wire");
      insertAccountState(database, 1, "pro", "pro-fable", 0);
      insertAccountState(database, 2, "max", "subscription-excluded", 150);
      const ledger = new CallLedger(
        database,
        undefined,
        (_provider, _model, timestampMs) => timestampMs < 150
          ? { accountStateId: 1, basis: "pro-fable", isMetered: true }
          : { accountStateId: 2, basis: "subscription-excluded", isMetered: false },
      );
      const partial = {
        ...createUsageRecord("metering-replay"),
        model: "claude-fable-5",
        timestampMs: 100,
        tokens: { ...createUsageRecord("metering-replay").tokens, output: 10 },
      };
      const complete = {
        ...partial,
        byteOffset: 20,
        timestampMs: 200,
        tokens: { ...partial.tokens, output: 20 },
      };

      ledger.recordUsage({ agentId: "main", generation: 0, sessionId: "replay", sourcePath: "replay-wire" }, complete);
      ledger.recordUsage({ agentId: "main", generation: 0, sessionId: "original", sourcePath: "original-wire" }, partial);

      expect(database.query<{
        account_state_id: number;
        is_metered: number;
        metering_basis: string;
        output_tokens: number;
        session_id: string;
      }, []>(`
        SELECT account_state_id, is_metered, metering_basis, output_tokens, session_id
        FROM api_calls
      `).get()).toEqual({
        account_state_id: 1,
        is_metered: 1,
        metering_basis: "pro-fable",
        output_tokens: 20,
        session_id: "original",
      });
    } finally {
      database.close();
    }
  });

  test("uses the last Claude transcript revision when token components cross", () => {
    const database = openDashboardDatabase(":memory:");
    try {
      insertSource(database, "session", 100, "wire");
      const ledger = new CallLedger(database);
      const earlier = {
        ...createUsageRecord("crossed-components"),
        model: "claude-fable-5",
        tokens: {
          ...createUsageRecord("crossed-components").tokens,
          cacheRead: 300,
          output: 20,
        },
      };
      const later = {
        ...earlier,
        byteOffset: 20,
        tokens: { ...earlier.tokens, cacheRead: 250, output: 30 },
      };

      ledger.recordUsage({ agentId: "main", generation: 0, sessionId: "session", sourcePath: "wire" }, earlier);
      ledger.recordUsage({ agentId: "main", generation: 0, sessionId: "session", sourcePath: "wire" }, later);

      expect(database.query<{ cache_read_tokens: number; output_tokens: number }, []>(`
        SELECT cache_read_tokens, output_tokens FROM api_calls
      `).get()).toEqual({ cache_read_tokens: 250, output_tokens: 30 });
    } finally {
      database.close();
    }
  });

  test("keeps the original Kimi record when contradictory copies have no progression", () => {
    const database = openDashboardDatabase(":memory:");
    try {
      insertSource(database, "original", 100, "original-wire");
      insertSource(database, "copy", 200, "copy-wire");
      const ledger = new CallLedger(database);
      const original = createUsageRecord("contradictory-kimi");
      const copy = {
        ...original,
        byteOffset: 20,
        tokens: { ...original.tokens, cacheRead: 250, output: 50 },
      };

      ledger.recordUsage({ agentId: "main", generation: 0, sessionId: "copy", sourcePath: "copy-wire" }, copy);
      ledger.recordUsage({ agentId: "main", generation: 0, sessionId: "original", sourcePath: "original-wire" }, original);

      expect(database.query<{ cache_read_tokens: number; output_tokens: number }, []>(`
        SELECT cache_read_tokens, output_tokens FROM api_calls
      `).get()).toEqual({ cache_read_tokens: 300, output_tokens: 40 });
    } finally {
      database.close();
    }
  });

  test("rejects model mismatches without leaving the incompatible occurrence", () => {
    const database = openDashboardDatabase(":memory:");
    try {
      insertSource(database, "session", 100, "wire");
      const ledger = new CallLedger(database);
      const fable = { ...createUsageRecord("model-mismatch"), model: "claude-fable-5" };
      const opus = { ...fable, byteOffset: 20, model: "claude-opus-5" };

      ledger.recordUsage({ agentId: "main", generation: 0, sessionId: "session", sourcePath: "wire" }, fable);
      expect(() => ledger.recordUsage(
        { agentId: "main", generation: 0, sessionId: "session", sourcePath: "wire" },
        opus,
      )).toThrow("disagree on provider or model");
      expect(database.query<{ count: number }, []>(`
        SELECT COUNT(*) AS count FROM usage_occurrences
      `).get()?.count).toBe(1);
    } finally {
      database.close();
    }
  });

  test("prices progressive usage with its originally assigned stored rate", () => {
    const database = openDashboardDatabase(":memory:");
    try {
      insertSource(database, "session", 100, "wire");
      insertStoredRate(database, 7);
      let currentRate = 1;
      const ledger = new CallLedger(database, {
        resolve: () => quote(currentRate, 7),
        resolveByRateId: () => quote(1, 7),
      });
      const partial = createUsageRecord("stored-rate");
      ledger.recordUsage({ agentId: "main", generation: 0, sessionId: "session", sourcePath: "wire" }, partial);

      currentRate = 100;
      ledger.recordUsage(
        { agentId: "main", generation: 0, sessionId: "session", sourcePath: "wire" },
        { ...partial, byteOffset: 20, tokens: { ...partial.tokens, output: 50 } },
      );

      expect(readTotalCost(database)).toBe(470);
    } finally {
      database.close();
    }
  });

  test("updates pricing provenance when an unpriced progression gains a rate", () => {
    const database = openDashboardDatabase(":memory:");
    try {
      insertSource(database, "session", 100, "wire");
      let activeQuote: ReturnType<typeof quote> | null = null;
      const ledger = new CallLedger(database, {
        resolve: () => activeQuote,
        resolveByRateId: () => null,
      });
      const partial = createUsageRecord("newly-priced");
      ledger.recordUsage({ agentId: "main", generation: 0, sessionId: "session", sourcePath: "wire" }, partial);

      activeQuote = { ...quote(1, 0), rateId: null };
      ledger.recordUsage(
        { agentId: "main", generation: 0, sessionId: "session", sourcePath: "wire" },
        { ...partial, byteOffset: 20, tokens: { ...partial.tokens, output: 50 } },
      );

      expect(database.query<{
        pricing_basis: string;
        pricing_confidence: string;
        total_cost_nano: number;
      }, []>(`
        SELECT pricing_basis, pricing_confidence, total_cost_nano FROM api_calls
      `).get()).toEqual({
        pricing_basis: "test rate",
        pricing_confidence: "exact",
        total_cost_nano: 470,
      });
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
      cacheCreation1h: 0,
      cacheCreation5m: 0,
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

function callPricing(resolve: RateResolver): CallPricing {
  return { resolve, resolveByRateId: () => null };
}

function insertStoredRate(database: Database, rateId: number): void {
  database.query(`
    INSERT INTO model_rates (
      rate_id, provider, model_key, input_nano_per_token, output_nano_per_token,
      cache_read_nano_per_token, cache_creation_nano_per_token,
      cache_creation_5m_nano_per_token, cache_creation_1h_nano_per_token,
      source_name, confidence, created_at_ms
    ) VALUES (?, 'moonshotai', 'kimi-k3', 1, 1, 1, 1, 1, 1, 'test', 'exact', 1)
  `).run(rateId);
}

function insertAccountState(
  database: Database,
  accountStateId: number,
  subscriptionType: string,
  policy: "pro-fable" | "subscription-excluded",
  effectiveFromMs: number,
): void {
  database.query(`
    INSERT INTO metering_account_states (
      account_state_id, provider, subscription_type, policy, effective_from_ms,
      detected_at_ms, last_confirmed_at_ms, provenance
    ) VALUES (?, 'anthropic', ?, ?, ?, ?, ?, 'detected-change')
  `).run(
    accountStateId,
    subscriptionType,
    policy,
    effectiveFromMs,
    effectiveFromMs,
    effectiveFromMs,
  );
}

function quote(nanoPerToken: number, rateId: number | null) {
  return {
    basis: "test rate",
    cacheCreation1hNanoPerToken: nanoPerToken,
    cacheCreation5mNanoPerToken: nanoPerToken,
    cacheCreationNanoPerToken: nanoPerToken,
    cacheReadNanoPerToken: nanoPerToken,
    confidence: "exact" as const,
    inputNanoPerToken: nanoPerToken,
    outputNanoPerToken: nanoPerToken,
    rateId,
    resolvedModelKey: "moonshotai/kimi-k3",
  };
}
