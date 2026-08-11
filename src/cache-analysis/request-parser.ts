export interface KimiRequestMetadata {
  messageCount: number | null;
  requestedAtMs: number;
  systemPromptHash: string | null;
  toolsHash: string | null;
}

export interface ParsedRequestMetadata {
  malformedRelevantLineCount: number;
  requestsByUsageOffset: ReadonlyMap<number, KimiRequestMetadata>;
}

const textDecoder = new TextDecoder("utf-8", { fatal: true });

export function parseRequestMetadataByUsageOffset(
  bytes: Uint8Array,
  targetUsageOffsets: ReadonlySet<number>,
): ParsedRequestMetadata {
  const requestsByUsageOffset = new Map<number, KimiRequestMetadata>();
  let latestRequest: KimiRequestMetadata | null = null;
  let lineStart = 0;
  let malformedRelevantLineCount = 0;

  for (let index = 0; index < bytes.length; index += 1) {
    if (bytes[index] !== 0x0a) {
      continue;
    }

    const lineEnd = index > lineStart && bytes[index - 1] === 0x0d ? index - 1 : index;
    const lineBytes = bytes.subarray(lineStart, lineEnd);
    const usageOffset = lineStart;
    lineStart = index + 1;

    if (lineBytes.length === 0) {
      continue;
    }

    let line: string;
    try {
      line = textDecoder.decode(lineBytes);
    } catch {
      malformedRelevantLineCount += 1;
      continue;
    }

    if (!line.includes("llm.request") && !line.includes("usage.record")) {
      continue;
    }

    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch {
      malformedRelevantLineCount += 1;
      continue;
    }

    if (!isRecord(value)) {
      continue;
    }

    if (value.type === "llm.request") {
      latestRequest = parseRequestMetadata(value);
      continue;
    }

    if (value.type !== "usage.record" || value.usageScope !== "turn") {
      continue;
    }

    if (latestRequest !== null && targetUsageOffsets.has(usageOffset)) {
      requestsByUsageOffset.set(usageOffset, latestRequest);
    }
    latestRequest = null;
  }

  return { malformedRelevantLineCount, requestsByUsageOffset };
}

function parseRequestMetadata(value: Record<string, unknown>): KimiRequestMetadata | null {
  const requestedAtMs = parseTimestamp(value.time);
  if (requestedAtMs === null) {
    return null;
  }

  return {
    messageCount: optionalNonnegativeInteger(value.messageCount),
    requestedAtMs,
    systemPromptHash: optionalNonemptyString(value.systemPromptHash),
    toolsHash: optionalNonemptyString(value.toolsHash),
  };
}

function parseTimestamp(value: unknown): number | null {
  if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) {
    return value;
  }

  if (typeof value === "string") {
    const parsedTimestamp = Date.parse(value);
    return Number.isNaN(parsedTimestamp) ? null : parsedTimestamp;
  }

  return null;
}

function optionalNonnegativeInteger(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function optionalNonemptyString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
