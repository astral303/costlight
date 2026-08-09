import type { AgentMetadata, ParsedSessionState } from "./types";

interface StateParserDefaults {
  agentDirectories: ReadonlyMap<string, string>;
  fallbackTimestampMs: number;
}

export function parseSessionState(
  content: string,
  defaults: StateParserDefaults,
): ParsedSessionState {
  const value: unknown = JSON.parse(content);
  if (!isRecord(value)) {
    throw new Error("The Kimi state file must contain a JSON object.");
  }

  const agents = parseAgents(value.agents, defaults.agentDirectories);
  const createdAtMs = parseTimestamp(value.createdAt) ?? defaults.fallbackTimestampMs;
  const updatedAtMs = parseTimestamp(value.updatedAt) ?? createdAtMs;

  return {
    agents,
    createdAtMs,
    title: optionalString(value.title),
    updatedAtMs,
    workDirectory: optionalString(value.workDir),
  };
}

export function createFallbackSessionState(
  agentDirectories: ReadonlyMap<string, string>,
  timestampMs: number,
): ParsedSessionState {
  return {
    agents: [...agentDirectories].map(([agentId, sourceDirectory]) => ({
      agentId,
      agentType: agentId === "main" ? "main" : "unknown",
      parentAgentId: null,
      sourceDirectory,
    })),
    createdAtMs: timestampMs,
    title: null,
    updatedAtMs: timestampMs,
    workDirectory: null,
  };
}

function parseAgents(
  value: unknown,
  agentDirectories: ReadonlyMap<string, string>,
): readonly AgentMetadata[] {
  const parsedAgents = new Map<string, AgentMetadata>();
  if (isRecord(value)) {
    for (const [agentId, rawAgent] of Object.entries(value)) {
      if (!isRecord(rawAgent)) {
        continue;
      }

      parsedAgents.set(agentId, {
        agentId,
        agentType: parseAgentType(rawAgent.type),
        parentAgentId: optionalString(rawAgent.parentAgentId),
        sourceDirectory: agentDirectories.get(agentId) ?? optionalString(rawAgent.homedir) ?? "",
      });
    }
  }

  for (const [agentId, sourceDirectory] of agentDirectories) {
    if (!parsedAgents.has(agentId)) {
      parsedAgents.set(agentId, {
        agentId,
        agentType: agentId === "main" ? "main" : "unknown",
        parentAgentId: null,
        sourceDirectory,
      });
    }
  }

  return [...parsedAgents.values()];
}

function parseAgentType(value: unknown): AgentMetadata["agentType"] {
  return value === "main" || value === "sub" ? value : "unknown";
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

function optionalString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
