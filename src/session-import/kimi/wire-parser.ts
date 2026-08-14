import type {
  ParsedUsageRecord,
  ParsedUsageChunk,
  RequestIdentityContext,
  UsageTokenCounts,
} from "../types";

const textDecoder = new TextDecoder("utf-8", { fatal: true });

export function parseWireChunk(
  bytes: Uint8Array,
  startingByteOffset: number,
  initialContext: RequestIdentityContext = {},
): ParsedUsageChunk {
  const records: ParsedUsageRecord[] = [];
  let context = { ...initialContext };
  let lineStart = 0;
  let completeByteLength = 0;
  let ignoredMalformedLineCount = 0;

  for (let index = 0; index < bytes.length; index += 1) {
    if (bytes[index] !== 0x0a) {
      continue;
    }

    const lineEnd = index > lineStart && bytes[index - 1] === 0x0d ? index - 1 : index;
    const lineBytes = bytes.subarray(lineStart, lineEnd);
    const lineByteOffset = startingByteOffset + lineStart;
    completeByteLength = index + 1;
    lineStart = index + 1;

    if (lineBytes.length === 0) {
      continue;
    }

    let line: string;
    try {
      line = textDecoder.decode(lineBytes);
    } catch {
      ignoredMalformedLineCount += 1;
      continue;
    }

    if (!line.includes("usage.record") && !line.includes("context.append_loop_event")) {
      continue;
    }

    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch {
      ignoredMalformedLineCount += 1;
      continue;
    }

    if (!isRecord(value)) {
      continue;
    }

    if (value.type === "context.append_loop_event") {
      const nextContext = parseStepEndContext(value.event);
      if (nextContext !== null) {
        context = nextContext;
      }
      continue;
    }

    if (value.type !== "usage.record" || value.usageScope !== "turn") {
      continue;
    }

    const usageRecord = parseUsageRecord(value, lineByteOffset, context);
    if (usageRecord !== null) {
      records.push(usageRecord);
      context = {};
    }
  }

  return {
    completeByteLength,
    context,
    ignoredMalformedLineCount,
    records,
  };
}

function parseStepEndContext(value: unknown): RequestIdentityContext | null {
  if (!isRecord(value) || value.type !== "step.end") {
    return null;
  }

  const providerRequestId = optionalNonemptyString(value.messageId);
  const stepUuid = optionalNonemptyString(value.uuid);
  const turnId = optionalStringOrNumber(value.turnId);
  const step = optionalStringOrNumber(value.step);
  const requestMetadata = turnId === null && step === null
    ? undefined
    : JSON.stringify({ step, turnId });

  return {
    ...(providerRequestId === null ? {} : { providerRequestId }),
    ...(requestMetadata === undefined ? {} : { requestMetadata }),
    ...(stepUuid === null ? {} : { stepUuid }),
  };
}

function parseUsageRecord(
  value: Record<string, unknown>,
  byteOffset: number,
  context: RequestIdentityContext,
): ParsedUsageRecord | null {
  const model = optionalNonemptyString(value.model);
  const timestampMs = parseTimestamp(value.time);
  const tokens = parseTokenCounts(value.usage);
  if (model === null || timestampMs === null || tokens === null || totalTokens(tokens) === 0) {
    return null;
  }

  return {
    byteOffset,
    model,
    providerRequestId: context.providerRequestId ?? null,
    requestMetadata: context.requestMetadata ?? null,
    stepUuid: context.stepUuid ?? null,
    timestampMs,
    tokens,
  };
}

function parseTokenCounts(value: unknown): UsageTokenCounts | null {
  if (!isRecord(value)) {
    return null;
  }

  const inputOther = parseTokenCount(value.inputOther);
  const cacheCreation = parseTokenCount(value.inputCacheCreation);
  const cacheRead = parseTokenCount(value.inputCacheRead);
  const output = parseTokenCount(value.output);
  if (inputOther === null || cacheCreation === null || cacheRead === null || output === null) {
    return null;
  }

  return {
    cacheCreation,
    cacheCreation1h: 0,
    cacheCreation5m: 0,
    cacheRead,
    inputOther,
    output,
  };
}

function parseTokenCount(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;
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

function totalTokens(tokens: UsageTokenCounts): number {
  return tokens.inputOther
    + tokens.cacheCreation
    + tokens.cacheCreation1h
    + tokens.cacheCreation5m
    + tokens.cacheRead
    + tokens.output;
}

function optionalNonemptyString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function optionalStringOrNumber(value: unknown): string | number | null {
  return typeof value === "string" || typeof value === "number" ? value : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
