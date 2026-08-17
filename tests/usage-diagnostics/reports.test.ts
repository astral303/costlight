import { describe, expect, test } from "bun:test";
import { formatCsvTable } from "../../src/call-accounting/csv";
import {
  summarizeAbortMarkers,
  summarizeCallsPerHour,
  summarizeSessionIntegrity,
} from "../../src/usage-diagnostics/reports";
import type {
  LoadedTranscript,
  TranscriptMarker,
} from "../../src/usage-diagnostics/transcript-loader";
import type { ParsedUsageRecord } from "../../src/session-import/types";

describe("summarizeAbortMarkers", () => {
  test("counts a resumed request once while keeping every occurrence", () => {
    const transcript = createTranscript({
      records: [
        createRecord("2026-08-03T01:00:00Z", "req-1"),
        createRecord("2026-08-03T02:00:00Z", "req-1"),
        createRecord("2026-08-03T03:00:00Z", "req-2"),
      ],
    });

    const [row] = summarizeAbortMarkers([transcript]).rows;

    expect(row?.utc_day).toBe("2026-08-03");
    expect(row?.distinct_requests).toBe(2);
    expect(row?.occurrences).toBe(3);
  });

  test("treats records without a request id as distinct calls", () => {
    const transcript = createTranscript({
      records: [
        createRecord("2026-08-03T01:00:00Z", null, 10),
        createRecord("2026-08-03T02:00:00Z", null, 20),
      ],
    });

    expect(summarizeAbortMarkers([transcript]).rows[0]?.distinct_requests).toBe(2);
  });

  test("splits markers by kind and by the day they fall on", () => {
    const transcript = createTranscript({
      markers: [
        { kind: "interrupted", timestampMs: Date.parse("2026-08-03T04:00:00Z") },
        { kind: "api-error", timestampMs: Date.parse("2026-08-03T05:00:00Z") },
        { kind: "streaming-snapshot", timestampMs: Date.parse("2026-08-03T06:00:00Z") },
        { kind: "interrupted", timestampMs: Date.parse("2026-08-04T07:00:00Z") },
      ],
      records: [createRecord("2026-08-03T01:00:00Z", "req-1")],
    });

    const rows = summarizeAbortMarkers([transcript]).rows;

    expect(rows.map((row) => row.utc_day)).toEqual(["2026-08-03", "2026-08-04"]);
    expect(rows[0]).toMatchObject({ api_error: 1, interrupted: 1, streaming_snapshot: 1 });
    expect(rows[1]).toMatchObject({ api_error: 0, interrupted: 1, occurrences: 0 });
  });
});

describe("summarizeSessionIntegrity", () => {
  test("reports the day's span and skips sessions with no calls that day", () => {
    const onDay = createTranscript({
      records: [
        createRecord("2026-08-03T09:30:00Z", "req-1"),
        createRecord("2026-08-03T21:45:10Z", "req-2"),
        createRecord("2026-08-04T09:00:00Z", "req-3"),
      ],
      sessionId: "anthropic:on-day",
    });
    const otherDay = createTranscript({
      records: [createRecord("2026-08-04T09:00:00Z", "req-4")],
      sessionId: "anthropic:other-day",
    });

    const rows = summarizeSessionIntegrity([onDay, otherDay], "2026-08-03").rows;

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      calls_on_day: 2,
      first_utc: "09:30:00",
      last_utc: "21:45:10",
      session: "anthropic:on-day",
    });
  });

  test("surfaces a broken uuid chain alongside intact sessions", () => {
    const intact = createTranscript({
      chain: { danglingParentCount: 0, rootCount: 1 },
      records: [createRecord("2026-08-03T08:00:00Z", "req-1")],
      sessionId: "anthropic:intact",
    });
    const broken = createTranscript({
      chain: { danglingParentCount: 3, rootCount: 2 },
      malformedLineCount: 1,
      records: [createRecord("2026-08-03T07:00:00Z", "req-2")],
      sessionId: "anthropic:broken",
    });

    const rows = summarizeSessionIntegrity([intact, broken], "2026-08-03").rows;

    expect(rows.map((row) => row.session)).toEqual(["anthropic:broken", "anthropic:intact"]);
    expect(rows[0]).toMatchObject({ dangling: 3, malformed: 1, roots: 2 });
  });
});

describe("summarizeCallsPerHour", () => {
  test("keeps every hour so an empty stretch stays visible", () => {
    const transcript = createTranscript({
      records: [
        createRecord("2026-08-03T00:10:00Z", "req-1"),
        createRecord("2026-08-03T00:50:00Z", "req-2"),
        createRecord("2026-08-03T23:00:00Z", "req-3"),
        createRecord("2026-08-04T00:10:00Z", "req-4"),
      ],
    });

    const table = summarizeCallsPerHour([transcript], "2026-08-03");

    expect(table.rows).toHaveLength(24);
    expect(table.rows[0]).toEqual({ calls: 2, utc_hour: "00" });
    expect(table.rows[12]).toEqual({ calls: 0, utc_hour: "12" });
    expect(table.rows[23]).toEqual({ calls: 1, utc_hour: "23" });
  });
});

describe("formatCsvTable", () => {
  test("writes cells in column order and quotes only what needs it", () => {
    const csv = formatCsvTable({
      columns: ["model", "calls"],
      rows: [{ calls: 2, model: 'claude,"opus"' }, { model: "sonnet" }],
    });

    expect(csv).toBe('model,calls\n"claude,""opus""",2\nsonnet,\n');
  });
});

function createTranscript(overrides: Partial<LoadedTranscript> = {}): LoadedTranscript {
  return {
    agentId: "main",
    chain: { danglingParentCount: 0, rootCount: 1 },
    malformedLineCount: 0,
    markers: [] as readonly TranscriptMarker[],
    path: "/transcripts/session.jsonl",
    records: [],
    sessionId: "anthropic:session",
    workspaceKey: "workspace",
    ...overrides,
  };
}

function createRecord(
  timestamp: string,
  providerRequestId: string | null,
  byteOffset = 0,
): ParsedUsageRecord {
  return {
    byteOffset,
    model: "claude-opus-4-8",
    providerRequestId,
    requestMetadata: null,
    stepUuid: null,
    timestampMs: Date.parse(timestamp),
    tokens: {
      cacheCreation: 0,
      cacheCreation1h: 0,
      cacheCreation5m: 0,
      cacheRead: 0,
      inputOther: 100,
      output: 10,
    },
  };
}
