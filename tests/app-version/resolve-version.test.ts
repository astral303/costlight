import { describe, expect, test } from "bun:test";
import { formatGitVersion, resolveApplicationVersion } from "../../src/app-version/resolve-version";

describe("application version", () => {
  test("uses a clean CalVer tag as the release version", () => {
    expect(formatGitVersion({
      commitCount: 0,
      dirty: false,
      exactTags: ["v2026.8.14"],
      nearestTag: "v2026.8.14",
    }, "2026.8.14")).toBe("2026.8.14");
  });

  test("counts development commits from the nearest release tag", () => {
    expect(formatGitVersion({
      commitCount: 3,
      dirty: false,
      exactTags: [],
      nearestTag: "v2026.8.14",
    }, "2026.8.14")).toBe("2026.8.14-dev.3");
  });

  test("marks modified release source as development code", () => {
    expect(formatGitVersion({
      commitCount: 0,
      dirty: true,
      exactTags: ["v2026.8.14"],
      nearestTag: "v2026.8.14",
    }, "2026.8.14")).toBe("2026.8.14-dev.0.dirty");
  });

  test("uses the bootstrap date and total commits before the first release", () => {
    expect(formatGitVersion({
      commitCount: 19,
      dirty: false,
      exactTags: [],
      nearestTag: null,
    }, "2026.8.14")).toBe("2026.8.14-dev.19");
  });

  test("rejects malformed and conflicting release tags", () => {
    expect(() => formatGitVersion({
      commitCount: 0,
      dirty: false,
      exactTags: ["v2026.8.14", "v2026.8.15"],
      nearestTag: "v2026.8.14",
    }, "2026.8.14")).toThrow("conflicting CalVer tags");
    expect(() => formatGitVersion({
      commitCount: 1,
      dirty: false,
      exactTags: [],
      nearestTag: "v2026.13.1",
    }, "2026.8.14")).toThrow("Expected a real date");
  });

  test("accepts a validated build-time version override", () => {
    expect(resolveApplicationVersion({
      COSTLIGHT_VERSION: "2026.8.14-dev.3.dirty",
    })).toBe("2026.8.14-dev.3.dirty");
    expect(() => resolveApplicationVersion({
      COSTLIGHT_VERSION: "latest",
    })).toThrow("Invalid COSTLIGHT_VERSION");
  });
});
