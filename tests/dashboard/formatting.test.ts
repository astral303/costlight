import { describe, expect, test } from "bun:test";
import { formatUsdPerMillion } from "../../src/dashboard/formatting";

describe("formatUsdPerMillion", () => {
  test("shows a third decimal when the rate has one", () => {
    expect(formatUsdPerMillion(0.125)).toBe("$0.125");
    expect(formatUsdPerMillion(0.625)).toBe("$0.625");
  });

  test("keeps two decimals for whole-cent rates", () => {
    expect(formatUsdPerMillion(0.1)).toBe("$0.10");
    expect(formatUsdPerMillion(0.01)).toBe("$0.01");
    expect(formatUsdPerMillion(12.5)).toBe("$12.50");
  });

  test("shows a dash for a missing rate", () => {
    expect(formatUsdPerMillion(null)).toBe("—");
  });
});
