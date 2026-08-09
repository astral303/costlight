export interface AgentMetadata {
  agentId: string;
  agentType: "main" | "sub" | "unknown";
  parentAgentId: string | null;
  sourceDirectory: string;
}

export interface DiscoveredSession {
  agentDirectories: ReadonlyMap<string, string>;
  sessionDirectory: string;
  sessionId: string;
  sourceRoot: string;
  stateFilePath: string | null;
  wireFiles: readonly DiscoveredWireFile[];
  workspaceKey: string;
}

export interface DiscoveredWireFile {
  agentId: string;
  path: string;
}

export interface KimiTokenCounts {
  cacheCreation: number;
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
  tokens: KimiTokenCounts;
}

export interface RequestIdentityContext {
  providerRequestId?: string;
  requestMetadata?: string;
  stepUuid?: string;
}

export interface ParsedWireChunk {
  completeByteLength: number;
  context: RequestIdentityContext;
  ignoredMalformedLineCount: number;
  records: readonly ParsedUsageRecord[];
}
