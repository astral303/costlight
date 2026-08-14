import type {
  AgentMetadata,
  ParsedSessionMetadataChunk,
  ParsedSessionState,
  ParsedUsageChunk,
  ParsedUsageRecord,
  RequestIdentityContext,
  SessionStateParserDefaults,
  UsageTokenCounts,
} from "../types";

const textDecoder = new TextDecoder("utf-8", { fatal: true });

export function parseClaudeSessionState(
  content: string,
  defaults: SessionStateParserDefaults,
): ParsedSessionState {
  return mergeClaudeSessionMetadata(content, null, defaults);
}

export function parseClaudeSessionMetadataChunk(
  bytes: Uint8Array,
  previousState: ParsedSessionState | null,
  defaults: SessionStateParserDefaults,
): ParsedSessionMetadataChunk {
  const completeByteLength = lastCompleteLineLength(bytes);
  const content = textDecoder.decode(bytes.subarray(0, completeByteLength));
  return {
    completeByteLength,
    state: mergeClaudeSessionMetadata(content, previousState, defaults),
  };
}

function mergeClaudeSessionMetadata(
  content: string,
  previousState: ParsedSessionState | null,
  defaults: SessionStateParserDefaults,
): ParsedSessionState {
  let createdAtMs = previousState?.createdAtMs ?? defaults.fallbackTimestampMs;
  let hasTimestamp = previousState !== null;
  let title = previousState?.title ?? null;
  let updatedAtMs = previousState?.updatedAtMs ?? defaults.fallbackTimestampMs;
  let workDirectory = previousState?.workDirectory ?? null;

  for (const line of content.split(/\r?\n/)) {
    if (line.length === 0) {
      continue;
    }
    const value = parseJsonRecord(line);
    if (value === null) {
      continue;
    }
    if (value.type === "ai-title") {
      title = optionalNonemptyString(value.aiTitle) ?? title;
    }
    const timestampMs = parseTimestamp(value.timestamp);
    if (timestampMs !== null) {
      createdAtMs = hasTimestamp ? Math.min(createdAtMs, timestampMs) : timestampMs;
      updatedAtMs = hasTimestamp ? Math.max(updatedAtMs, timestampMs) : timestampMs;
      hasTimestamp = true;
    }
    workDirectory = optionalNonemptyString(value.cwd) ?? workDirectory;
  }

  return {
    agents: createClaudeAgents(defaults.agentDirectories),
    createdAtMs,
    title,
    updatedAtMs,
    workDirectory,
  };
}

function lastCompleteLineLength(bytes: Uint8Array): number {
  for (let index = bytes.length - 1; index >= 0; index -= 1) {
    if (bytes[index] === 0x0a) return index + 1;
  }
  return 0;
}

export function createFallbackClaudeSessionState(
  agentDirectories: ReadonlyMap<string, string>,
  timestampMs: number,
): ParsedSessionState {
  return {
    agents: createClaudeAgents(agentDirectories),
    createdAtMs: timestampMs,
    title: null,
    updatedAtMs: timestampMs,
    workDirectory: null,
  };
}

export function parseClaudeTranscriptChunk(
  bytes: Uint8Array,
  startingByteOffset: number,
  initialContext: RequestIdentityContext = {},
): ParsedUsageChunk {
  const records: ParsedUsageRecord[] = [];
  let lineStart = 0;
  let completeByteLength = 0;
  let ignoredMalformedLineCount = 0;

  for (let index = 0; index < bytes.length; index += 1) {
    if (bytes[index] !== 0x0a) {
      continue;
    }
    const lineEnd = index > lineStart && bytes[index - 1] === 0x0d ? index - 1 : index;
    const lineBytes = bytes.subarray(lineStart, lineEnd);
    const byteOffset = startingByteOffset + lineStart;
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
    if (!line.includes('"assistant"') || !line.includes('"usage"')) {
      continue;
    }
    const value = parseJsonRecord(line);
    if (value === null) {
      ignoredMalformedLineCount += 1;
      continue;
    }
    const usageRecord = parseUsageRecord(value, byteOffset);
    if (usageRecord !== null) {
      records.push(usageRecord);
    }
  }

  return {
    completeByteLength,
    context: initialContext,
    ignoredMalformedLineCount,
    records,
  };
}

function parseUsageRecord(
  value: Record<string, unknown>,
  byteOffset: number,
): ParsedUsageRecord | null {
  if (value.type !== "assistant" || !isRecord(value.message)) {
    return null;
  }
  const model = optionalNonemptyString(value.message.model);
  const timestampMs = parseTimestamp(value.timestamp);
  const tokens = parseTokenCounts(value.message.usage);
  if (
    model === null
    || model === "<synthetic>"
    || timestampMs === null
    || tokens === null
    || totalTokens(tokens) === 0
  ) {
    return null;
  }
  const messageId = optionalNonemptyString(value.message.id);
  return {
    byteOffset,
    model,
    providerRequestId: optionalNonemptyString(value.requestId) ?? messageId,
    requestMetadata: messageId,
    stepUuid: optionalNonemptyString(value.uuid),
    timestampMs,
    tokens,
  };
}

function parseTokenCounts(value: unknown): UsageTokenCounts | null {
  if (!isRecord(value)) {
    return null;
  }
  const inputOther = parseTokenCount(value.input_tokens);
  const cacheCreationTotal = parseTokenCount(value.cache_creation_input_tokens);
  const cacheRead = parseTokenCount(value.cache_read_input_tokens);
  const output = parseTokenCount(value.output_tokens);
  if (
    inputOther === null
    || cacheCreationTotal === null
    || cacheRead === null
    || output === null
  ) {
    return null;
  }
  const cacheCreation = isRecord(value.cache_creation) ? value.cache_creation : {};
  const cacheCreation1h = parseOptionalTokenCount(
    cacheCreation.ephemeral_1h_input_tokens,
  );
  const cacheCreation5m = parseOptionalTokenCount(
    cacheCreation.ephemeral_5m_input_tokens,
  );
  if (
    cacheCreation1h === null
    || cacheCreation5m === null
    || cacheCreation1h + cacheCreation5m > cacheCreationTotal
  ) {
    return null;
  }
  return {
    cacheCreation: cacheCreationTotal - cacheCreation1h - cacheCreation5m,
    cacheCreation1h,
    cacheCreation5m,
    cacheRead,
    inputOther,
    output,
  };
}

function createClaudeAgents(
  agentDirectories: ReadonlyMap<string, string>,
): readonly AgentMetadata[] {
  return [...agentDirectories].map(([agentId, sourceDirectory]) => ({
    agentId,
    agentType: agentId === "main" ? "main" : "sub",
    parentAgentId: agentId === "main" ? null : "main",
    sourceDirectory,
  }));
}

function parseJsonRecord(line: string): Record<string, unknown> | null {
  try {
    const value: unknown = JSON.parse(line);
    return isRecord(value) ? value : null;
  } catch {
    return null;
  }
}

function parseOptionalTokenCount(value: unknown): number | null {
  return value === undefined ? 0 : parseTokenCount(value);
}

function parseTokenCount(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
    ? value
    : null;
}

function parseTimestamp(value: unknown): number | null {
  if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) {
    return value;
  }
  if (typeof value !== "string") {
    return null;
  }
  const timestampMs = Date.parse(value);
  return Number.isNaN(timestampMs) ? null : timestampMs;
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
