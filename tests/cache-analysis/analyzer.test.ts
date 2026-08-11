import { describe, expect, test } from "bun:test";
import {
  analyzeCacheWindow,
  defaultCacheAnalysisOptions,
} from "../../src/cache-analysis/analyzer";
import type { CacheCall } from "../../src/cache-analysis/call-loader";

describe("analyzeCacheWindow", () => {
  test("finds a sharp change between the latest hit and earliest later miss", () => {
    const calls = [
      ...createTransition("hit-1", 5, "hit"),
      ...createTransition("hit-2", 30, "hit"),
      ...createTransition("hit-3", 50, "hit"),
      ...createTransition("hit-4", 59, "hit"),
      ...createTransition("early-miss", 10, "miss"),
      ...createTransition("miss-1", 61, "miss"),
      ...createTransition("miss-2", 70, "miss"),
      ...createTransition("miss-3", 90, "miss"),
    ];

    const analysis = analyzeCacheWindow(calls);

    expect(analysis.changePoint).not.toBeNull();
    expect(analysis.changePoint?.lowerObservedMinutes).toBe(59);
    expect(analysis.changePoint?.upperObservedMinutes).toBe(61);
    expect(analysis.changePoint?.estimatedMinutes).toBe(60);
    expect(analysis.changePoint?.postHitCount).toBe(0);
    expect(analysis.changePoint?.postMissCount).toBe(3);
    expect(analysis.changePoint?.postSessionCount).toBe(3);
  });

  test("excludes cache-key changes and materially different prompt sizes", () => {
    const configurationChanged = createTransition("configuration", 61, "miss");
    const promptShrank = createTransition("prompt", 61, "miss");
    const changedCurrent = configurationChanged[1];
    const shrunkenCurrent = promptShrank[1];
    if (changedCurrent === undefined || shrunkenCurrent === undefined) {
      throw new Error("Test transition setup is incomplete.");
    }
    changedCurrent.systemPromptHash = "different-system";
    shrunkenCurrent.inputOtherTokens = 100;
    shrunkenCurrent.cacheReadTokens = 18_000;

    const analysis = analyzeCacheWindow([...configurationChanged, ...promptShrank]);

    expect(analysis.classifiedTransitionCount).toBe(0);
    expect(analysis.excludedTransitionCounts.requestConfigurationChanged).toBe(1);
    expect(analysis.excludedTransitionCounts.promptSizeChanged).toBe(1);
  });

  test("treats a multi-hour sequence of short-gap hits as a sliding window", () => {
    const calls = [
      createCall("active", 0, 100_000, 500, 10),
      createCall("active", 30, 101_000, 500, 12),
      createCall("active", 60, 102_000, 500, 14),
      createCall("active", 90, 103_000, 500, 16),
      createCall("active", 120, 104_000, 500, 18),
    ];

    const analysis = analyzeCacheWindow(calls);

    expect(analysis.longestHitRunMinutes).toBe(120);
    expect(analysis.longestHitRunTransitionCount).toBe(4);
  });

  test("reports a stricter bound when sibling agents may refresh a shared prefix", () => {
    const sharedPrevious = createCall("shared", 0, 200_000, 500, 10);
    const siblingCall = createCall("shared", 30, 80_000, 500, 10);
    const sharedCurrent = createCall("shared", 59, 201_000, 500, 12);
    siblingCall.agentId = "subagent";
    const calls = [
      sharedPrevious,
      siblingCall,
      sharedCurrent,
      ...createTransition("isolated-hit", 50, "hit"),
      ...createTransition("isolated-miss", 61, "miss"),
    ];

    const analysis = analyzeCacheWindow(calls);

    expect(analysis.changePoint?.lowerObservedMinutes).toBe(59);
    expect(analysis.changePoint?.lastHitBefore.interveningSessionCallCount).toBe(1);
    expect(analysis.changePoint?.lastHitBefore.interveningGlobalCallCount).toBe(2);
    expect(analysis.sessionIdleChangePoint?.lowerObservedMinutes).toBe(50);
    expect(analysis.sessionIdleChangePoint?.upperObservedMinutes).toBe(61);
  });

  test("validates contradictory classifier thresholds", () => {
    expect(() => analyzeCacheWindow([], {
      ...defaultCacheAnalysisOptions,
      maximumMissCacheRatio: 0.95,
      minimumHitCacheRatio: 0.9,
    })).toThrow("Invalid cache-analysis options.");
  });
});

function createTransition(
  streamId: string,
  gapMinutes: number,
  classification: "hit" | "miss",
): readonly CacheCall[] {
  const current = classification === "hit"
    ? createCall(streamId, gapMinutes, 101_000, 500, 12)
    : createCall(streamId, gapMinutes, 18_000, 83_000, 12);
  return [createCall(streamId, 0, 100_000, 500, 10), current];
}

function createCall(
  streamId: string,
  requestMinutes: number,
  cacheReadTokens: number,
  inputOtherTokens: number,
  messageCount: number,
): CacheCall {
  const requestTimestampMs = requestMinutes * 60_000;
  return {
    agentId: "main",
    cacheReadTokens,
    eventFingerprint: `${streamId}-${requestMinutes}`,
    inputOtherTokens,
    messageCount,
    model: "moonshot-ai/kimi-k3",
    requestTimestampMs,
    requestTimingSource: "llm-request",
    sessionId: streamId,
    systemPromptHash: "stable-system",
    toolsHash: "stable-tools",
    usageTimestampMs: requestTimestampMs + 1_000,
  };
}
