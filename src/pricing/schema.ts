export const pricingMigration = {
  version: 2,
  name: "pricing catalogs",
  sql: `
    CREATE TABLE pricing_snapshots (
      snapshot_id INTEGER PRIMARY KEY AUTOINCREMENT,
      source_name TEXT NOT NULL,
      source_url TEXT NOT NULL,
      fetched_at_ms INTEGER NOT NULL,
      etag TEXT,
      content_hash TEXT NOT NULL,
      is_last_good INTEGER NOT NULL DEFAULT 0,
      UNIQUE (source_name, content_hash)
    );

    CREATE INDEX pricing_snapshots_last_good_index
      ON pricing_snapshots(source_name, is_last_good, fetched_at_ms DESC);

    CREATE TABLE model_rates (
      rate_id INTEGER PRIMARY KEY AUTOINCREMENT,
      snapshot_id INTEGER,
      provider TEXT NOT NULL,
      model_key TEXT NOT NULL,
      raw_alias TEXT,
      input_nano_per_token INTEGER NOT NULL,
      output_nano_per_token INTEGER NOT NULL,
      cache_read_nano_per_token INTEGER NOT NULL,
      cache_creation_nano_per_token INTEGER NOT NULL,
      source_name TEXT NOT NULL,
      confidence TEXT NOT NULL CHECK (confidence IN ('exact', 'alias', 'inferred', 'override', 'bundled')),
      effective_at_ms INTEGER,
      created_at_ms INTEGER NOT NULL,
      FOREIGN KEY (snapshot_id) REFERENCES pricing_snapshots(snapshot_id)
    );

    CREATE INDEX model_rates_lookup_index
      ON model_rates(provider, model_key, effective_at_ms, created_at_ms DESC);
    CREATE INDEX model_rates_alias_index
      ON model_rates(raw_alias, effective_at_ms, created_at_ms DESC);
  `,
} as const;

export const pricingRateActivationMigration = {
  version: 4,
  name: "retain historical rate records",
  sql: `
    ALTER TABLE model_rates ADD COLUMN is_active INTEGER NOT NULL DEFAULT 1;
    CREATE INDEX model_rates_active_lookup_index
      ON model_rates(is_active, provider, model_key, raw_alias);
  `,
} as const;
