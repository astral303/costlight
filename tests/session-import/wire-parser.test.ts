import { describe, expect, test } from "bun:test";
import { parseWireChunk } from "../../src/session-import/wire-parser";

const encoder = new TextEncoder();

describe("parseWireChunk", () => {
  test("includes nonzero turn usage and carries the preceding request identity", () => {
    const content = [
      JSON.stringify({
        event: {
          messageId: "provider-request-1",
          step: 2,
          turnId: "turn-1",
          type: "step.end",
          uuid: "step-uuid-1",
        },
        time: 1_785_585_600_000,
        type: "context.append_loop_event",
      }),
      JSON.stringify({
        model: "moonshot-ai/kimi-k3",
        time: 1_785_585_600_001,
        type: "usage.record",
        usage: {
          inputCacheCreation: 20,
          inputCacheRead: 300,
          inputOther: 100,
          output: 40,
        },
        usageScope: "turn",
      }),
      JSON.stringify({
        model: "moonshot-ai/kimi-k3",
        time: 1_785_585_600_002,
        type: "usage.record",
        usage: {
          inputCacheCreation: 20,
          inputCacheRead: 300,
          inputOther: 100,
          output: 40,
        },
        usageScope: "session",
      }),
      "",
    ].join("\n");

    const parsed = parseWireChunk(encoder.encode(content), 0);

    expect(parsed.records).toHaveLength(1);
    expect(parsed.records[0]).toMatchObject({
      model: "moonshot-ai/kimi-k3",
      providerRequestId: "provider-request-1",
      stepUuid: "step-uuid-1",
      tokens: {
        cacheCreation: 20,
        cacheRead: 300,
        inputOther: 100,
        output: 40,
      },
    });
    expect(parsed.completeByteLength).toBe(encoder.encode(content).byteLength);
  });

  test("retains request context while an appended usage line is incomplete", () => {
    const stepLine = `${JSON.stringify({
      event: { messageId: "request-across-writes", type: "step.end", uuid: "step-across-writes" },
      type: "context.append_loop_event",
    })}\n`;
    const incompleteUsage = JSON.stringify({
      model: "moonshot-ai/kimi-k3",
      time: 1_785_585_600_000,
      type: "usage.record",
      usage: { inputCacheCreation: 0, inputCacheRead: 0, inputOther: 10, output: 2 },
      usageScope: "turn",
    });
    const firstChunk = encoder.encode(stepLine + incompleteUsage.slice(0, 40));

    const firstResult = parseWireChunk(firstChunk, 0);
    expect(firstResult.records).toHaveLength(0);
    expect(firstResult.completeByteLength).toBe(encoder.encode(stepLine).byteLength);
    expect(firstResult.context.providerRequestId).toBe("request-across-writes");

    const secondChunk = encoder.encode(`${incompleteUsage}\n`);
    const secondResult = parseWireChunk(
      secondChunk,
      firstResult.completeByteLength,
      firstResult.context,
    );
    expect(secondResult.records[0]?.providerRequestId).toBe("request-across-writes");
  });

  test("ignores malformed relevant lines, zero usage, and unrelated records", () => {
    const content = [
      "not json usage.record",
      JSON.stringify({ type: "unrelated", value: "usage.record" }),
      JSON.stringify({
        model: "moonshot-ai/kimi-k3",
        time: 1_785_585_600_000,
        type: "usage.record",
        usage: { inputCacheCreation: 0, inputCacheRead: 0, inputOther: 0, output: 0 },
        usageScope: "turn",
      }),
      "",
    ].join("\n");

    const parsed = parseWireChunk(encoder.encode(content), 0);

    expect(parsed.records).toHaveLength(0);
    expect(parsed.ignoredMalformedLineCount).toBe(1);
  });
});
