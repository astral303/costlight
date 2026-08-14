import type { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { stat } from "node:fs/promises";
import { CallLedger } from "../call-accounting/ledger";
import type {
  AgentMetadata,
  DiscoveredSession,
  DiscoveredUsageFile,
  ParsedSessionState,
  RequestIdentityContext,
  SessionImportProvider,
} from "./types";

const FINGERPRINT_SAMPLE_BYTES = 4096;

interface StoredSourceFile {
  byte_checkpoint: number;
  checkpoint_fingerprint: string | null;
  fingerprint_length: number;
  generation: number;
  parser_context_json: string;
}

interface StoredSessionMetadata {
  created_at_ms: number;
  metadata_checkpoint_bytes: number;
  parse_status: string;
  state_mtime_ms: number | null;
  state_size_bytes: number | null;
  title: string | null;
  updated_at_ms: number;
  work_directory: string | null;
}

interface CachedSourceSlice {
  bytes: Uint8Array;
  fileModifiedAtMs: number;
  fileSize: number;
  startingByteOffset: number;
}

export interface ImportSummary {
  discoveredSessionCount: number;
  discoveredSourceCount: number;
  insertedOccurrenceCount: number;
  malformedLineCount: number;
  removedOccurrenceCount: number;
  rewrittenSourceCount: number;
  sourceDataBytesRead: number;
  sourceErrorCount: number;
}

export class SessionImporter {
  readonly #database: Database;
  readonly #ledger: CallLedger;
  readonly #providers: readonly SessionImportProvider[];
  readonly #sourceSlices = new Map<string, CachedSourceSlice>();
  readonly #sourceRoots: readonly string[];

  constructor(
    database: Database,
    providers: readonly SessionImportProvider[],
    ledger = new CallLedger(database),
  ) {
    this.#database = database;
    this.#ledger = ledger;
    this.#providers = providers;
    this.#sourceRoots = providers.flatMap((provider) => provider.sourceRoots);
  }

  async reconcile(): Promise<ImportSummary> {
    this.#sourceSlices.clear();
    const discoveredProviders = await Promise.all(this.#providers.map(async (provider) => ({
      provider,
      sessions: await provider.discoverSessions(),
    })));
    const discoveredSessionCount = discoveredProviders.reduce(
      (count, discovered) => count + discovered.sessions.length,
      0,
    );
    const summary: ImportSummary = {
      discoveredSessionCount,
      discoveredSourceCount: 0,
      insertedOccurrenceCount: 0,
      malformedLineCount: 0,
      removedOccurrenceCount: 0,
      rewrittenSourceCount: 0,
      sourceDataBytesRead: 0,
      sourceErrorCount: 0,
    };

    for (const { provider, sessions } of discoveredProviders) {
      for (const session of sessions) {
        summary.sourceDataBytesRead += await this.#storeSession(provider, session);
        summary.discoveredSourceCount += session.usageFiles.length;
      }
    }

    const discoveredSourcePaths = new Set<string>();
    for (const { provider, sessions } of discoveredProviders) {
      for (const session of sessions) {
        for (const usageFile of session.usageFiles) {
          discoveredSourcePaths.add(usageFile.path);
          try {
            const sourceSummary = await this.#importSource(provider, session, usageFile);
            summary.insertedOccurrenceCount += sourceSummary.insertedOccurrenceCount;
            summary.malformedLineCount += sourceSummary.malformedLineCount;
            summary.rewrittenSourceCount += sourceSummary.wasRewritten ? 1 : 0;
            summary.sourceDataBytesRead += sourceSummary.sourceDataBytesRead;
          } catch (error) {
            summary.sourceErrorCount += 1;
            this.#database
              .query("UPDATE source_files SET last_error = ? WHERE path = ?")
              .run(errorMessage(error), usageFile.path);
          }
          await Bun.sleep(0);
        }
      }
    }

    summary.removedOccurrenceCount = this.#removeMissingSources(discoveredSourcePaths);
    return summary;
  }

  getWatchDirectories(): readonly string[] {
    return this.#providers.flatMap((provider) => provider.watchDirectories);
  }

  isRelevantFile(filePath: string): boolean {
    return this.#providers.some((provider) => provider.isRelevantFile(filePath));
  }

  async #storeSession(
    provider: SessionImportProvider,
    session: DiscoveredSession,
  ): Promise<number> {
    const storedMetadata = this.#database
      .query<StoredSessionMetadata, [string]>(`
        SELECT created_at_ms, updated_at_ms, work_directory, title,
               state_size_bytes, state_mtime_ms, parse_status,
               metadata_checkpoint_bytes
        FROM sessions
        WHERE session_id = ?
      `)
      .get(session.sessionId);
    const storedAgents = this.#database
      .query<AgentMetadata, [string]>(`
        SELECT agent_id AS agentId, agent_type AS agentType,
               parent_agent_id AS parentAgentId, source_directory AS sourceDirectory
        FROM agents
        WHERE session_id = ?
      `)
      .all(session.sessionId);
    let state: ParsedSessionState;
    let metadataSize: number | null = null;
    let metadataModifiedAtMs: number | null = null;
    let metadataCheckpoint = storedMetadata?.metadata_checkpoint_bytes ?? 0;
    let parseStatus = "missing";
    let sourceDataBytesRead = 0;

    if (session.metadataSourcePath === null) {
      state = storedSessionState(
        provider,
        session,
        storedMetadata,
        storedAgents,
        Date.now(),
      );
    } else {
      const metadataStat = await stat(session.metadataSourcePath);
      metadataSize = metadataStat.size;
      metadataModifiedAtMs = metadataStat.mtimeMs;
      const hasUnchangedMetadata = storedMetadata !== null
        && storedMetadata.state_size_bytes === metadataSize
        && storedMetadata.state_mtime_ms === metadataModifiedAtMs
        && storedMetadata.metadata_checkpoint_bytes === metadataSize;
      if (hasUnchangedMetadata) {
        state = storedSessionState(
          provider,
          session,
          storedMetadata,
          storedAgents,
          metadataStat.mtimeMs,
        );
        parseStatus = storedMetadata.parse_status;
      } else {
        const defaults = {
          agentDirectories: session.agentDirectories,
          fallbackTimestampMs: metadataStat.birthtimeMs || metadataStat.mtimeMs,
        };
        try {
          if (provider.parseSessionMetadataChunk === undefined) {
            state = provider.parseSessionState(
              await Bun.file(session.metadataSourcePath).text(),
              defaults,
            );
            metadataCheckpoint = metadataSize;
          } else {
            const storedSource = this.#readStoredSource(session.metadataSourcePath);
            const wasRewritten = storedSource !== null && await this.#wasSourceRewritten(
              session.metadataSourcePath,
              metadataSize,
              storedSource,
            );
            const isAppend = storedMetadata !== null
              && metadataSize >= metadataCheckpoint
              && !wasRewritten;
            const startingCheckpoint = isAppend ? metadataCheckpoint : 0;
            const previousState = isAppend
              ? storedSessionState(
                provider,
                session,
                storedMetadata,
                storedAgents,
                metadataStat.mtimeMs,
              )
              : null;
            const bytes = new Uint8Array(
              await Bun.file(session.metadataSourcePath)
                .slice(startingCheckpoint)
                .arrayBuffer(),
            );
            sourceDataBytesRead += bytes.byteLength;
            this.#sourceSlices.set(session.metadataSourcePath, {
              bytes,
              fileModifiedAtMs: metadataStat.mtimeMs,
              fileSize: metadataStat.size,
              startingByteOffset: startingCheckpoint,
            });
            const parsed = provider.parseSessionMetadataChunk(bytes, previousState, defaults);
            state = parsed.state;
            metadataCheckpoint = startingCheckpoint + parsed.completeByteLength;
          }
          parseStatus = "ok";
        } catch (error) {
          state = storedSessionState(
            provider,
            session,
            storedMetadata,
            storedAgents,
            metadataStat.mtimeMs,
          );
          parseStatus = `error: ${errorMessage(error)}`;
        }
      }
    }

    const store = this.#database.transaction(() => {
      const workspaceKey = provider.resolveWorkspaceKey?.(session, state)
        ?? session.workspaceKey;
      this.#database
        .query(`
          INSERT INTO sessions (
            session_id, provider, workspace_key, work_directory, title, created_at_ms, updated_at_ms,
            state_file_path, state_size_bytes, state_mtime_ms, parse_status,
            metadata_checkpoint_bytes
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(session_id) DO UPDATE SET
            provider = excluded.provider,
            workspace_key = excluded.workspace_key,
            work_directory = excluded.work_directory,
            title = excluded.title,
            created_at_ms = excluded.created_at_ms,
            updated_at_ms = excluded.updated_at_ms,
            state_file_path = excluded.state_file_path,
            state_size_bytes = excluded.state_size_bytes,
            state_mtime_ms = excluded.state_mtime_ms,
            parse_status = excluded.parse_status,
            metadata_checkpoint_bytes = excluded.metadata_checkpoint_bytes
        `)
        .run(
          session.sessionId,
          session.provider,
          workspaceKey,
          state.workDirectory,
          state.title,
          state.createdAtMs,
          state.updatedAtMs,
          session.metadataSourcePath,
          metadataSize,
          metadataModifiedAtMs,
          parseStatus,
          metadataCheckpoint,
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
    if (storedMetadata !== null && storedMetadata.created_at_ms !== state.createdAtMs) {
      this.#ledger.rebuildSessionCanonicalCalls(session.sessionId);
    }
    return sourceDataBytesRead;
  }

  async #importSource(
    provider: SessionImportProvider,
    session: DiscoveredSession,
    usageFile: DiscoveredUsageFile,
  ) {
    const fileStat = await stat(usageFile.path);
    let storedSource = this.#database
      .query<StoredSourceFile, [string]>(`
        SELECT generation, byte_checkpoint, checkpoint_fingerprint,
               fingerprint_length, parser_context_json
        FROM source_files
        WHERE path = ?
      `)
      .get(usageFile.path);

    if (storedSource === null) {
      this.#database
        .query(`
          INSERT INTO source_files (
            path, source_root, session_id, agent_id, last_size_bytes, last_mtime_ms
          ) VALUES (?, ?, ?, ?, ?, ?)
        `)
        .run(
          usageFile.path,
          session.sourceRoot,
          session.sessionId,
          usageFile.agentId,
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

    const wasRewritten = await this.#wasSourceRewritten(
      usageFile.path,
      fileStat.size,
      storedSource,
    );
    if (wasRewritten) {
      const resetSource = this.#database.transaction(() => {
        this.#ledger.removeSourceOccurrences(usageFile.path);
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
          .run(usageFile.path);
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

    const cachedSlice = this.#sourceSlices.get(usageFile.path);
    const canReuseCachedSlice = cachedSlice !== undefined
      && cachedSlice.startingByteOffset === storedSource.byte_checkpoint
      && cachedSlice.fileSize === fileStat.size
      && cachedSlice.fileModifiedAtMs === fileStat.mtimeMs;
    const appendedBytes = canReuseCachedSlice
      ? cachedSlice.bytes
      : new Uint8Array(
        await Bun.file(usageFile.path).slice(storedSource.byte_checkpoint).arrayBuffer(),
      );
    const parsedChunk = provider.parseUsageChunk(
      appendedBytes,
      storedSource.byte_checkpoint,
      parseStoredContext(storedSource.parser_context_json),
    );
    const nextCheckpoint = storedSource.byte_checkpoint + parsedChunk.completeByteLength;
    const checkpointFingerprint = await createCheckpointFingerprint(
      usageFile.path,
      nextCheckpoint,
    );
    let insertedOccurrenceCount = 0;

    const commitSource = this.#database.transaction(() => {
      for (const record of parsedChunk.records) {
        if (this.#ledger.recordUsage({
          agentId: usageFile.agentId,
          generation: storedSource.generation,
          sessionId: session.sessionId,
          sourcePath: usageFile.path,
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
          usageFile.agentId,
          nextCheckpoint,
          fileStat.size,
          fileStat.mtimeMs,
          checkpointFingerprint,
          Math.min(FINGERPRINT_SAMPLE_BYTES, nextCheckpoint),
          JSON.stringify(parsedChunk.context),
          Date.now(),
          usageFile.path,
        );
    });
    commitSource();

    return {
      insertedOccurrenceCount,
      malformedLineCount: parsedChunk.ignoredMalformedLineCount,
      sourceDataBytesRead: canReuseCachedSlice ? 0 : appendedBytes.byteLength,
      wasRewritten,
    };
  }

  #readStoredSource(sourcePath: string): StoredSourceFile | null {
    return this.#database
      .query<StoredSourceFile, [string]>(`
        SELECT generation, byte_checkpoint, checkpoint_fingerprint,
               fingerprint_length, parser_context_json
        FROM source_files
        WHERE path = ?
      `)
      .get(sourcePath);
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

function storedSessionState(
  provider: SessionImportProvider,
  session: DiscoveredSession,
  stored: StoredSessionMetadata | null,
  storedAgents: readonly AgentMetadata[],
  fallbackTimestampMs: number,
): ParsedSessionState {
  const fallback = provider.createFallbackSessionState(
    session.agentDirectories,
    fallbackTimestampMs,
  );
  if (stored === null) return fallback;
  return {
    agents: mergeStoredAgents(storedAgents, fallback.agents),
    createdAtMs: stored.created_at_ms,
    title: stored.title,
    updatedAtMs: stored.updated_at_ms,
    workDirectory: stored.work_directory,
  };
}

function mergeStoredAgents(
  storedAgents: readonly AgentMetadata[],
  discoveredAgents: readonly AgentMetadata[],
): readonly AgentMetadata[] {
  const agents = new Map(storedAgents.map((agent) => [agent.agentId, agent]));
  for (const discovered of discoveredAgents) {
    const stored = agents.get(discovered.agentId);
    agents.set(discovered.agentId, stored === undefined
      ? discovered
      : { ...stored, sourceDirectory: discovered.sourceDirectory });
  }
  return [...agents.values()];
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
