import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { cacheWriteTokenMigration, callAccountingMigration } from "../call-accounting/schema";
import { meteredUsageMigration } from "../metered-usage/schema";
import {
  cacheWriteRateMigration,
  pricingMigration,
  pricingRateActivationMigration,
} from "../pricing/schema";
import {
  sessionImportMigration,
  sessionMetadataCheckpointMigration,
  sessionProviderMigration,
} from "../session-import/schema";

interface DatabaseMigration {
  name: string;
  sql: string;
  version: number;
}

const migrations: readonly DatabaseMigration[] = [
  sessionImportMigration,
  pricingMigration,
  callAccountingMigration,
  pricingRateActivationMigration,
  sessionProviderMigration,
  cacheWriteTokenMigration,
  cacheWriteRateMigration,
  meteredUsageMigration,
  sessionMetadataCheckpointMigration,
];

export function openDashboardDatabase(databasePath: string): Database {
  if (databasePath !== ":memory:") {
    mkdirSync(dirname(databasePath), { recursive: true });
  }

  const database = new Database(databasePath, { create: true, strict: true });
  database.exec("PRAGMA foreign_keys = ON;");
  database.exec("PRAGMA busy_timeout = 5000;");
  if (databasePath !== ":memory:") {
    database.exec("PRAGMA journal_mode = WAL;");
    database.exec("PRAGMA synchronous = NORMAL;");
  }

  applyMigrations(database);
  return database;
}

function applyMigrations(database: Database): void {
  database.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      applied_at_ms INTEGER NOT NULL
    );
  `);

  const appliedVersions = new Set(
    database
      .query<{ version: number }, []>("SELECT version FROM schema_migrations")
      .all()
      .map(({ version }) => version),
  );
  const applyMigration = database.transaction((migration: DatabaseMigration) => {
    database.exec(migration.sql);
    database
      .query("INSERT INTO schema_migrations (version, name, applied_at_ms) VALUES (?, ?, ?)")
      .run(migration.version, migration.name, Date.now());
  });

  for (const migration of migrations) {
    if (!appliedVersions.has(migration.version)) {
      applyMigration(migration);
    }
  }
}
