import type { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { stat } from "node:fs/promises";
import { CallLedger } from "../call-accounting/ledger";
import { discoverKimiSessions } from "./discovery";
import { createFallbackSessionState, parseSessionState } from "./state-parser";
import type {
  DiscoveredSession,
  DiscoveredWireFile,
  ParsedSessionState,
  RequestIdentityContext,
} from "./types";
import { parseWireChunk } from "./wire-parser";

const FINGERPRINT_SAMPLE_BYTES = 4096;

interface StoredSourceFile {
  byte_checkpoint: number;
  checkpoint_fingerprint: string | null;
  fingerprint_length: number;
  generation: number;
  parser_context_json: string;
}

export interface ImportSummary {
  discoveredSessionCount: number;
  discoveredSourceCount: number;
  insertedOccurrenceCount: number;
  malformedLineCount: number;
  removedOccurrenceCount: number;
  rewrittenSourceCount: number;
  sourceErrorCount: number;
}

export class SessionImporter {
  readonly #database: Database;
  readonly #ledger: CallLedger;
  readonly #sourceRoots: readonly string[];

  constructor(database: Database, sourceRoots: readonly string[], ledger = new CallLedger(database)) {
    this.#database = database;
    this.#ledger = ledger;
    this.#sourceRoots = sourceRoots;
  }

  async reconcile(): Promise<ImportSummary> {
    const sessions = await discoverKimiSessions(this.#sourceRoots);
    const summary: ImportSummary = {
      discoveredSessionCount: sessions.length,
      discoveredSourceCount: 0,
      insertedOccurrenceCount: 0,
      malformedLineCount: 0,
      removedOccurrenceCount: 0,
      rewrittenSourceCount: 0,
      sourceErrorCount: 0,
    };

    for (const session of sessions) {
      await this.#storeSession(session);
      summary.discoveredSourceCount += session.wireFiles.length;
    }

    const discoveredSourcePaths = new Set<string>();
    for (const session of sessions) {
      for (const wireFile of session.wireFiles) {
        discoveredSourcePaths.add(wireFile.path);
        try {
          const sourceSummary = await this.#importSource(session, wireFile);
          summary.insertedOccurrenceCount += sourceSummary.insertedOccurrenceCount;
          summary.malformedLineCount += sourceSummary.malformedLineCount;
          summary.rewrittenSourceCount += sourceSummary.wasRewritten ? 1 : 0;
        } catch (error) {
          summary.sourceErrorCount += 1;
          this.#database
            .query("UPDATE source_files SET last_error = ? WHERE path = ?")
            .run(errorMessage(error), wireFile.path);
        }
        await Bun.sleep(0);
      }
    }

    summary.removedOccurrenceCount = this.#removeMissingSources(discoveredSourcePaths);
    return summary;
  }

  async #storeSession(session: DiscoveredSession): Promise<void> {
    const previousCreatedAtMs = this.#database
      .query<{ created_at_ms: number }, [string]>(
        "SELECT created_at_ms FROM sessions WHERE session_id = ?",
      )
      .get(session.sessionId)?.created_at_ms;
    let state: ParsedSessionState;
    let stateSize: number | null = null;
    let stateModifiedAtMs: number | null = null;
    let parseStatus = "missing";

    if (session.stateFilePath === null) {
      state = createFallbackSessionState(session.agentDirectories, Date.now());
    } else {
      const stateFileStat = await stat(session.stateFilePath);
      stateSize = stateFileStat.size;
      stateModifiedAtMs = stateFileStat.mtimeMs;
      try {
        state = parseSessionState(await Bun.file(session.stateFilePath).text(), {
          agentDirectories: session.agentDirectories,
          fallbackTimestampMs: stateFileStat.birthtimeMs || stateFileStat.mtimeMs,
        });
        parseStatus = "ok";
      } catch (error) {
        state = createFallbackSessionState(session.agentDirectories, stateFileStat.mtimeMs);
        parseStatus = `error: ${errorMessage(error)}`;
      }
    }

    const store = this.#database.transaction(() => {
      this.#database
        .query(`
          INSERT INTO sessions (
            session_id, workspace_key, work_directory, title, created_at_ms, updated_at_ms,
            state_file_path, state_size_bytes, state_mtime_ms, parse_status
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(session_id) DO UPDATE SET
            workspace_key = excluded.workspace_key,
            work_directory = excluded.work_directory,
            title = excluded.title,
            created_at_ms = excluded.created_at_ms,
            updated_at_ms = excluded.updated_at_ms,
            state_file_path = excluded.state_file_path,
            state_size_bytes = excluded.state_size_bytes,
            state_mtime_ms = excluded.state_mtime_ms,
            parse_status = excluded.parse_status
        `)
        .run(
          session.sessionId,
          session.workspaceKey,
          state.workDirectory,
          state.title,
          state.createdAtMs,
          state.updatedAtMs,
          session.stateFilePath,
          stateSize,
          stateModifiedAtMs,
          parseStatus,
        );

      for (const agent of state.agents) {
        this.#database
          .query(`
            INSERT INTO agents (session_id, agent_id, agent_type, parent_agent_id, source_directory)
            VALUES (?, ?, ?, ?, ?)
            ON CONFLICT(session_id, agent_id) DO UPDATE SET
              agent_type = excluded.agent_type,
              parent_agent_id = excluded.parent_agent_id,
              source_directory = excluded.source_directory
          `)
          .run(
            session.sessionId,
            agent.agentId,
            agent.agentType,
            agent.parentAgentId,
            agent.sourceDirectory,
          );
      }
    });
    store();
    if (previousCreatedAtMs !== undefined && previousCreatedAtMs !== state.createdAtMs) {
      this.#ledger.rebuildSessionCanonicalCalls(session.sessionId);
    }
  }

  async #importSource(session: DiscoveredSession, wireFile: DiscoveredWireFile) {
    const fileStat = await stat(wireFile.path);
    let storedSource = this.#database
      .query<StoredSourceFile, [string]>(`
        SELECT generation, byte_checkpoint, checkpoint_fingerprint,
               fingerprint_length, parser_context_json
        FROM source_files
        WHERE path = ?
      `)
      .get(wireFile.path);

    if (storedSource === null) {
      this.#database
        .query(`
          INSERT INTO source_files (
            path, source_root, session_id, agent_id, last_size_bytes, last_mtime_ms
          ) VALUES (?, ?, ?, ?, ?, ?)
        `)
        .run(
          wireFile.path,
          session.sourceRoot,
          session.sessionId,
          wireFile.agentId,
          fileStat.size,
          fileStat.mtimeMs,
        );
      storedSource = {
        byte_checkpoint: 0,
        checkpoint_fingerprint: null,
        fingerprint_length: 0,
        generation: 0,
        parser_context_json: "{}",
      };
    }

    const wasRewritten = await this.#wasSourceRewritten(wireFile.path, fileStat.size, storedSource);
    if (wasRewritten) {
      const resetSource = this.#database.transaction(() => {
        this.#ledger.removeSourceOccurrences(wireFile.path);
        this.#database
          .query(`
            UPDATE source_files
            SET generation = generation + 1,
                byte_checkpoint = 0,
                checkpoint_fingerprint = NULL,
                fingerprint_length = 0,
                parser_context_json = '{}'
            WHERE path = ?
          `)
          .run(wireFile.path);
      });
      resetSource();
      storedSource = {
        byte_checkpoint: 0,
        checkpoint_fingerprint: null,
        fingerprint_length: 0,
        generation: storedSource.generation + 1,
        parser_context_json: "{}",
      };
    }

    const appendedBytes = new Uint8Array(
      await Bun.file(wireFile.path).slice(storedSource.byte_checkpoint).arrayBuffer(),
    );
    const parsedChunk = parseWireChunk(
      appendedBytes,
      storedSource.byte_checkpoint,
      parseStoredContext(storedSource.parser_context_json),
    );
    const nextCheckpoint = storedSource.byte_checkpoint + parsedChunk.completeByteLength;
    const checkpointFingerprint = await createCheckpointFingerprint(wireFile.path, nextCheckpoint);
    let insertedOccurrenceCount = 0;

    const commitSource = this.#database.transaction(() => {
      for (const record of parsedChunk.records) {
        if (this.#ledger.recordUsage({
          agentId: wireFile.agentId,
          generation: storedSource.generation,
          sessionId: session.sessionId,
          sourcePath: wireFile.path,
        }, record)) {
          insertedOccurrenceCount += 1;
        }
      }

      this.#database
        .query(`
          UPDATE source_files
          SET source_root = ?, session_id = ?, agent_id = ?, byte_checkpoint = ?,
              last_size_bytes = ?, last_mtime_ms = ?, checkpoint_fingerprint = ?,
              fingerprint_length = ?, parser_context_json = ?, last_error = NULL,
              last_successful_scan_ms = ?
          WHERE path = ?
        `)
        .run(
          session.sourceRoot,
          session.sessionId,
          wireFile.agentId,
          nextCheckpoint,
          fileStat.size,
          fileStat.mtimeMs,
          checkpointFingerprint,
          Math.min(FINGERPRINT_SAMPLE_BYTES, nextCheckpoint),
          JSON.stringify(parsedChunk.context),
          Date.now(),
          wireFile.path,
        );
    });
    commitSource();

    return {
      insertedOccurrenceCount,
      malformedLineCount: parsedChunk.ignoredMalformedLineCount,
      wasRewritten,
    };
  }

  async #wasSourceRewritten(
    sourcePath: string,
    currentSize: number,
    storedSource: StoredSourceFile,
  ): Promise<boolean> {
    if (currentSize < storedSource.byte_checkpoint) {
      return true;
    }
    if (storedSource.checkpoint_fingerprint === null || storedSource.byte_checkpoint === 0) {
      return false;
    }

    const currentFingerprint = await createCheckpointFingerprint(
      sourcePath,
      storedSource.byte_checkpoint,
    );
    return currentFingerprint !== storedSource.checkpoint_fingerprint;
  }

  #removeMissingSources(discoveredSourcePaths: ReadonlySet<string>): number {
    const storedSources = this.#database
      .query<{ path: string; source_root: string }, []>("SELECT path, source_root FROM source_files")
      .all();
    let removedOccurrenceCount = 0;
    const removeSource = this.#database.transaction((sourcePath: string) => {
      removedOccurrenceCount += this.#ledger.removeSourceOccurrences(sourcePath);
      this.#database.query("DELETE FROM source_files WHERE path = ?").run(sourcePath);
    });

    for (const storedSource of storedSources) {
      if (
        this.#sourceRoots.includes(storedSource.source_root)
        && !discoveredSourcePaths.has(storedSource.path)
      ) {
        removeSource(storedSource.path);
      }
    }
    return removedOccurrenceCount;
  }
}

async function createCheckpointFingerprint(sourcePath: string, checkpoint: number): Promise<string | null> {
  if (checkpoint === 0) {
    return null;
  }

  const sampleLength = Math.min(FINGERPRINT_SAMPLE_BYTES, checkpoint);
  const firstSample = new Uint8Array(
    await Bun.file(sourcePath).slice(0, sampleLength).arrayBuffer(),
  );
  const finalSampleStart = Math.max(0, checkpoint - sampleLength);
  const finalSample = new Uint8Array(
    await Bun.file(sourcePath).slice(finalSampleStart, checkpoint).arrayBuffer(),
  );
  return createHash("sha256")
    .update(firstSample)
    .update(finalSample)
    .update(String(checkpoint))
    .digest("hex");
}

function parseStoredContext(value: string): RequestIdentityContext {
  try {
    const context: unknown = JSON.parse(value);
    if (typeof context !== "object" || context === null || Array.isArray(context)) {
      return {};
    }

    const record = context as Record<string, unknown>;
    return {
      ...(typeof record.providerRequestId === "string"
        ? { providerRequestId: record.providerRequestId }
        : {}),
      ...(typeof record.requestMetadata === "string"
        ? { requestMetadata: record.requestMetadata }
        : {}),
      ...(typeof record.stepUuid === "string" ? { stepUuid: record.stepUuid } : {}),
    };
  } catch {
    return {};
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
