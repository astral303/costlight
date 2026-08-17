import type { Dirent } from "node:fs";
import { readdir } from "node:fs/promises";
import { basename, dirname, extname, join, resolve } from "node:path";
import type { DiscoveredSession, DiscoveredUsageFile } from "../types";
import {
  mainAgentIdentity,
  readClaudeAgentIdentity,
} from "./agent-identity";

const CLAUDE_SESSION_PREFIX = "anthropic:";

export async function discoverClaudeSessions(
  sourceRoots: readonly string[],
): Promise<readonly DiscoveredSession[]> {
  const sessions: DiscoveredSession[] = [];

  for (const sourceRoot of sourceRoots) {
    const projectsDirectory = join(sourceRoot, "projects");
    for (const projectDirectoryEntry of await readDirectories(projectsDirectory)) {
      const projectDirectory = join(projectsDirectory, projectDirectoryEntry.name);
      for (const transcriptEntry of await readJsonlFiles(projectDirectory)) {
        const rawSessionId = basename(transcriptEntry.name, ".jsonl");
        const mainTranscriptPath = resolve(projectDirectory, transcriptEntry.name);
        const usageFiles = await discoverUsageFiles(
          projectDirectory,
          rawSessionId,
          mainTranscriptPath,
        );
        const agents = await Promise.all(usageFiles.map(async (usageFile) => {
          const identity = usageFile.agentId === "main"
            ? mainAgentIdentity()
            : await readClaudeAgentIdentity(usageFile.path);
          return {
            agentId: usageFile.agentId,
            agentKey: identity.key,
            agentLabel: identity.label,
            agentType: usageFile.agentId === "main" ? "main" as const : "sub" as const,
            parentAgentId: usageFile.agentId === "main" ? null : "main",
            sourceDirectory: dirname(usageFile.path),
          };
        }));

        sessions.push({
          agents,
          provider: "anthropic",
          sessionDirectory: resolve(projectDirectory, rawSessionId),
          sessionId: `${CLAUDE_SESSION_PREFIX}${rawSessionId}`,
          sourceRoot: resolve(sourceRoot),
          metadataSourcePath: mainTranscriptPath,
          usageFiles,
          workspaceKey: projectDirectoryEntry.name,
        });
      }
    }
  }

  return sessions.sort((left, right) => (
    left.sessionDirectory.localeCompare(right.sessionDirectory)
  ));
}

async function discoverUsageFiles(
  projectDirectory: string,
  rawSessionId: string,
  mainTranscriptPath: string,
): Promise<readonly DiscoveredUsageFile[]> {
  const usageFiles: DiscoveredUsageFile[] = [
    { agentId: "main", path: mainTranscriptPath },
  ];
  const subagentsDirectory = join(projectDirectory, rawSessionId, "subagents");
  for (const subagentTranscript of await readJsonlFiles(subagentsDirectory)) {
    usageFiles.push({
      agentId: parseSubagentId(subagentTranscript.name),
      path: resolve(subagentsDirectory, subagentTranscript.name),
    });
  }
  return usageFiles.sort((left, right) => left.path.localeCompare(right.path));
}

function parseSubagentId(fileName: string): string {
  const transcriptName = basename(fileName, ".jsonl");
  return transcriptName.startsWith("agent-")
    ? transcriptName.slice("agent-".length)
    : transcriptName;
}

async function readDirectories(directoryPath: string): Promise<readonly Dirent[]> {
  return readEntries(directoryPath, (entry) => entry.isDirectory());
}

async function readJsonlFiles(directoryPath: string): Promise<readonly Dirent[]> {
  return readEntries(
    directoryPath,
    (entry) => entry.isFile() && extname(entry.name).toLowerCase() === ".jsonl",
  );
}

async function readEntries(
  directoryPath: string,
  predicate: (entry: Dirent) => boolean,
): Promise<readonly Dirent[]> {
  try {
    const entries = await readdir(directoryPath, { withFileTypes: true });
    return entries.filter((entry) => !entry.isSymbolicLink() && predicate(entry));
  } catch (error) {
    if (isMissingPathError(error)) {
      return [];
    }
    throw new Error(`Unable to inspect Claude directory: ${directoryPath}`, { cause: error });
  }
}

function isMissingPathError(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}
