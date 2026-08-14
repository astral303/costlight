export type BucketSize = "minute" | "hour" | "day" | "week";
export type TimeseriesResolution = BucketSize | "call";

export interface DashboardFilters {
  agentId?: string;
  agentType?: "main" | "sub" | "unknown";
  bucket: "auto" | BucketSize;
  fromMs?: number;
  model?: string;
  provider?: string;
  sessionId?: string;
  sessionSort: "cost" | "recent" | "start";
  timeZone: string;
  toMs?: number;
  workspace?: string;
}

export interface SummaryResponse {
  activeSessionCostNano: number;
  cacheHitRatio: number;
  cacheReadTokens: number;
  callCount: number;
  costTodayNano: number;
  inputTokens: number;
  outputTokens: number;
  replayExcludedCount: number;
  totalCostNano: number;
  unpricedCallCount: number;
}

export interface TimeseriesPoint {
  bucketStartMs: number;
  cacheCreationCostNano: number;
  cacheReadCostNano: number;
  callCount: number;
  cumulativeCacheCreationCostNano: number;
  cumulativeCacheReadCostNano: number;
  cumulativeInputCostNano: number;
  cumulativeOutputCostNano: number;
  cumulativeTotalCostNano: number;
  inputCostNano: number;
  outputCostNano: number;
  totalCostNano: number;
  unpricedCallCount: number;
}

export interface TimeseriesResponse {
  fromMs: number;
  points: readonly TimeseriesPoint[];
  resolution: TimeseriesResolution;
  timeZone: string;
  toMs: number;
}

export interface SessionRow {
  agentCount: number;
  callCount: number;
  createdAtMs: number;
  inheritedOccurrenceCount: number;
  lastCallAtMs: number;
  sessionId: string;
  title: string | null;
  totalCostNano: number;
  unpricedCallCount: number;
  workDirectory: string | null;
  workspaceKey: string;
}

export interface AgentRow {
  agentId: string;
  agentType: "main" | "sub" | "unknown";
  callCount: number;
  parentAgentId: string | null;
  totalCostNano: number;
  unpricedCallCount: number;
}

export interface ModelRow {
  cacheCreation1hUsdPerMillion: number | null;
  cacheCreation5mUsdPerMillion: number | null;
  cacheCreationUsdPerMillion: number | null;
  cacheReadUsdPerMillion: number | null;
  callCount: number;
  inputUsdPerMillion: number | null;
  outputUsdPerMillion: number | null;
  pricingBasis: string;
  pricingConfidence: string;
  rawModel: string;
  resolvedModelKey: string | null;
  totalCostNano: number;
  totalTokens: number;
  unpricedCallCount: number;
}

export interface FilterOption {
  label: string;
  value: string;
}

export interface SessionFilterOption extends FilterOption {
  provider: string;
  workspace: string;
}

export interface FilterOptionsResponse {
  agents: readonly FilterOption[];
  models: readonly FilterOption[];
  providers: readonly FilterOption[];
  sessions: readonly SessionFilterOption[];
  workspaces: readonly FilterOption[];
}
