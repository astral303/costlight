import { basename, extname, join } from "node:path";
import type { SessionImportProvider } from "../types";
import { discoverClaudeSessions } from "./discovery";
import {
  createFallbackClaudeSessionState,
  parseClaudeSessionMetadataChunk,
  parseClaudeSessionState,
  parseClaudeTranscriptChunk,
} from "./parser";

export function createClaudeImportProvider(
  sourceRoots: readonly string[],
): SessionImportProvider {
  return {
    createFallbackSessionState: createFallbackClaudeSessionState,
    discoverSessions: () => discoverClaudeSessions(sourceRoots),
    isRelevantFile: (filePath) => extname(filePath).toLowerCase() === ".jsonl",
    parseSessionState: parseClaudeSessionState,
    parseSessionMetadataChunk: parseClaudeSessionMetadataChunk,
    parseUsageChunk: parseClaudeTranscriptChunk,
    resolveWorkspaceKey: (session, state) => (
      state.workDirectory === null ? session.workspaceKey : basename(state.workDirectory)
    ),
    sourceRoots,
    watchDirectories: sourceRoots.map((root) => join(root, "projects")),
  };
}
