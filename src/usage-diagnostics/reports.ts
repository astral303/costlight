import type { CsvRow, CsvTable } from "../call-accounting/csv";
import { zonedDayKey } from "../dashboard/bucketing";
import type { ReplayClassificationRow } from "./replay-loader";
import type { LoadedTranscript } from "./transcript-loader";

const UTC = "UTC";
const HOURS_PER_DAY = 24;

export function summarizeReplayClassifications(
  rows: readonly ReplayClassificationRow[],
): CsvTable {
  return {
    columns: ["utc_day", "raw_model", "canonical", "fork_replay", "possible_replay", "superseded"],
    rows,
  };
}

/**
 * Per-session structure for one day. A session with more than one root, a dangling parent, or a
 * malformed line lost records locally, which is a different failure from a call that was billed
 * and never written at all.
 */
export function summarizeSessionIntegrity(
  transcripts: readonly LoadedTranscript[],
  day: string,
): CsvTable {
  const rows: CsvRow[] = [];

  for (const transcript of transcripts) {
    const timestamps = transcript.records
      .map((record) => record.timestampMs)
      .filter((timestampMs) => zonedDayKey(timestampMs, UTC) === day);
    if (timestamps.length === 0) {
      continue;
    }

    rows.push({
      agent: transcript.agentId,
      calls_on_day: timestamps.length,
      dangling: transcript.chain.danglingParentCount,
      first_utc: utcTimeOfDay(Math.min(...timestamps)),
      last_utc: utcTimeOfDay(Math.max(...timestamps)),
      malformed: transcript.malformedLineCount,
      roots: transcript.chain.rootCount,
      session: transcript.sessionId,
      workspace: transcript.workspaceKey,
    });
  }

  rows.sort((left, right) => String(left.first_utc).localeCompare(String(right.first_utc)));
  return {
    columns: [
      "first_utc",
      "last_utc",
      "calls_on_day",
      "roots",
      "dangling",
      "malformed",
      "agent",
      "session",
      "workspace",
    ],
    rows,
  };
}

interface DayCounts {
  api_error: number;
  interrupted: number;
  occurrences: number;
  requestKeys: Set<string>;
  streaming_snapshot: number;
  utc_day: string;
}

/**
 * Recorded calls per day alongside the markers of turns that did not finish. A request Anthropic
 * billed but Claude Code never finalized leaves no usage record at all, so these markers are the
 * only local trace of what the usage audit cannot see.
 */
export function summarizeAbortMarkers(transcripts: readonly LoadedTranscript[]): CsvTable {
  const countsPerDay = new Map<string, DayCounts>();
  const countsFor = (day: string): DayCounts => {
    const existing = countsPerDay.get(day);
    if (existing !== undefined) {
      return existing;
    }

    const created: DayCounts = {
      api_error: 0,
      interrupted: 0,
      occurrences: 0,
      requestKeys: new Set(),
      streaming_snapshot: 0,
      utc_day: day,
    };
    countsPerDay.set(day, created);
    return created;
  };

  for (const transcript of transcripts) {
    for (const record of transcript.records) {
      const counts = countsFor(zonedDayKey(record.timestampMs, UTC));
      counts.occurrences += 1;
      // Resumed sessions copy earlier turns forward, so only distinct request ids are distinct
      // API calls. A record without one is its own call, identified by where it sits on disk.
      counts.requestKeys.add(
        record.providerRequestId ?? `${transcript.path}#${record.byteOffset}`,
      );
    }

    for (const marker of transcript.markers) {
      const counts = countsFor(zonedDayKey(marker.timestampMs, UTC));
      if (marker.kind === "interrupted") {
        counts.interrupted += 1;
      } else if (marker.kind === "api-error") {
        counts.api_error += 1;
      } else {
        counts.streaming_snapshot += 1;
      }
    }
  }

  const rows = [...countsPerDay.values()]
    .map(({ requestKeys, ...counts }): CsvRow => ({
      ...counts,
      distinct_requests: requestKeys.size,
    }))
    .sort((left, right) => String(left.utc_day).localeCompare(String(right.utc_day)));

  return {
    columns: [
      "utc_day",
      "distinct_requests",
      "occurrences",
      "interrupted",
      "api_error",
      "streaming_snapshot",
    ],
    rows,
  };
}

/** Calls per hour for one day, which shows whether a shortfall is spread out or concentrated. */
export function summarizeCallsPerHour(
  transcripts: readonly LoadedTranscript[],
  day: string,
): CsvTable {
  const callsPerHour = new Array<number>(HOURS_PER_DAY).fill(0);

  for (const transcript of transcripts) {
    for (const record of transcript.records) {
      if (zonedDayKey(record.timestampMs, UTC) !== day) {
        continue;
      }
      const hour = new Date(record.timestampMs).getUTCHours();
      callsPerHour[hour] = (callsPerHour[hour] ?? 0) + 1;
    }
  }

  return {
    columns: ["utc_hour", "calls"],
    rows: callsPerHour.map((calls, hour) => ({
      calls,
      utc_hour: String(hour).padStart(2, "0"),
    })),
  };
}

function utcTimeOfDay(timestampMs: number): string {
  return new Date(timestampMs).toISOString().slice(11, 19);
}
