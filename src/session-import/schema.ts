export const sessionImportMigration = {
  version: 1,
  name: "session import storage",
  sql: `
    CREATE TABLE sessions (
      session_id TEXT PRIMARY KEY,
      workspace_key TEXT NOT NULL,
      work_directory TEXT,
      title TEXT,
      created_at_ms INTEGER NOT NULL,
      updated_at_ms INTEGER NOT NULL,
      state_file_path TEXT UNIQUE,
      state_size_bytes INTEGER,
      state_mtime_ms INTEGER,
      parse_status TEXT NOT NULL DEFAULT 'pending'
    );

    CREATE INDEX sessions_workspace_index ON sessions(workspace_key);
    CREATE INDEX sessions_updated_index ON sessions(updated_at_ms DESC);

    CREATE TABLE agents (
      session_id TEXT NOT NULL,
      agent_id TEXT NOT NULL,
      agent_type TEXT NOT NULL CHECK (agent_type IN ('main', 'sub', 'unknown')),
      parent_agent_id TEXT,
      source_directory TEXT NOT NULL,
      PRIMARY KEY (session_id, agent_id),
      FOREIGN KEY (session_id) REFERENCES sessions(session_id) ON DELETE CASCADE
    );

    CREATE INDEX agents_type_index ON agents(agent_type);

    CREATE TABLE source_files (
      path TEXT PRIMARY KEY,
      source_root TEXT NOT NULL,
      session_id TEXT NOT NULL,
      agent_id TEXT NOT NULL,
      generation INTEGER NOT NULL DEFAULT 0,
      byte_checkpoint INTEGER NOT NULL DEFAULT 0,
      last_size_bytes INTEGER NOT NULL DEFAULT 0,
      last_mtime_ms INTEGER NOT NULL DEFAULT 0,
      checkpoint_fingerprint TEXT,
      fingerprint_length INTEGER NOT NULL DEFAULT 0,
      parser_context_json TEXT NOT NULL DEFAULT '{}',
      last_error TEXT,
      last_successful_scan_ms INTEGER,
      FOREIGN KEY (session_id) REFERENCES sessions(session_id) ON DELETE CASCADE,
      FOREIGN KEY (session_id, agent_id) REFERENCES agents(session_id, agent_id) ON DELETE CASCADE
    );

    CREATE INDEX source_files_session_index ON source_files(session_id, agent_id);
  `,
} as const;

export const sessionProviderMigration = {
  version: 5,
  name: "session providers",
  sql: `
    ALTER TABLE sessions ADD COLUMN provider TEXT NOT NULL DEFAULT 'moonshotai';
    CREATE INDEX sessions_provider_index ON sessions(provider, updated_at_ms DESC);
  `,
} as const;

export const sessionMetadataCheckpointMigration = {
  version: 9,
  name: "incremental session metadata",
  sql: `
    ALTER TABLE sessions
      ADD COLUMN metadata_checkpoint_bytes INTEGER NOT NULL DEFAULT 0;
  `,
} as const;

export const agentIdentityMigration = {
  version: 10,
  name: "stable agent identities",
  sql: `
    ALTER TABLE agents ADD COLUMN agent_key TEXT NOT NULL DEFAULT '';
    ALTER TABLE agents ADD COLUMN agent_label TEXT NOT NULL DEFAULT '';
    UPDATE agents
    SET agent_key = CASE WHEN agent_type = 'main' THEN 'main' ELSE agent_id END,
        agent_label = CASE WHEN agent_type = 'main' THEN 'Main' ELSE agent_id END;
    CREATE INDEX agents_key_index ON agents(agent_key);
  `,
} as const;
