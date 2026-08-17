import { describe, expect, test } from "bun:test";
import { parseClaudeAgentIdentity } from "../../../src/session-import/claude/agent-identity";

describe("Claude agent identity", () => {
  test("uses reusable agent roles instead of per-run IDs", () => {
    const content = [
      JSON.stringify({ attributionSkill: "code-review", type: "assistant" }),
      JSON.stringify({ attributionAgent: "Explore", type: "assistant" }),
    ].join("\n");

    expect(parseClaudeAgentIdentity(content)).toEqual({
      key: "agent:Explore",
      label: "Explore",
    });
  });

  test("labels skill workers and collapses unclassified subagents", () => {
    expect(parseClaudeAgentIdentity(JSON.stringify({
      attributionSkill: "code-review",
      type: "assistant",
    }))).toEqual({
      key: "skill:code-review",
      label: "code-review (skill)",
    });
    expect(parseClaudeAgentIdentity('{"type":"assistant"}\nmalformed')).toEqual({
      key: "subagent",
      label: "Other subagent",
    });
  });
});
