import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDashboardDatabase } from "../../src/app/database";
import {
  cacheWriteTokenMigration,
  callAccountingMigration,
} from "../../src/call-accounting/schema";
import {
  cacheWriteRateMigration,
  pricingMigration,
  pricingRateActivationMigration,
} from "../../src/pricing/schema";
import {
  sessionImportMigration,
  sessionProviderMigration,
} from "../../src/session-import/schema";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) => (
      rm(directory, { force: true, recursive: true })
    )),
  );
});

describe("dashboard database migrations", () => {
  test("upgrades a pre-Claude ledger without replacing existing tables", async () => {
    const directory = await mkdtemp(join(tmpdir(), "costlight-database-test-"));
    temporaryDirectories.push(directory);
    const databasePath = join(directory, "dashboard.sqlite");
    const legacyDatabase = new Database(databasePath, { create: true, strict: true });
    legacyDatabase.exec(`
      CREATE TABLE schema_migrations (
        version INTEGER PRIMARY KEY,
        name TEXT NOT NULL,
        applied_at_ms INTEGER NOT NULL
      );
    `);
    for (const migration of [
      sessionImportMigration,
      pricingMigration,
      callAccountingMigration,
      pricingRateActivationMigration,
      sessionProviderMigration,
      cacheWriteTokenMigration,
      cacheWriteRateMigration,
    ]) {
      legacyDatabase.exec(migration.sql);
      legacyDatabase.query(`
        INSERT INTO schema_migrations (version, name, applied_at_ms) VALUES (?, ?, 1)
      `).run(migration.version, migration.name);
    }
    legacyDatabase.query(`
      INSERT INTO sessions (
        session_id, workspace_key, created_at_ms, updated_at_ms, parse_status
      ) VALUES ('existing-session', 'workspace', 1, 1, 'ok')
    `).run();
    legacyDatabase.query(`
      UPDATE sessions SET provider = 'anthropic' WHERE session_id = 'existing-session'
    `).run();
    legacyDatabase.query(`
      INSERT INTO agents (session_id, agent_id, agent_type, source_directory)
      VALUES ('existing-session', 'main', 'main', 'transcript')
    `).run();
    legacyDatabase.query(`
      INSERT INTO source_files (path, source_root, session_id, agent_id)
      VALUES ('transcript', 'root', 'existing-session', 'main')
    `).run();
    legacyDatabase.query(`
      INSERT INTO usage_occurrences (
        source_path, generation, byte_offset, event_fingerprint, timestamp_ms,
        raw_model, input_other_tokens, cache_creation_tokens,
        cache_creation_5m_tokens, cache_creation_1h_tokens, cache_read_tokens,
        output_tokens, session_id, agent_id, provider_request_id, step_uuid
      ) VALUES (
        'transcript', 0, 1, 'request:anthropic:existing', 1,
        'claude-fable-5', 1, 0, 0, 0, 0, 1,
        'existing-session', 'main', 'existing', 'event'
      )
    `).run();
    legacyDatabase.query(`
      INSERT INTO api_calls (
        event_fingerprint, canonical_source_path, canonical_generation,
        canonical_byte_offset, timestamp_ms, provider, raw_model,
        input_other_tokens, cache_creation_tokens, cache_creation_5m_tokens,
        cache_creation_1h_tokens, cache_read_tokens, output_tokens,
        session_id, agent_id, pricing_confidence, pricing_basis
      ) VALUES (
        'request:anthropic:existing', 'transcript', 0, 1, 1,
        'anthropic', 'claude-fable-5', 1, 0, 0, 0, 0, 1,
        'existing-session', 'main', 'unpriced', 'No matching rate'
      )
    `).run();
    legacyDatabase.close();

    const upgradedDatabase = openDashboardDatabase(databasePath);
    try {
      expect(upgradedDatabase.query<{ provider: string }, []>(`
        SELECT provider FROM sessions WHERE session_id = 'existing-session'
      `).get()?.provider).toBe("anthropic");
      expect(tableColumns(upgradedDatabase, "usage_occurrences")).toContain(
        "cache_creation_5m_tokens",
      );
      expect(tableColumns(upgradedDatabase, "api_calls")).toContain(
        "cache_creation_1h_tokens",
      );
      expect(tableColumns(upgradedDatabase, "model_rates")).toContain(
        "cache_creation_1h_nano_per_token",
      );
      expect(tableColumns(upgradedDatabase, "usage_occurrences")).toContain("account_state_id");
      expect(tableColumns(upgradedDatabase, "api_calls")).toContain("is_metered");
      expect(upgradedDatabase.query<{
        is_metered: number;
        provider: string;
      }, []>(`
        SELECT provider, is_metered FROM usage_occurrences
      `).get()).toEqual({ is_metered: 1, provider: "anthropic" });
      expect(upgradedDatabase.query<{ count: number }, []>(`
        SELECT COUNT(*) AS count FROM metering_account_states
      `).get()?.count).toBe(0);
    } finally {
      upgradedDatabase.close();
    }
  });
});

function tableColumns(database: Database, tableName: string): readonly string[] {
  const allowedTables = new Set(["api_calls", "model_rates", "usage_occurrences"]);
  if (!allowedTables.has(tableName)) {
    throw new Error(`Unexpected table: ${tableName}`);
  }
  return database.query<{ name: string }, []>(`PRAGMA table_info(${tableName})`)
    .all()
    .map(({ name }) => name);
}
