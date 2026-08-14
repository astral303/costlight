export const meteredUsageMigration = {
  version: 8,
  name: "metered usage account context",
  sql: `
    CREATE TABLE metering_account_states (
      account_state_id INTEGER PRIMARY KEY AUTOINCREMENT,
      provider TEXT NOT NULL,
      subscription_type TEXT NOT NULL,
      policy TEXT NOT NULL CHECK (
        policy IN ('pro-fable', 'enterprise-api', 'subscription-excluded')
      ),
      effective_from_ms INTEGER NOT NULL,
      detected_at_ms INTEGER NOT NULL,
      last_confirmed_at_ms INTEGER NOT NULL,
      provenance TEXT NOT NULL CHECK (
        provenance IN ('current-state-backfill', 'detected-change')
      )
    );

    CREATE UNIQUE INDEX metering_account_states_effective_index
      ON metering_account_states(provider, effective_from_ms);

    CREATE TABLE metering_provider_status (
      provider TEXT PRIMARY KEY,
      current_account_state_id INTEGER,
      last_attempt_at_ms INTEGER NOT NULL,
      last_success_at_ms INTEGER,
      last_error TEXT,
      FOREIGN KEY (current_account_state_id) REFERENCES metering_account_states(account_state_id)
    );

    ALTER TABLE usage_occurrences
      ADD COLUMN provider TEXT NOT NULL DEFAULT 'moonshotai';
    ALTER TABLE usage_occurrences
      ADD COLUMN account_state_id INTEGER REFERENCES metering_account_states(account_state_id);
    ALTER TABLE usage_occurrences
      ADD COLUMN is_metered INTEGER NOT NULL DEFAULT 1;
    ALTER TABLE usage_occurrences
      ADD COLUMN metering_basis TEXT NOT NULL DEFAULT 'metered-api';

    UPDATE usage_occurrences
    SET provider = 'anthropic'
    WHERE event_fingerprint IN (
      SELECT event_fingerprint FROM api_calls WHERE provider = 'anthropic'
    );

    ALTER TABLE api_calls
      ADD COLUMN account_state_id INTEGER REFERENCES metering_account_states(account_state_id);
    ALTER TABLE api_calls
      ADD COLUMN is_metered INTEGER NOT NULL DEFAULT 1;
    ALTER TABLE api_calls
      ADD COLUMN metering_basis TEXT NOT NULL DEFAULT 'metered-api';

    CREATE INDEX usage_occurrences_metering_index
      ON usage_occurrences(provider, account_state_id, timestamp_ms);
    CREATE INDEX api_calls_metered_timestamp_index
      ON api_calls(is_metered, timestamp_ms);
  `,
} as const;
