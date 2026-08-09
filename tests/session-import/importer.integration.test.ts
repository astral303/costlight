import { afterEach, describe, expect, test } from "bun:test";
import { appendFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDashboardDatabase } from "../../src/app/database";
import { SessionImporter } from "../../src/session-import/importer";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) => rm(directory, { force: true, recursive: true })),
  );
});

describe("SessionImporter", () => {
  test("resumes at complete newlines and reparses a truncated source", async () => {
    const fixtureRoot = await createFixtureRoot();
    const database = openDashboardDatabase(":memory:");
    try {
      const importer = new SessionImporter(database, [fixtureRoot.root]);

      const firstImport = await importer.reconcile();
      expect(firstImport.insertedOccurrenceCount).toBe(1);
      expect(countRows(database, "usage_occurrences")).toBe(1);

      await appendFile(fixtureRoot.wirePath, "\n", "utf8");
      const appendImport = await importer.reconcile();
      expect(appendImport.insertedOccurrenceCount).toBe(1);
      expect(countRows(database, "usage_occurrences")).toBe(2);

      const unchangedImport = await importer.reconcile();
      expect(unchangedImport.insertedOccurrenceCount).toBe(0);

      await Promise.all([
        appendFile(fixtureRoot.wirePath, `${usagePair("concurrent-a", 30)}\n`, "utf8"),
        appendFile(fixtureRoot.wirePath, `${usagePair("concurrent-b", 40)}\n`, "utf8"),
      ]);
      const concurrentImport = await importer.reconcile();
      expect(concurrentImport.insertedOccurrenceCount).toBe(2);
      expect(countRows(database, "usage_occurrences")).toBe(4);

      await writeFile(fixtureRoot.wirePath, `${usagePair("replacement", 50)}\n`, "utf8");
      const rewriteImport = await importer.reconcile();
      expect(rewriteImport.rewrittenSourceCount).toBe(1);
      expect(countRows(database, "usage_occurrences")).toBe(1);
      expect(countRows(database, "api_calls")).toBe(1);
    } finally {
      database.close();
    }
  });

  test("discovers a new subagent and removes its call after its source disappears", async () => {
    const fixtureRoot = await createFixtureRoot();
    const database = openDashboardDatabase(":memory:");
    try {
      const importer = new SessionImporter(database, [fixtureRoot.root]);
      await importer.reconcile();
      const subagentDirectory = join(fixtureRoot.sessionDirectory, "agents", "agent-0");
      await mkdir(subagentDirectory, { recursive: true });
      const subagentWirePath = join(subagentDirectory, "wire.jsonl");
      await writeFile(subagentWirePath, `${usagePair("subagent-call", 25)}\n`, "utf8");
      await writeFile(fixtureRoot.statePath, JSON.stringify({
        agents: {
          main: {
            homedir: join(fixtureRoot.sessionDirectory, "agents", "main"),
            parentAgentId: null,
            type: "main",
          },
          "agent-0": {
            homedir: subagentDirectory,
            parentAgentId: "main",
            type: "sub",
          },
        },
        createdAt: 100,
        updatedAt: 300,
      }), "utf8");

      const subagentImport = await importer.reconcile();
      expect(subagentImport.insertedOccurrenceCount).toBe(1);
      expect(database.query<{ agent_type: string; parent_agent_id: string | null }, []>(`
        SELECT agent_type, parent_agent_id FROM agents WHERE agent_id = 'agent-0'
      `).get()).toEqual({ agent_type: "sub", parent_agent_id: "main" });

      await rm(subagentWirePath);
      const removalImport = await importer.reconcile();
      expect(removalImport.removedOccurrenceCount).toBe(1);
      expect(database.query<{ count: number }, []>(`
        SELECT COUNT(*) AS count FROM source_files WHERE agent_id = 'agent-0'
      `).get()?.count).toBe(0);
    } finally {
      database.close();
    }
  });
});

async function createFixtureRoot() {
  const root = await mkdtemp(join(tmpdir(), "kimi-cost-dashboard-test-"));
  temporaryDirectories.push(root);
  const sessionDirectory = join(root, "sessions", "workspace", "session-1");
  const agentDirectory = join(sessionDirectory, "agents", "main");
  await mkdir(agentDirectory, { recursive: true });
  await writeFile(join(sessionDirectory, "state.json"), JSON.stringify({
    agents: { main: { homedir: agentDirectory, parentAgentId: null, type: "main" } },
    createdAt: 100,
    title: "Synthetic session",
    updatedAt: 200,
    workDir: join(root, "workspace"),
  }), "utf8");

  const wirePath = join(agentDirectory, "wire.jsonl");
  const statePath = join(sessionDirectory, "state.json");
  await writeFile(
    wirePath,
    `${usagePair("complete", 10)}\n${usagePair("partial", 20)}`,
    "utf8",
  );
  return { root, sessionDirectory, statePath, wirePath };
}

function usagePair(requestId: string, inputTokens: number): string {
  return [
    JSON.stringify({
      event: { messageId: requestId, type: "step.end", uuid: `${requestId}-step` },
      time: 1_785_585_600_000,
      type: "context.append_loop_event",
    }),
    JSON.stringify({
      model: "moonshot-ai/kimi-k3",
      time: 1_785_585_600_000,
      type: "usage.record",
      usage: {
        inputCacheCreation: 0,
        inputCacheRead: 0,
        inputOther: inputTokens,
        output: 1,
      },
      usageScope: "turn",
    }),
  ].join("\n");
}

function countRows(database: ReturnType<typeof openDashboardDatabase>, tableName: string): number {
  const allowedTables = new Set(["api_calls", "usage_occurrences"]);
  if (!allowedTables.has(tableName)) {
    throw new Error(`Unexpected table: ${tableName}`);
  }
  return database.query<{ count: number }, []>(`SELECT COUNT(*) AS count FROM ${tableName}`).get()?.count ?? 0;
}
