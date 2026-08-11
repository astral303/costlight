import type { Database } from "bun:sqlite";
import {
  parseRequestMetadataByUsageOffset,
  type KimiRequestMetadata,
} from "./request-parser";

interface StoredCanonicalCall {
  agent_id: string;
  cache_read_tokens: number;
  canonical_byte_offset: number;
  canonical_source_path: string;
  event_fingerprint: string;
  input_other_tokens: number;
  raw_model: string;
  session_id: string;
  timestamp_ms: number;
}

export interface CacheCall {
  agentId: string;
  cacheReadTokens: number;
  eventFingerprint: string;
  inputOtherTokens: number;
  messageCount: number | null;
  model: string;
  requestTimestampMs: number;
  requestTimingSource: "llm-request" | "usage-record";
  sessionId: string;
  systemPromptHash: string | null;
  toolsHash: string | null;
  usageTimestampMs: number;
}

export interface LoadedCacheCalls {
  calls: readonly CacheCall[];
  firstRequestTimestampMs: number | null;
  lastRequestTimestampMs: number | null;
  malformedRequestLineCount: number;
  requestTimestampCount: number;
  usageTimestampFallbackCount: number;
}

export async function loadCanonicalCacheCalls(database: Database): Promise<LoadedCacheCalls> {
  const storedCalls = database
    .query<StoredCanonicalCall, []>(`
      SELECT
        event_fingerprint,
        canonical_source_path,
        canonical_byte_offset,
        timestamp_ms,
        raw_model,
        input_other_tokens,
        cache_read_tokens,
        session_id,
        agent_id
      FROM api_calls
      WHERE provider = 'moonshotai'
      ORDER BY timestamp_ms, event_fingerprint
    `)
    .all();
  const targetOffsetsByPath = collectTargetOffsets(storedCalls);
  const parsedSources = await Promise.all(
    [...targetOffsetsByPath].map(async ([sourcePath, targetOffsets]) => {
      const bytes = new Uint8Array(await Bun.file(sourcePath).arrayBuffer());
      return {
        parsed: parseRequestMetadataByUsageOffset(bytes, targetOffsets),
        sourcePath,
      };
    }),
  );

  const requestMetadataByCall = new Map<string, KimiRequestMetadata>();
  let malformedRequestLineCount = 0;
  for (const { parsed, sourcePath } of parsedSources) {
    malformedRequestLineCount += parsed.malformedRelevantLineCount;
    for (const [usageOffset, requestMetadata] of parsed.requestsByUsageOffset) {
      requestMetadataByCall.set(callLocationKey(sourcePath, usageOffset), requestMetadata);
    }
  }

  let requestTimestampCount = 0;
  const calls = storedCalls.map((storedCall): CacheCall => {
    const requestMetadata = requestMetadataByCall.get(
      callLocationKey(storedCall.canonical_source_path, storedCall.canonical_byte_offset),
    );
    if (requestMetadata !== undefined) {
      requestTimestampCount += 1;
    }

    return {
      agentId: storedCall.agent_id,
      cacheReadTokens: storedCall.cache_read_tokens,
      eventFingerprint: storedCall.event_fingerprint,
      inputOtherTokens: storedCall.input_other_tokens,
      messageCount: requestMetadata?.messageCount ?? null,
      model: storedCall.raw_model,
      requestTimestampMs: requestMetadata?.requestedAtMs ?? storedCall.timestamp_ms,
      requestTimingSource: requestMetadata === undefined ? "usage-record" : "llm-request",
      sessionId: storedCall.session_id,
      systemPromptHash: requestMetadata?.systemPromptHash ?? null,
      toolsHash: requestMetadata?.toolsHash ?? null,
      usageTimestampMs: storedCall.timestamp_ms,
    };
  });

  return {
    calls,
    firstRequestTimestampMs: minimumOrNull(calls.map(({ requestTimestampMs }) => requestTimestampMs)),
    lastRequestTimestampMs: maximumOrNull(calls.map(({ requestTimestampMs }) => requestTimestampMs)),
    malformedRequestLineCount,
    requestTimestampCount,
    usageTimestampFallbackCount: calls.length - requestTimestampCount,
  };
}

function minimumOrNull(values: readonly number[]): number | null {
  return values.length === 0 ? null : Math.min(...values);
}

function maximumOrNull(values: readonly number[]): number | null {
  return values.length === 0 ? null : Math.max(...values);
}

function collectTargetOffsets(
  calls: readonly StoredCanonicalCall[],
): ReadonlyMap<string, ReadonlySet<number>> {
  const offsetsByPath = new Map<string, Set<number>>();
  for (const call of calls) {
    const offsets = offsetsByPath.get(call.canonical_source_path) ?? new Set<number>();
    offsets.add(call.canonical_byte_offset);
    offsetsByPath.set(call.canonical_source_path, offsets);
  }
  return offsetsByPath;
}

function callLocationKey(sourcePath: string, usageOffset: number): string {
  return `${sourcePath}\u0000${usageOffset}`;
}
