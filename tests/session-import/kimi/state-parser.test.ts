import { describe, expect, test } from "bun:test";
import { parseSessionState } from "../../../src/session-import/kimi/state-parser";

describe("parseSessionState", () => {
  test("extracts only session and agent attribution metadata", async () => {
    const fixture = await Bun.file(
      new URL("./fixtures/state-main-sub.json", import.meta.url),
    ).text();
    const parsed = parseSessionState(fixture, {
      agentDirectories: new Map([
        ["main", "C:\\live\\agents\\main"],
        ["agent-0", "C:\\live\\agents\\agent-0"],
      ]),
      fallbackTimestampMs: 0,
    });

    expect(parsed.createdAtMs).toBe(Date.parse("2026-08-01T12:00:00.000Z"));
    expect(parsed.agents).toEqual([
      {
        agentId: "main",
        agentType: "main",
        parentAgentId: null,
        sourceDirectory: "C:\\live\\agents\\main",
      },
      {
        agentId: "agent-0",
        agentType: "sub",
        parentAgentId: "main",
        sourceDirectory: "C:\\live\\agents\\agent-0",
      },
    ]);
  });
});
