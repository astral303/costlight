import { describe, expect, test } from "bun:test";
import { assignMetering, policyForSubscription } from "../../src/metered-usage/policy";
import { isProMeteredClaudeModel } from "../../src/pricing/anthropic-catalog";

describe("metered usage policy", () => {
  test("meters only explicit Fable models for Pro", () => {
    const state = { accountStateId: 1, policy: policyForSubscription("pro"), subscriptionType: "pro" };

    expect(assignMetering("anthropic", "claude-fable-5", state, isProMeteredClaudeModel))
      .toEqual({ accountStateId: 1, basis: "pro-fable", isMetered: true });
    expect(assignMetering("anthropic", "claude-opus-5", state, isProMeteredClaudeModel))
      .toEqual({ accountStateId: 1, basis: "pro-subscription-excluded", isMetered: false });
  });

  test("meters all Claude models for Enterprise", () => {
    const state = {
      accountStateId: 2,
      policy: policyForSubscription("enterprise"),
      subscriptionType: "enterprise",
    };

    expect(assignMetering("anthropic", "unknown-claude-model", state, isProMeteredClaudeModel))
      .toEqual({ accountStateId: 2, basis: "enterprise-api", isMetered: true });
  });

  test("excludes every other or unavailable Claude account state", () => {
    const state = { accountStateId: 3, policy: policyForSubscription("max"), subscriptionType: "max" };

    expect(assignMetering("anthropic", "claude-fable-5", state, isProMeteredClaudeModel))
      .toEqual({ accountStateId: 3, basis: "subscription-excluded", isMetered: false });
    expect(assignMetering("anthropic", "claude-fable-5", null, isProMeteredClaudeModel))
      .toEqual({ accountStateId: null, basis: "account-status-unavailable", isMetered: false });
  });

  test("keeps non-Claude API calls eligible", () => {
    expect(assignMetering("moonshotai", "kimi-k3", null, isProMeteredClaudeModel))
      .toEqual({ accountStateId: null, basis: "metered-api", isMetered: true });
  });
});
