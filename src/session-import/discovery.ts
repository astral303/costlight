import { readdir } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import type { Dirent } from "node:fs";
import type { DiscoveredSession, DiscoveredWireFile } from "./types";

export async function discoverKimiSessions(
  sourceRoots: readonly string[],
): Promise<readonly DiscoveredSession[]> {
  const discoveredSessions: DiscoveredSession[] = [];

  for (const sourceRoot of sourceRoots) {
    const sessionsDirectory = join(sourceRoot, "sessions");
    for (const workspaceDirectory of await readDirectories(sessionsDirectory)) {
      for (const sessionDirectoryEntry of await readDirectories(join(sessionsDirectory, workspaceDirectory.name))) {
        const sessionDirectory = join(sessionsDirectory, workspaceDirectory.name, sessionDirectoryEntry.name);
        const wireFiles = await discoverWireFiles(sessionDirectory);
        const stateFilePath = await containsFile(sessionDirectory, "state.json")
          ? join(sessionDirectory, "state.json")
          : null;
        if (wireFiles.length === 0 && stateFilePath === null) {
          continue;
        }

        const agentDirectories = new Map<string, string>();
        for (const wireFile of wireFiles) {
          agentDirectories.set(wireFile.agentId, dirname(wireFile.path));
        }

        discoveredSessions.push({
          agentDirectories,
          sessionDirectory: resolve(sessionDirectory),
          sessionId: sessionDirectoryEntry.name,
          sourceRoot: resolve(sourceRoot),
          stateFilePath: stateFilePath === null ? null : resolve(stateFilePath),
          wireFiles,
          workspaceKey: workspaceDirectory.name,
        });
      }
    }
  }

  return discoveredSessions.sort((left, right) => left.sessionDirectory.localeCompare(right.sessionDirectory));
}

async function discoverWireFiles(sessionDirectory: string): Promise<readonly DiscoveredWireFile[]> {
  const wireFiles: DiscoveredWireFile[] = [];
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
