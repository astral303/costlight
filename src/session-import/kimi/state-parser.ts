import type {
  AgentMetadata,
  ParsedSessionState,
  SessionStateParserDefaults,
} from "../types";

export function parseSessionState(
  content: string,
  defaults: SessionStateParserDefaults,
): ParsedSessionState {
  const value: unknown = JSON.parse(content);
  if (!isRecord(value)) {
    throw new Error("The Kimi state file must contain a JSON object.");
  }

  const agents = parseAgents(value.agents, defaults.agents);
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
  agents: readonly AgentMetadata[],
  timestampMs: number,
): ParsedSessionState {
  return {
    agents,
    createdAtMs: timestampMs,
    title: null,
    updatedAtMs: timestampMs,
    workDirectory: null,
  };
}

function parseAgents(
  value: unknown,
  discoveredAgents: readonly AgentMetadata[],
): readonly AgentMetadata[] {
  const discoveredById = new Map(discoveredAgents.map((agent) => [agent.agentId, agent]));
  const parsedAgents = new Map<string, AgentMetadata>();
  if (isRecord(value)) {
    for (const [agentId, rawAgent] of Object.entries(value)) {
      if (!isRecord(rawAgent)) {
        continue;
      }

      parsedAgents.set(agentId, {
        agentId,
        agentKey: discoveredById.get(agentId)?.agentKey ?? agentId,
        agentLabel: discoveredById.get(agentId)?.agentLabel
          ?? (agentId === "main" ? "Main" : agentId),
        agentType: parseAgentType(rawAgent.type),
        parentAgentId: optionalString(rawAgent.parentAgentId),
        sourceDirectory: discoveredById.get(agentId)?.sourceDirectory
          ?? optionalString(rawAgent.homedir)
          ?? "",
      });
    }
  }

  for (const discoveredAgent of discoveredAgents) {
    if (!parsedAgents.has(discoveredAgent.agentId)) {
      parsedAgents.set(discoveredAgent.agentId, discoveredAgent);
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
