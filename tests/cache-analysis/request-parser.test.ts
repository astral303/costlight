import { describe, expect, test } from "bun:test";
import { parseRequestMetadataByUsageOffset } from "../../src/cache-analysis/request-parser";

const encoder = new TextEncoder();

describe("parseRequestMetadataByUsageOffset", () => {
  test("pairs a turn usage record with its preceding client request", () => {
    const requestLine = JSON.stringify({
      messageCount: 42,
      systemPromptHash: "system-hash",
      time: 1_785_585_600_000,
      toolsHash: "tools-hash",
      type: "llm.request",
    });
    const usageLine = JSON.stringify({
      time: 1_785_585_600_500,
      type: "usage.record",
      usageScope: "turn",
    });
    const content = `${requestLine}\n${usageLine}\n`;
    const usageOffset = encoder.encode(`${requestLine}\n`).byteLength;

    const parsed = parseRequestMetadataByUsageOffset(
      encoder.encode(content),
      new Set([usageOffset]),
    );

    expect(parsed.requestsByUsageOffset.get(usageOffset)).toEqual({
      messageCount: 42,
      requestedAtMs: 1_785_585_600_000,
      systemPromptHash: "system-hash",
      toolsHash: "tools-hash",
    });
  });

  test("uses byte offsets and does not carry a request across turn usage records", () => {
    const unrelatedLine = JSON.stringify({ text: "Unicode: 月", type: "other" });
    const requestLine = JSON.stringify({
      time: "2026-08-01T12:00:00.000Z",
      type: "llm.request",
    });
    const firstUsageLine = JSON.stringify({ type: "usage.record", usageScope: "turn" });
    const secondUsageLine = JSON.stringify({ type: "usage.record", usageScope: "turn" });
    const prefix = `${unrelatedLine}\n${requestLine}\n`;
    const firstUsageOffset = encoder.encode(prefix).byteLength;
    const secondUsageOffset = encoder.encode(`${prefix}${firstUsageLine}\n`).byteLength;
    const content = `${prefix}${firstUsageLine}\n${secondUsageLine}\n`;

    const parsed = parseRequestMetadataByUsageOffset(
      encoder.encode(content),
      new Set([firstUsageOffset, secondUsageOffset]),
    );

    expect(parsed.requestsByUsageOffset.get(firstUsageOffset)?.requestedAtMs).toBe(
      Date.parse("2026-08-01T12:00:00.000Z"),
    );
    expect(parsed.requestsByUsageOffset.has(secondUsageOffset)).toBeFalse();
  });
});
