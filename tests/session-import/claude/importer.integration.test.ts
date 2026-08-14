import { afterEach, describe, expect, test } from "bun:test";
import { appendFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDashboardDatabase } from "../../../src/app/database";
import { CallLedger } from "../../../src/call-accounting/ledger";
import { queryModels, querySummary } from "../../../src/dashboard/queries";
import { PricingCatalog } from "../../../src/pricing/catalog";
import { createClaudeImportProvider } from "../../../src/session-import/claude/provider";
import { SessionImporter } from "../../../src/session-import/importer";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) => (
      rm(directory, { force: true, recursive: true })
    )),
  );
});

describe("Claude session import", () => {
  test("imports main and subagent calls idempotently with final usage", async () => {
    const fixture = await createClaudeFixture();
    const root = fixture.root;
    const database = openDashboardDatabase(":memory:");
    try {
      const catalog = new PricingCatalog(database, join(root, "costlight-data"));
      await catalog.initialize();
      const ledger = new CallLedger(database, catalog);
      const importer = new SessionImporter(database, [
        createClaudeImportProvider([root]),
      ], ledger);

      const firstImport = await importer.reconcile();

      expect(firstImport).toMatchObject({
        discoveredSessionCount: 1,
        discoveredSourceCount: 2,
        insertedOccurrenceCount: 3,
        malformedLineCount: 0,
        sourceErrorCount: 0,
      });
      expect(database.query<{
        provider: string;
        title: string;
        workspace_key: string;
      }, []>(`
        SELECT provider, title, workspace_key FROM sessions
      `).get()).toEqual({
        provider: "anthropic",
        title: "Synthetic Claude session",
        workspace_key: "project",
      });
      expect(database.query<{
        agent_type: string;
        parent_agent_id: string;
      }, []>(`
        SELECT agent_type, parent_agent_id FROM agents WHERE agent_id = 'test'
      `).get()).toEqual({ agent_type: "sub", parent_agent_id: "main" });
      expect(database.query<{
        output_tokens: number;
        total_cost_nano: number;
      }, []>(`
        SELECT output_tokens, total_cost_nano FROM api_calls WHERE agent_id = 'main'
      `).get()).toEqual({ output_tokens: 20, total_cost_nano: 1_990_000 });
      expect(database.query<{ count: number }, []>(`
        SELECT COUNT(*) AS count FROM api_calls
      `).get()?.count).toBe(2);
      expect(database.query<{ count: number }, []>(`
        SELECT COUNT(*) AS count
        FROM usage_occurrences
        WHERE replay_classification = 'superseded-usage'
      `).get()?.count).toBe(1);
      expect(querySummary(database, dashboardFilters).replayExcludedCount).toBe(0);
      expect(querySummary(database, {
        ...dashboardFilters,
        provider: "moonshotai",
      }).callCount).toBe(0);
      expect(queryModels(database, dashboardFilters)[0]).toMatchObject({
        cacheCreation1hUsdPerMillion: 20,
        cacheCreation5mUsdPerMillion: 12.5,
        cacheReadUsdPerMillion: 1,
        inputUsdPerMillion: 10,
        outputUsdPerMillion: 50,
        rawModel: "claude-fable-5",
      });

      const unchangedImport = await importer.reconcile();
      expect(unchangedImport.insertedOccurrenceCount).toBe(0);
      expect(unchangedImport.sourceDataBytesRead).toBe(0);

      const titleLine = `${JSON.stringify({
        aiTitle: "Updated Claude session",
        sessionId: fixture.sessionId,
        type: "ai-title",
      })}\n`;
      await appendFile(fixture.mainTranscriptPath, titleLine, "utf8");
      const appendedImport = await importer.reconcile();
      expect(appendedImport.sourceDataBytesRead).toBe(Buffer.byteLength(titleLine));
      expect(database.query<{ title: string }, []>(`
        SELECT title FROM sessions
      `).get()?.title).toBe("Updated Claude session");

      const partialTitle = JSON.stringify({
        aiTitle: "Completed partial title",
        sessionId: fixture.sessionId,
        type: "ai-title",
      });
      await appendFile(fixture.mainTranscriptPath, partialTitle, "utf8");
      await importer.reconcile();
      expect(database.query<{ title: string }, []>(`
        SELECT title FROM sessions
      `).get()?.title).toBe("Updated Claude session");
      await appendFile(fixture.mainTranscriptPath, "\n", "utf8");
      await importer.reconcile();
      expect(database.query<{ title: string }, []>(`
        SELECT title FROM sessions
      `).get()?.title).toBe("Completed partial title");
    } finally {
      database.close();
    }
  });
});

const dashboardFilters = {
  bucket: "auto" as const,
  sessionSort: "cost" as const,
  timeZone: "UTC",
};

async function createClaudeFixture() {
  const root = await mkdtemp(join(tmpdir(), "costlight-claude-test-"));
  temporaryDirectories.push(root);
  const projectDirectory = join(root, "projects", "C--work-project");
  const sessionId = "11111111-1111-4111-8111-111111111111";
  const subagentsDirectory = join(projectDirectory, sessionId, "subagents");
  await mkdir(subagentsDirectory, { recursive: true });
  const mainTranscriptPath = join(projectDirectory, `${sessionId}.jsonl`);
  await writeFile(mainTranscriptPath, [
    JSON.stringify({
      cwd: "C:\\work\\project",
      sessionId,
      timestamp: "2026-07-26T11:55:00.000Z",
      type: "user",
    }),
    JSON.stringify({ aiTitle: "Synthetic Claude session", sessionId, type: "ai-title" }),
    assistantLine({ output: 10, requestId: "main-request", sessionId }),
    assistantLine({ output: 20, requestId: "main-request", sessionId }),
  ].join("\n") + "\n", "utf8");
  await writeFile(join(subagentsDirectory, "agent-test.jsonl"), [
    assistantLine({
      cacheCreation1h: 0,
      cacheCreation5m: 0,
      cacheRead: 1,
      input: 1,
      output: 1,
      requestId: "subagent-request",
      sessionId,
    }),
  ].join("\n") + "\n", "utf8");
  return { mainTranscriptPath, root, sessionId };
}

interface AssistantLineOptions {
  cacheCreation1h?: number;
  cacheCreation5m?: number;
  cacheRead?: number;
  input?: number;
  output: number;
  requestId: string;
  sessionId: string;
}

function assistantLine(options: AssistantLineOptions): string {
  const cacheCreation1h = options.cacheCreation1h ?? 30;
  const cacheCreation5m = options.cacheCreation5m ?? 20;
  return JSON.stringify({
    cwd: "C:\\work\\project",
    message: {
      content: [],
      id: `message-${options.requestId}`,
      model: "claude-fable-5",
      role: "assistant",
      type: "message",
      usage: {
        cache_creation: {
          ephemeral_1h_input_tokens: cacheCreation1h,
          ephemeral_5m_input_tokens: cacheCreation5m,
        },
        cache_creation_input_tokens: cacheCreation1h + cacheCreation5m,
        cache_read_input_tokens: options.cacheRead ?? 40,
        input_tokens: options.input ?? 10,
        output_tokens: options.output,
      },
    },
    requestId: options.requestId,
    sessionId: options.sessionId,
    timestamp: "2026-07-26T12:00:00.000Z",
    type: "assistant",
    uuid: `event-${options.requestId}-${options.output}`,
  });
}
