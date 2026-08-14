import { basename, join } from "node:path";
import { discoverKimiSessions } from "./discovery";
import { createFallbackSessionState, parseSessionState } from "./state-parser";
import type { SessionImportProvider } from "../types";
import { parseWireChunk } from "./wire-parser";

export function createKimiImportProvider(
  sourceRoots: readonly string[],
): SessionImportProvider {
  return {
    createFallbackSessionState,
    discoverSessions: () => discoverKimiSessions(sourceRoots),
    isRelevantFile: (filePath) => {
      const fileName = basename(filePath);
      return fileName === "state.json" || fileName === "wire.jsonl";
    },
    parseSessionState,
    parseUsageChunk: parseWireChunk,
    sourceRoots,
    watchDirectories: sourceRoots.map((root) => join(root, "sessions")),
  };
}
