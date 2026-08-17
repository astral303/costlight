import { describe, expect, test } from "bun:test";
import {
  parseClaudeSessionState,
  parseClaudeTranscriptChunk,
} from "../../../src/session-import/claude/parser";

const encoder = new TextEncoder();

describe("Claude transcript parser", () => {
  test("extracts usage and separates cache-write TTLs", () => {
    const completeLine = assistantLine({
      cacheCreation1h: 30,
      cacheCreation5m: 20,
      cacheRead: 40,
      input: 10,
      output: 50,
      requestId: "request-1",
    });
    const partialLine = assistantLine({ requestId: "request-2" });
    const bytes = encoder.encode(`${completeLine}\n${partialLine}`);

    const parsed = parseClaudeTranscriptChunk(bytes, 100, {});

    expect(parsed.completeByteLength).toBe(encoder.encode(`${completeLine}\n`).length);
    expect(parsed.records).toEqual([{
      byteOffset: 100,
      model: "claude-fable-5",
      providerRequestId: "request-1",
      requestMetadata: "message-request-1",
      stepUuid: "event-request-1",
      timestampMs: Date.parse("2026-07-26T12:00:00.000Z"),
      tokens: {
        cacheCreation: 0,
        cacheCreation1h: 30,
        cacheCreation5m: 20,
        cacheRead: 40,
        inputOther: 10,
        output: 50,
      },
    }]);
  });

  test("ignores synthetic and zero-token messages", () => {
    const synthetic = assistantLine({ model: "<synthetic>", requestId: "synthetic" });
    const zero = assistantLine({
      cacheRead: 0,
      input: 0,
      output: 0,
      requestId: "zero",
    });
    const malformed = '{"type":"assistant","usage":';
    const parsed = parseClaudeTranscriptChunk(
      encoder.encode(`${synthetic}\n${zero}\n${malformed}\n`),
      0,
      {},
    );

    expect(parsed.records).toHaveLength(0);
    expect(parsed.ignoredMalformedLineCount).toBe(1);
  });

  test("extracts session metadata without reading message content", () => {
    const content = [
      JSON.stringify({
        cwd: "C:\\work\\project",
        timestamp: "2026-07-26T12:00:00.000Z",
        type: "user",
      }),
      JSON.stringify({ aiTitle: "Synthetic Claude session", sessionId: "session", type: "ai-title" }),
      JSON.stringify({
        cwd: "C:\\work\\project",
        timestamp: "2026-07-26T12:05:00.000Z",
        type: "assistant",
      }),
    ].join("\n");
    const state = parseClaudeSessionState(content, {
      agents: [
        {
          agentId: "main",
          agentKey: "main",
          agentLabel: "Main",
          agentType: "main",
          parentAgentId: null,
          sourceDirectory: "C:\\transcripts",
        },
        {
          agentId: "agent-test",
          agentKey: "agent:Explore",
          agentLabel: "Explore",
          agentType: "sub",
          parentAgentId: "main",
          sourceDirectory: "C:\\transcripts\\subagents",
        },
      ],
      fallbackTimestampMs: 1,
    });

    expect(state).toEqual({
      agents: [
        {
          agentId: "main",
          agentKey: "main",
          agentLabel: "Main",
          agentType: "main",
          parentAgentId: null,
          sourceDirectory: "C:\\transcripts",
        },
        {
          agentId: "agent-test",
          agentKey: "agent:Explore",
          agentLabel: "Explore",
          agentType: "sub",
          parentAgentId: "main",
          sourceDirectory: "C:\\transcripts\\subagents",
        },
      ],
      createdAtMs: Date.parse("2026-07-26T12:00:00.000Z"),
      title: "Synthetic Claude session",
      updatedAtMs: Date.parse("2026-07-26T12:05:00.000Z"),
      workDirectory: "C:\\work\\project",
    });
  });
});

interface AssistantLineOptions {
  cacheCreation1h?: number;
  cacheCreation5m?: number;
  cacheRead?: number;
  input?: number;
  model?: string;
  output?: number;
  requestId: string;
}

function assistantLine(options: AssistantLineOptions): string {
  const cacheCreation1h = options.cacheCreation1h ?? 0;
  const cacheCreation5m = options.cacheCreation5m ?? 0;
  return JSON.stringify({
    message: {
      content: [],
      id: `message-${options.requestId}`,
      model: options.model ?? "claude-fable-5",
      role: "assistant",
      type: "message",
      usage: {
        cache_creation: {
          ephemeral_1h_input_tokens: cacheCreation1h,
          ephemeral_5m_input_tokens: cacheCreation5m,
        },
        cache_creation_input_tokens: cacheCreation1h + cacheCreation5m,
        cache_read_input_tokens: options.cacheRead ?? 1,
        input_tokens: options.input ?? 1,
        output_tokens: options.output ?? 1,
      },
    },
    requestId: options.requestId,
    timestamp: "2026-07-26T12:00:00.000Z",
    type: "assistant",
    uuid: `event-${options.requestId}`,
  });
}
