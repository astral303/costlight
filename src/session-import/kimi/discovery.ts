import { readdir } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import type { Dirent } from "node:fs";
import type { DiscoveredSession, DiscoveredUsageFile } from "../types";

export async function discoverKimiSessions(
  sourceRoots: readonly string[],
): Promise<readonly DiscoveredSession[]> {
  const discoveredSessions: DiscoveredSession[] = [];

  for (const sourceRoot of sourceRoots) {
    const sessionsDirectory = join(sourceRoot, "sessions");
    for (const workspaceDirectory of await readDirectories(sessionsDirectory)) {
      for (const sessionDirectoryEntry of await readDirectories(join(sessionsDirectory, workspaceDirectory.name))) {
        const sessionDirectory = join(sessionsDirectory, workspaceDirectory.name, sessionDirectoryEntry.name);
        const usageFiles = await discoverWireFiles(sessionDirectory);
        const metadataSourcePath = await containsFile(sessionDirectory, "state.json")
          ? join(sessionDirectory, "state.json")
          : null;
        if (usageFiles.length === 0 && metadataSourcePath === null) {
          continue;
        }

        const agents = usageFiles.map((wireFile) => ({
          agentId: wireFile.agentId,
          agentKey: wireFile.agentId,
          agentLabel: wireFile.agentId === "main" ? "Main" : wireFile.agentId,
          agentType: wireFile.agentId === "main" ? "main" as const : "unknown" as const,
          parentAgentId: null,
          sourceDirectory: dirname(wireFile.path),
        }));

        discoveredSessions.push({
          agents,
          provider: "moonshotai",
          sessionDirectory: resolve(sessionDirectory),
          sessionId: sessionDirectoryEntry.name,
          sourceRoot: resolve(sourceRoot),
          metadataSourcePath: metadataSourcePath === null ? null : resolve(metadataSourcePath),
          usageFiles,
          workspaceKey: workspaceDirectory.name,
        });
      }
    }
  }

  return discoveredSessions.sort((left, right) => left.sessionDirectory.localeCompare(right.sessionDirectory));
}

async function discoverWireFiles(sessionDirectory: string): Promise<readonly DiscoveredUsageFile[]> {
  const wireFiles: DiscoveredUsageFile[] = [];
  const legacyWirePath = join(sessionDirectory, "wire.jsonl");
  if (await containsFile(sessionDirectory, "wire.jsonl")) {
    wireFiles.push({ agentId: "main", path: resolve(legacyWirePath) });
  }

  const agentsDirectory = join(sessionDirectory, "agents");
  for (const agentDirectory of await readDirectories(agentsDirectory)) {
    if (await containsFile(join(agentsDirectory, agentDirectory.name), "wire.jsonl")) {
      wireFiles.push({
        agentId: agentDirectory.name,
        path: resolve(join(agentsDirectory, agentDirectory.name, "wire.jsonl")),
      });
    }
  }

  return wireFiles.sort((left, right) => left.path.localeCompare(right.path));
}

async function readDirectories(directoryPath: string): Promise<readonly Dirent[]> {
  try {
    const entries = await readdir(directoryPath, { withFileTypes: true });
    return entries.filter((entry) => entry.isDirectory() && !entry.isSymbolicLink());
  } catch (error) {
    if (isMissingPathError(error)) {
      return [];
    }
    throw new Error(`Unable to read Kimi directory: ${directoryPath}`, { cause: error });
  }
}

async function containsFile(directoryPath: string, fileName: string): Promise<boolean> {
  try {
    const entries = await readdir(directoryPath, { withFileTypes: true });
    return entries.some((entry) => entry.name === fileName && entry.isFile() && !entry.isSymbolicLink());
  } catch (error) {
    if (isMissingPathError(error)) {
      return false;
    }
    throw new Error(`Unable to inspect Kimi directory: ${directoryPath}`, { cause: error });
  }
}

function isMissingPathError(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}
