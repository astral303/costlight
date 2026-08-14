import { describe, expect, test } from "bun:test";
import {
  detectClaudeAccount,
  parseClaudeAccountStatus,
} from "../../src/metered-usage/account-status";

describe("Claude account detection", () => {
  test.each(["pro", "enterprise", "max"]) (
    "accepts the %s subscription without inventing aliases",
    (subscriptionType) => {
      expect(parseClaudeAccountStatus(JSON.stringify({
        apiProvider: "firstParty",
        authMethod: "claude.ai",
        loggedIn: true,
        subscriptionType: subscriptionType.toUpperCase(),
      }))).toEqual({
        apiProvider: "firstParty",
        authMethod: "claude.ai",
        subscriptionType,
      });
    },
  );

  test("rejects logged-out and malformed status responses", () => {
    expect(() => parseClaudeAccountStatus(JSON.stringify({
      apiProvider: "firstParty",
      authMethod: "claude.ai",
      loggedIn: false,
    }))).toThrow("not logged in");
    expect(() => parseClaudeAccountStatus("not-json")).toThrow("invalid JSON");
    expect(() => parseClaudeAccountStatus(JSON.stringify({ loggedIn: true })))
      .toThrow("invalid JSON");
  });

  test("kills a status command that exceeds its deadline", async () => {
    let resolveExit: (exitCode: number) => void = () => {};
    let wasKilled = false;
    const exited = new Promise<number>((resolve) => {
      resolveExit = resolve;
    });

    await expect(detectClaudeAccount({
      spawn: () => ({
        exited,
        kill: () => {
          wasKilled = true;
          resolveExit(143);
        },
        stdout: streamFromText(""),
      }),
      timeoutMs: 1,
    })).rejects.toThrow("timed out");
    expect(wasKilled).toBe(true);
  });

  test("reports a missing executable without masking the failure", async () => {
    await expect(detectClaudeAccount({
      spawn: () => {
        throw new Error("Executable not found");
      },
    })).rejects.toThrow("Executable not found");
  });
});

function streamFromText(value: string): ReadableStream<Uint8Array> {
  return new Blob([value]).stream();
}
