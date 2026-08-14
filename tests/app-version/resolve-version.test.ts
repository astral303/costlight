import { describe, expect, test } from "bun:test";
import {
  formatGitVersion,
  type GitVersionState,
  resolveApplicationVersion,
} from "../../src/app-version/resolve-version";

const UNTAGGED_STATE: GitVersionState = {
  commitCount: 20,
  dirty: false,
  exactTags: [],
  headCommitDate: "2026-08-14T12:00:00-04:00",
  nearestTag: null,
};

describe("application version", () => {
  test("uses a clean CalVer tag as the release version", () => {
    expect(formatGitVersion({
      ...UNTAGGED_STATE,
      exactTags: ["v2026.8.14"],
      nearestTag: "v2026.8.14",
    })).toBe("2026.8.14");
  });

  test("counts development commits from the nearest release tag", () => {
    expect(formatGitVersion({
      ...UNTAGGED_STATE,
      commitCount: 3,
      nearestTag: "v2026.8.14",
    })).toBe("2026.8.14-dev.3");
  });

  test("marks modified release source as development code", () => {
    expect(formatGitVersion({
      ...UNTAGGED_STATE,
      commitCount: 0,
      dirty: true,
      exactTags: ["v2026.8.14"],
      nearestTag: "v2026.8.14",
    })).toBe("2026.8.14-dev.0.dirty");
  });

  test("uses the HEAD commit date and total commits before the first release", () => {
    expect(formatGitVersion(UNTAGGED_STATE)).toBe("2026.8.14-dev.20");
  });

  test("rejects malformed and conflicting release tags", () => {
    expect(() => formatGitVersion({
      ...UNTAGGED_STATE,
      exactTags: ["v2026.8.14", "v2026.8.15"],
      nearestTag: "v2026.8.14",
    })).toThrow("conflicting CalVer tags");
    expect(() => formatGitVersion({
      ...UNTAGGED_STATE,
      commitCount: 1,
      nearestTag: "v2026.13.1",
    })).toThrow("Expected a real date");
    expect(() => formatGitVersion({
      ...UNTAGGED_STATE,
      headCommitDate: "not-a-date",
    })).toThrow("invalid HEAD commit date");
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
