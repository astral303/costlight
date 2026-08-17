import { stat } from "node:fs/promises";

const IDENTITY_SAMPLE_BYTES = 256 * 1_024;

export interface ClaudeAgentIdentity {
  key: string;
  label: string;
}

interface CachedIdentity {
  identity: ClaudeAgentIdentity;
  modifiedAtMs: number;
  size: number;
}

const identityCache = new Map<string, CachedIdentity>();

export async function readClaudeAgentIdentity(
  transcriptPath: string,
): Promise<ClaudeAgentIdentity> {
  try {
    const transcriptStat = await stat(transcriptPath);
    const cached = identityCache.get(transcriptPath);
    if (
      cached !== undefined
      && cached.modifiedAtMs === transcriptStat.mtimeMs
      && cached.size === transcriptStat.size
    ) {
      return cached.identity;
    }

    const content = await Bun.file(transcriptPath)
      .slice(0, Math.min(transcriptStat.size, IDENTITY_SAMPLE_BYTES))
      .text();
    const identity = parseClaudeAgentIdentity(content);
    identityCache.set(transcriptPath, {
      identity,
      modifiedAtMs: transcriptStat.mtimeMs,
      size: transcriptStat.size,
    });
    return identity;
  } catch (error) {
    throw new Error(`Unable to read Claude agent identity: ${transcriptPath}`, { cause: error });
  }
}

export function parseClaudeAgentIdentity(content: string): ClaudeAgentIdentity {
  let skillName: string | null = null;
  for (const line of content.split(/\r?\n/)) {
    const value = parseRecord(line);
    if (value === null) continue;

    const agentName = optionalName(value.attributionAgent);
    if (agentName !== null) {
      return { key: `agent:${agentName}`, label: agentName };
    }
    skillName ??= optionalName(value.attributionSkill);
  }

  return skillName === null
    ? otherSubagentIdentity()
    : { key: `skill:${skillName}`, label: `${skillName} (skill)` };
}

export function mainAgentIdentity(): ClaudeAgentIdentity {
  return { key: "main", label: "Main" };
}

function otherSubagentIdentity(): ClaudeAgentIdentity {
  return { key: "subagent", label: "Other subagent" };
}

function parseRecord(line: string): Record<string, unknown> | null {
  if (line.length === 0) return null;
  try {
    const value: unknown = JSON.parse(line);
    return typeof value === "object" && value !== null && !Array.isArray(value)
      ? value as Record<string, unknown>
      : null;
  } catch {
    return null;
  }
}

function optionalName(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length === 0 ? null : trimmed;
}
