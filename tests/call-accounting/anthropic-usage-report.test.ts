import { describe, expect, test } from "bun:test";
import { parseAnthropicUsageReport } from "../../src/call-accounting/anthropic-usage-report";

const TOKENS = {
  cache_read: 400,
  cache_write_1h: 50,
  cache_write_5m: 30,
  input: 100,
  output: 200,
};

function usageExport(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    currency: "usd",
    end_date: "2026-08-17",
    granularity: "daily",
    group_by: "model_tier",
    series: [
      {
        bucket: "2026-08-03",
        cost_minor_units: 1785,
        group_key: "claude_opus_4_8",
        request_count: 155,
        tokens: TOKENS,
      },
    ],
    start_date: "2026-07-19",
    ...overrides,
  };
}

describe("parseAnthropicUsageReport", () => {
  test("converts minor units to USD and underscored group keys to model keys", () => {
    const report = parseAnthropicUsageReport(usageExport());

    expect(report.startDate).toBe("2026-07-19");
    expect(report.endDate).toBe("2026-08-17");
    expect(report.days).toEqual([
      {
        costUsd: 17.85,
        date: "2026-08-03",
        modelKey: "claude-opus-4-8",
        requestCount: 155,
        tokens: {
          cacheRead: 400,
          cacheWrite1h: 50,
          cacheWrite5m: 30,
          cacheWriteUntyped: 0,
          input: 100,
          output: 200,
        },
      },
    ]);
  });

  test("keeps the dated model keys the pricing catalog uses", () => {
    const report = parseAnthropicUsageReport(usageExport({
      series: [{
        bucket: "2026-08-03",
        cost_minor_units: 0,
        group_key: "claude_haiku_4_5_20251001",
        request_count: 1,
        tokens: TOKENS,
      }],
    }));

    expect(report.days[0]?.modelKey).toBe("claude-haiku-4-5-20251001");
  });

  test("rejects an export taken at another grouping or granularity", () => {
    expect(() => parseAnthropicUsageReport(usageExport({ granularity: "hourly" })))
      .toThrow("Not a daily model-tier usage export in USD: granularity:");
    expect(() => parseAnthropicUsageReport(usageExport({ group_by: "workspace" })))
      .toThrow("Not a daily model-tier usage export in USD: group_by:");
    expect(() => parseAnthropicUsageReport(usageExport({ currency: "eur" })))
      .toThrow("Not a daily model-tier usage export in USD: currency:");
  });

  test("rejects a bucket that is not a calendar date", () => {
    const malformed = usageExport({
      series: [{
        bucket: "2026-08-03T00:00:00Z",
        cost_minor_units: 1,
        group_key: "claude_opus_4_8",
        request_count: 1,
        tokens: TOKENS,
      }],
    });

    expect(() => parseAnthropicUsageReport(malformed)).toThrow("expected a YYYY-MM-DD date");
  });
});
