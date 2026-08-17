import { readFile } from "node:fs/promises";
import { discoverClaudeSessions } from "../session-import/claude/discovery";
import { parseClaudeTranscriptChunk } from "../session-import/claude/parser";
import type { ParsedUsageRecord } from "../session-import/types";

/**
 * A marker the importer drops on purpose. None of these bill on their own; they are the only
 * local trace of a turn that started and did not finish normally.
 */
export type TranscriptMarkerKind = "api-error" | "interrupted" | "streaming-snapshot";

export interface TranscriptMarker {
  kind: TranscriptMarkerKind;
  timestampMs: number;
}

/** A healthy transcript has exactly one root; a dangling parent means records went missing. */
export interface TranscriptChain {
  danglingParentCount: number;
  rootCount: number;
}

export interface LoadedTranscript {
  agentId: string;
  chain: TranscriptChain;
  malformedLineCount: number;
  markers: readonly TranscriptMarker[];
  path: string;
  records: readonly ParsedUsageRecord[];
  sessionId: string;
  workspaceKey: string;
}

/**
 * Reads every transcript the importer would read, through the importer's own discovery and
 * parser. A diagnostic that re-derived either would answer for a different set of files than the
 * ledger holds, which is the one thing it must never do.
 */
export async function loadClaudeTranscripts(
  claudeRoots: readonly string[],
): Promise<readonly LoadedTranscript[]> {
  const transcripts: LoadedTranscript[] = [];

  for (const session of await discoverClaudeSessions(claudeRoots)) {
    for (const usageFile of session.usageFiles) {
      const bytes = await readTranscriptBytes(usageFile.path);
      if (bytes === null) {
        continue;
      }

      const scan = scanDiagnosticLines(bytes);
      transcripts.push({
        agentId: usageFile.agentId,
        chain: scan.chain,
        malformedLineCount: scan.malformedLineCount,
        markers: scan.markers,
        path: usageFile.path,
        records: parseClaudeTranscriptChunk(bytes, 0).records,
        sessionId: session.sessionId,
        workspaceKey: session.workspaceKey,
      });
    }
  }

  return transcripts;
}

async function readTranscriptBytes(path: string): Promise<Uint8Array | null> {
  try {
    return await readFile(path);
  } catch {
    // A session can be deleted between discovery and this read; it is simply not diagnosable.
    return null;
  }
}

interface DiagnosticScan {
  chain: TranscriptChain;
  malformedLineCount: number;
  markers: readonly TranscriptMarker[];
}

interface ChainLink {
  parentUuid: string | null;
}

/**
 * Counts what `parseClaudeTranscriptChunk` filters out: malformed lines of every record type,
 * the uuid chain, and unfinished-turn markers. The usage parser keeps only billable assistant
 * records, so it cannot see a turn that produced no usage at all.
 */
function scanDiagnosticLines(bytes: Uint8Array): DiagnosticScan {
  const links: ChainLink[] = [];
  const markers: TranscriptMarker[] = [];
  const uuids = new Set<string>();
  let malformedLineCount = 0;

  for (const line of new TextDecoder().decode(bytes).split("\n")) {
    if (line.trim() === "") {
      continue;
    }

    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch {
      malformedLineCount += 1;
      continue;
    }
    if (!isRecord(value)) {
      malformedLineCount += 1;
      continue;
    }

    if (typeof value.uuid === "string") {
      uuids.add(value.uuid);
      links.push({ parentUuid: typeof value.parentUuid === "string" ? value.parentUuid : null });
    }

    const timestampMs = Date.parse(typeof value.timestamp === "string" ? value.timestamp : "");
    if (!Number.isNaN(timestampMs)) {
      const kind = classifyMarker(value);
      if (kind !== null) {
        markers.push({ kind, timestampMs });
      }
    }
  }

  return {
    chain: {
      danglingParentCount: links.filter((link) => (
        link.parentUuid !== null && !uuids.has(link.parentUuid)
      )).length,
      rootCount: links.filter((link) => link.parentUuid === null).length,
    },
    malformedLineCount,
    markers,
  };
}

function classifyMarker(value: Record<string, unknown>): TranscriptMarkerKind | null {
  if (value.interruptedMessageId !== undefined || hasInterruptionNotice(value.message)) {
    return "interrupted";
  }
  if (value.isApiErrorMessage === true || value.apiErrorStatus !== undefined) {
    return "api-error";
  }
  // A null stop_reason marks a partial streaming snapshot, not an abandoned turn: these track
  // the ledger's superseded-usage occurrences, not the shortfall against Anthropic's export.
  if (value.type === "assistant" && isRecord(value.message) && value.message.stop_reason === null) {
    return "streaming-snapshot";
  }

  return null;
}

function hasInterruptionNotice(message: unknown): boolean {
  return isRecord(message)
    && typeof message.content === "string"
    && message.content.includes("[Request interrupted");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
