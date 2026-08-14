import { describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { openDashboardDatabase } from "../../src/app/database";
import { CallLedger, type CallPricing } from "../../src/call-accounting/ledger";
import type { ClaudeAccountStatus } from "../../src/metered-usage/account-status";
import { MeteredUsageService } from "../../src/metered-usage/service";
import { isProMeteredClaudeModel } from "../../src/pricing/anthropic-catalog";

describe("MeteredUsageService", () => {
  test("changes only calls at or after an observed subscription boundary", async () => {
    const database = openDashboardDatabase(":memory:");
    let nowMs = 100;
    let subscriptionType = "pro";
    const service = createService(database, async () => account(subscriptionType), () => nowMs);
    const ledger = createLedger(database, service);
    seedClaudeSource(database);

    try {
      await service.refreshClaudeAccount(true);
      recordClaude(ledger, "before-change", "claude-fable-5", 50, 1);

      nowMs = 200;
      subscriptionType = "max";
      await service.refreshClaudeAccount(true);
      recordClaude(ledger, "after-change", "claude-fable-5", 250, 2);
      recordClaude(ledger, "backdated", "claude-fable-5", 150, 3);

      expect(callMetering(database)).toEqual([
        { account: "pro", basis: "pro-fable", fingerprint: "request:anthropic:before-change", is_metered: 1 },
        { account: "max", basis: "subscription-excluded", fingerprint: "request:anthropic:after-change", is_metered: 0 },
        { account: "pro", basis: "pro-fable", fingerprint: "request:anthropic:backdated", is_metered: 1 },
      ]);
    } finally {
      database.close();
    }
  });

  test("retains the last confirmed policy after a transient detection failure", async () => {
    const database = openDashboardDatabase(":memory:");
    let shouldFail = false;
    const service = createService(database, async () => {
      if (shouldFail) throw new Error("temporary failure");
      return account("pro");
    }, () => 100);
    const ledger = createLedger(database, service);
    seedClaudeSource(database);

    try {
      await service.refreshClaudeAccount(true);
      shouldFail = true;
      const refresh = await service.refreshClaudeAccount(true);
      recordClaude(ledger, "after-failure", "claude-fable-5", 150, 1);

      expect(refresh.error).toBe("temporary failure");
      expect(service.getClaudeStatus()).toMatchObject({
        error: "temporary failure",
        policy: "pro-fable",
        subscriptionType: "pro",
      });
      expect(callMetering(database)[0]).toMatchObject({
        basis: "pro-fable",
        is_metered: 1,
      });
    } finally {
      database.close();
    }
  });

  test("backfills initially excluded calls after the first successful detection", async () => {
    const database = openDashboardDatabase(":memory:");
    let shouldFail = true;
    const service = createService(database, async () => {
      if (shouldFail) throw new Error("not available");
      return account("pro");
    }, () => 100);
    const ledger = createLedger(database, service);
    seedClaudeSource(database);

    try {
      await service.refreshClaudeAccount(true);
      recordClaude(ledger, "backfill", "claude-fable-5", 50, 1);
      expect(callMetering(database)[0]?.is_metered).toBe(0);

      shouldFail = false;
      const refresh = await service.refreshClaudeAccount(true);
      ledger.rebuildCanonicalCalls(refresh.affectedFingerprints);

      expect(callMetering(database)[0]).toMatchObject({
        account: "pro",
        basis: "pro-fable",
        is_metered: 1,
      });
      expect(database.query<{ provenance: string }, []>(`
        SELECT provenance FROM metering_account_states
      `).get()?.provenance).toBe("current-state-backfill");
    } finally {
      database.close();
    }
  });

  test("reapplies the historical account interval after a source rewrite", async () => {
    const database = openDashboardDatabase(":memory:");
    let nowMs = 100;
    let subscriptionType = "pro";
    const service = createService(database, async () => account(subscriptionType), () => nowMs);
    const ledger = createLedger(database, service);
    seedClaudeSource(database);

    try {
      await service.refreshClaudeAccount(true);
      recordClaude(ledger, "rewritten", "claude-fable-5", 50, 1);
      nowMs = 200;
      subscriptionType = "max";
      await service.refreshClaudeAccount(true);

      ledger.removeSourceOccurrences("source");
      ledger.recordUsage({
        agentId: "main",
        generation: 1,
        sessionId: "session",
        sourcePath: "source",
      }, {
        byteOffset: 1,
        model: "claude-fable-5",
        providerRequestId: "rewritten",
        requestMetadata: null,
        stepUuid: "rewritten",
        timestampMs: 50,
        tokens: {
          cacheCreation: 0,
          cacheCreation1h: 0,
          cacheCreation5m: 0,
          cacheRead: 0,
          inputOther: 1,
          output: 1,
        },
      });

      expect(callMetering(database)[0]).toMatchObject({
        account: "pro",
        basis: "pro-fable",
        is_metered: 1,
      });
    } finally {
      database.close();
    }
  });
});

function createService(
  database: Database,
  detectAccount: () => Promise<ClaudeAccountStatus>,
  now: () => number,
): MeteredUsageService {
  return new MeteredUsageService(database, {
    detectAccount,
    isProMeteredModel: isProMeteredClaudeModel,
    now,
  });
}

function createLedger(database: Database, service: MeteredUsageService): CallLedger {
  return new CallLedger(database, testPricing, service.resolveMetering);
}

function seedClaudeSource(database: Database): void {
  database.query(`
    INSERT INTO sessions (
      session_id, workspace_key, created_at_ms, updated_at_ms, parse_status, provider
    ) VALUES ('session', 'workspace', 1, 1, 'ok', 'anthropic')
  `).run();
  database.query(`
    INSERT INTO agents (session_id, agent_id, agent_type, source_directory)
    VALUES ('session', 'main', 'main', 'source')
  `).run();
  database.query(`
    INSERT INTO source_files (path, source_root, session_id, agent_id)
    VALUES ('source', 'root', 'session', 'main')
  `).run();
}

function recordClaude(
  ledger: CallLedger,
  requestId: string,
  model: string,
  timestampMs: number,
  byteOffset: number,
): void {
  ledger.recordUsage({
    agentId: "main",
    generation: 0,
    sessionId: "session",
    sourcePath: "source",
  }, {
    byteOffset,
    model,
    providerRequestId: requestId,
    requestMetadata: null,
    stepUuid: requestId,
    timestampMs,
    tokens: {
      cacheCreation: 0,
      cacheCreation1h: 0,
      cacheCreation5m: 0,
      cacheRead: 0,
      inputOther: 1,
      output: 1,
    },
  });
}

function account(subscriptionType: string): ClaudeAccountStatus {
  return { apiProvider: "firstParty", authMethod: "claude.ai", subscriptionType };
}

function callMetering(database: Database) {
  return database.query<{
    account: string | null;
    basis: string;
    fingerprint: string;
    is_metered: number;
  }, []>(`
    SELECT call.event_fingerprint AS fingerprint,
           call.is_metered,
           call.metering_basis AS basis,
           state.subscription_type AS account
    FROM api_calls AS call
    LEFT JOIN metering_account_states AS state
      ON state.account_state_id = call.account_state_id
    ORDER BY call.canonical_byte_offset
  `).all();
}

const testPricing: CallPricing = {
  resolve: (_model, _timestamp) => ({
    basis: "test",
    cacheCreation1hNanoPerToken: 1,
    cacheCreation5mNanoPerToken: 1,
    cacheCreationNanoPerToken: 1,
    cacheReadNanoPerToken: 1,
    confidence: "exact",
    inputNanoPerToken: 1,
    outputNanoPerToken: 1,
    rateId: null,
    resolvedModelKey: "anthropic/test",
  }),
  resolveByRateId: () => null,
};
