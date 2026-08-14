export interface AgentMetadata {
  agentId: string;
  agentType: "main" | "sub" | "unknown";
  parentAgentId: string | null;
  sourceDirectory: string;
}

export interface DiscoveredSession {
  agentDirectories: ReadonlyMap<string, string>;
  provider: string;
  sessionDirectory: string;
  sessionId: string;
  sourceRoot: string;
  metadataSourcePath: string | null;
  usageFiles: readonly DiscoveredUsageFile[];
  workspaceKey: string;
}

export interface DiscoveredUsageFile {
  agentId: string;
  path: string;
}

export interface UsageTokenCounts {
  cacheCreation: number;
  cacheCreation1h: number;
  cacheCreation5m: number;
  cacheRead: number;
  inputOther: number;
  output: number;
}

export interface ParsedSessionState {
  agents: readonly AgentMetadata[];
  createdAtMs: number;
  title: string | null;
  updatedAtMs: number;
  workDirectory: string | null;
}

export interface ParsedUsageRecord {
  byteOffset: number;
  model: string;
  providerRequestId: string | null;
  requestMetadata: string | null;
  stepUuid: string | null;
  timestampMs: number;
  tokens: UsageTokenCounts;
}

export interface RequestIdentityContext {
  providerRequestId?: string;
  requestMetadata?: string;
  stepUuid?: string;
}

export interface ParsedUsageChunk {
  completeByteLength: number;
  context: RequestIdentityContext;
  ignoredMalformedLineCount: number;
  records: readonly ParsedUsageRecord[];
}

export interface ParsedSessionMetadataChunk {
  completeByteLength: number;
  state: ParsedSessionState;
}

export interface SessionStateParserDefaults {
  agentDirectories: ReadonlyMap<string, string>;
  fallbackTimestampMs: number;
}

export interface SessionImportProvider {
  createFallbackSessionState: (
    agentDirectories: ReadonlyMap<string, string>,
    timestampMs: number,
  ) => ParsedSessionState;
  discoverSessions: () => Promise<readonly DiscoveredSession[]>;
  isRelevantFile: (filePath: string) => boolean;
  parseSessionState: (
    content: string,
    defaults: SessionStateParserDefaults,
  ) => ParsedSessionState;
  parseSessionMetadataChunk?: (
    bytes: Uint8Array,
    previousState: ParsedSessionState | null,
    defaults: SessionStateParserDefaults,
  ) => ParsedSessionMetadataChunk;
  parseUsageChunk: (
    bytes: Uint8Array,
    startingByteOffset: number,
    initialContext: RequestIdentityContext,
  ) => ParsedUsageChunk;
  resolveWorkspaceKey?: (
    session: DiscoveredSession,
    state: ParsedSessionState,
  ) => string;
  sourceRoots: readonly string[];
  watchDirectories: readonly string[];
}
