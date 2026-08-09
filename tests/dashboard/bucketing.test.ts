import { describe, expect, test } from "bun:test";
import { bucketTimestampMs, selectAutomaticBucket } from "../../src/dashboard/bucketing";

describe("dashboard bucketing", () => {
  test("uses local midnight across a daylight-saving transition", () => {
    const springForwardDay = bucketTimestampMs(
      Date.parse("2026-03-08T16:00:00.000Z"),
      "day",
      "America/New_York",
    );
    const followingDay = bucketTimestampMs(
      Date.parse("2026-03-09T16:00:00.000Z"),
      "day",
      "America/New_York",
    );

    expect(new Date(springForwardDay).toISOString()).toBe("2026-03-08T05:00:00.000Z");
    expect(new Date(followingDay).toISOString()).toBe("2026-03-09T04:00:00.000Z");
    expect(followingDay - springForwardDay).toBe(23 * 60 * 60 * 1_000);
  });

  test("selects bounded automatic bucket sizes", () => {
    expect(selectAutomaticBucket(0, 60 * 60 * 1_000)).toBe("minute");
    expect(selectAutomaticBucket(0, 30 * 24 * 60 * 60 * 1_000)).toBe("hour");
    expect(selectAutomaticBucket(0, 365 * 24 * 60 * 60 * 1_000)).toBe("day");
    expect(selectAutomaticBucket(0, 3 * 365 * 24 * 60 * 60 * 1_000)).toBe("week");
  });
});
