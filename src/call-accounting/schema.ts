export const callAccountingMigration = {
  version: 3,
  name: "canonical call ledger",
  sql: `
    CREATE TABLE usage_occurrences (
      source_path TEXT NOT NULL,
      generation INTEGER NOT NULL,
      byte_offset INTEGER NOT NULL,
      event_fingerprint TEXT NOT NULL,
      timestamp_ms INTEGER NOT NULL,
      raw_model TEXT NOT NULL,
      input_other_tokens INTEGER NOT NULL,
      cache_creation_tokens INTEGER NOT NULL,
      cache_read_tokens INTEGER NOT NULL,
      output_tokens INTEGER NOT NULL,
      session_id TEXT NOT NULL,
      agent_id TEXT NOT NULL,
      provider_request_id TEXT,
      step_uuid TEXT,
      is_canonical INTEGER NOT NULL DEFAULT 0,
      replay_classification TEXT NOT NULL DEFAULT 'pending',
      PRIMARY KEY (source_path, generation, byte_offset),
      FOREIGN KEY (source_path) REFERENCES source_files(path) ON DELETE CASCADE,
      FOREIGN KEY (session_id, agent_id) REFERENCES agents(session_id, agent_id) ON DELETE CASCADE
    );

    CREATE INDEX usage_occurrences_fingerprint_index
      ON usage_occurrences(event_fingerprint);
    CREATE INDEX usage_occurrences_session_index
      ON usage_occurrences(session_id, agent_id, timestamp_ms);

    CREATE TABLE api_calls (
      event_fingerprint TEXT PRIMARY KEY,
      canonical_source_path TEXT NOT NULL,
      canonical_generation INTEGER NOT NULL,
      canonical_byte_offset INTEGER NOT NULL,
      timestamp_ms INTEGER NOT NULL,
      provider TEXT NOT NULL,
      raw_model TEXT NOT NULL,
      resolved_model_key TEXT,
      input_other_tokens INTEGER NOT NULL,
      cache_creation_tokens INTEGER NOT NULL,
      cache_read_tokens INTEGER NOT NULL,
      output_tokens INTEGER NOT NULL,
      session_id TEXT NOT NULL,
      agent_id TEXT NOT NULL,
      input_cost_nano INTEGER,
      cache_creation_cost_nano INTEGER,
      cache_read_cost_nano INTEGER,
      output_cost_nano INTEGER,
      total_cost_nano INTEGER,
      rate_id INTEGER,
      pricing_confidence TEXT NOT NULL,
      pricing_basis TEXT NOT NULL,
      FOREIGN KEY (session_id, agent_id) REFERENCES agents(session_id, agent_id),
      FOREIGN KEY (rate_id) REFERENCES model_rates(rate_id)
    );

    CREATE INDEX api_calls_timestamp_index ON api_calls(timestamp_ms);
    CREATE INDEX api_calls_filter_index ON api_calls(session_id, agent_id, raw_model, timestamp_ms);
  `,
} as const;
