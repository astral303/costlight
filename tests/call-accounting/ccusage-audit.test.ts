import { describe, expect, test } from "bun:test";
import { extractCcusageTotalUsd } from "../../src/call-accounting/ccusage-audit";

describe("extractCcusageTotalUsd", () => {
  test("reads aggregate and daily report shapes", () => {
    expect(extractCcusageTotalUsd({ totals: { totalCost: 12.5 } })).toBe(12.5);
    expect(extractCcusageTotalUsd({ daily: [{ totalCost: 1.25 }, { totalCost: 2.5 }] })).toBe(3.75);
    expect(extractCcusageTotalUsd([{ totalCost: 4 }, { totalCost: 5 }])).toBe(9);
  });
});
