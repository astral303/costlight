import type { CacheCall } from "./call-loader";

const MILLISECONDS_PER_MINUTE = 60_000;

export interface CacheAnalysisOptions {
  maximumMissCacheRatio: number;
  maximumPromptSizeRatio: number;
  minimumCacheReadTokens: number;
  minimumHitCacheRatio: number;
  minimumPromptSizeRatio: number;
  minimumRebilledTokenRatio: number;
  requireStableRequestConfiguration: boolean;
}

export const defaultCacheAnalysisOptions: CacheAnalysisOptions = {
  maximumMissCacheRatio: 0.5,
  maximumPromptSizeRatio: 1.25,
  minimumCacheReadTokens: 65_536,
  minimumHitCacheRatio: 0.9,
  minimumPromptSizeRatio: 0.8,
  minimumRebilledTokenRatio: 0.8,
  requireStableRequestConfiguration: true,
};

export interface CacheTransitionEvidence {
  cacheReadTokens: number;
  classification: "hit" | "miss";
  gapMinutes: number;
  inputOtherTokens: number;
  interveningGlobalCallCount: number;
  interveningSessionCallCount: number;
  model: string;
  previousCacheReadTokens: number;
  promptSizeRatio: number;
}

interface ClassifiedTransition extends CacheTransitionEvidence {
  currentRequestTimestampMs: number;
  sessionId: string;
  streamKey: string;
}

export interface CacheChangePoint {
  beforeHitCount: number;
  beforeMissCount: number;
  estimatedMinutes: number;
  firstMissAfter: CacheTransitionEvidence;
  lastHitBefore: CacheTransitionEvidence;
  lowerObservedMinutes: number;
  postCalendarDayCount: number;
  postHitCount: number;
  postMissCount: number;
  postSessionCount: number;
  postStreamCount: number;
  upperObservedMinutes: number;
}

export interface CacheGapBand {
  hitCount: number;
  label: string;
  missCount: number;
}

export interface CacheWindowAnalysis {
  accountIdleChangePoint: CacheChangePoint | null;
  ambiguousTransitionCount: number;
  cacheReadAfterMissMedian: number | null;
  callCount: number;
  changePoint: CacheChangePoint | null;
  classifiedTransitionCount: number;
  excludedTransitionCounts: Readonly<Record<TransitionExclusion, number>>;
  gapBands: readonly CacheGapBand[];
  hitCount: number;
  longestHitRunMinutes: number;
  longestHitRunTransitionCount: number;
  missCount: number;
  modelCallCounts: Readonly<Record<string, number>>;
  options: CacheAnalysisOptions;
  sessionIdleChangePoint: CacheChangePoint | null;
  streamCount: number;
  transitionCount: number;
}

type TransitionExclusion =
  | "invalidChronology"
  | "insufficientPriorCache"
  | "messageCountRegressed"
  | "promptSizeChanged"
  | "requestConfigurationChanged";

const transitionExclusions: readonly TransitionExclusion[] = [
  "invalidChronology",
  "insufficientPriorCache",
  "messageCountRegressed",
  "promptSizeChanged",
  "requestConfigurationChanged",
];

export function analyzeCacheWindow(
  calls: readonly CacheCall[],
  optionOverrides: Partial<CacheAnalysisOptions> = {},
): CacheWindowAnalysis {
  const options = { ...defaultCacheAnalysisOptions, ...optionOverrides };
  validateOptions(options);
  const streams = groupCallsByStream(calls);
  const globalCallPositions = mapCallPositions(calls);
  const sessionCallPositions = mapSessionCallPositions(calls);
  const excludedTransitionCounts = createExclusionCounts();
  const classifiedTransitions: ClassifiedTransition[] = [];
  let transitionCount = 0;
  let ambiguousTransitionCount = 0;
  let longestHitRunMinutes = 0;
  let longestHitRunTransitionCount = 0;

  for (const [streamKey, streamCalls] of streams) {
    let currentRunMinutes = 0;
    let currentRunTransitionCount = 0;

    for (let index = 1; index < streamCalls.length; index += 1) {
      const previousCall = streamCalls[index - 1];
      const currentCall = streamCalls[index];
      if (previousCall === undefined || currentCall === undefined) {
        continue;
      }

      transitionCount += 1;
      const interveningGlobalCallCount = countInterveningCalls(
        previousCall,
        currentCall,
        globalCallPositions,
      );
      const interveningSessionCallCount = countInterveningSessionCalls(
        previousCall,
        currentCall,
        sessionCallPositions,
      );
      const result = classifyTransition(
        previousCall,
        currentCall,
        interveningGlobalCallCount,
        interveningSessionCallCount,
        options,
      );
      if (result.kind === "excluded") {
        excludedTransitionCounts[result.reason] += 1;
        currentRunMinutes = 0;
        currentRunTransitionCount = 0;
        continue;
      }
      if (result.kind === "ambiguous") {
        ambiguousTransitionCount += 1;
        currentRunMinutes = 0;
        currentRunTransitionCount = 0;
        continue;
      }

      classifiedTransitions.push({
        ...result.evidence,
        currentRequestTimestampMs: currentCall.requestTimestampMs,
        sessionId: currentCall.sessionId,
        streamKey,
      });
      if (result.evidence.classification === "hit") {
        currentRunMinutes += result.evidence.gapMinutes;
        currentRunTransitionCount += 1;
        if (currentRunMinutes > longestHitRunMinutes) {
          longestHitRunMinutes = currentRunMinutes;
          longestHitRunTransitionCount = currentRunTransitionCount;
        }
      } else {
        currentRunMinutes = 0;
        currentRunTransitionCount = 0;
      }
    }
  }

  const hits = classifiedTransitions.filter(({ classification }) => classification === "hit");
  const misses = classifiedTransitions.filter(({ classification }) => classification === "miss");

  return {
    accountIdleChangePoint: findChangePoint(
      classifiedTransitions.filter(({ interveningGlobalCallCount }) =>
        interveningGlobalCallCount === 0),
    ),
    ambiguousTransitionCount,
    cacheReadAfterMissMedian: median(misses.map(({ cacheReadTokens }) => cacheReadTokens)),
    callCount: calls.length,
    changePoint: findChangePoint(classifiedTransitions),
    classifiedTransitionCount: classifiedTransitions.length,
    excludedTransitionCounts,
    gapBands: buildGapBands(classifiedTransitions),
    hitCount: hits.length,
    longestHitRunMinutes,
    longestHitRunTransitionCount,
    missCount: misses.length,
    modelCallCounts: countCallsByModel(calls),
    options,
    sessionIdleChangePoint: findChangePoint(
      classifiedTransitions.filter(({ interveningSessionCallCount }) =>
        interveningSessionCallCount === 0),
    ),
    streamCount: streams.size,
    transitionCount,
  };
}

type TransitionResult =
  | { kind: "ambiguous" }
  | { kind: "classified"; evidence: CacheTransitionEvidence }
  | { kind: "excluded"; reason: TransitionExclusion };

function classifyTransition(
  previousCall: CacheCall,
  currentCall: CacheCall,
  interveningGlobalCallCount: number,
  interveningSessionCallCount: number,
  options: CacheAnalysisOptions,
): TransitionResult {
  const gapMinutes = (currentCall.requestTimestampMs - previousCall.requestTimestampMs)
    / MILLISECONDS_PER_MINUTE;
  if (gapMinutes < 0) {
    return { kind: "excluded", reason: "invalidChronology" };
  }
  if (previousCall.cacheReadTokens < options.minimumCacheReadTokens) {
    return { kind: "excluded", reason: "insufficientPriorCache" };
  }
  if (
    options.requireStableRequestConfiguration
    && !hasStableRequestConfiguration(previousCall, currentCall)
  ) {
    return { kind: "excluded", reason: "requestConfigurationChanged" };
  }
  if (
    previousCall.messageCount !== null
    && currentCall.messageCount !== null
    && currentCall.messageCount < previousCall.messageCount
  ) {
    return { kind: "excluded", reason: "messageCountRegressed" };
  }

  const previousPromptTokens = previousCall.inputOtherTokens + previousCall.cacheReadTokens;
  const currentPromptTokens = currentCall.inputOtherTokens + currentCall.cacheReadTokens;
  const promptSizeRatio = previousPromptTokens === 0
    ? Number.POSITIVE_INFINITY
    : currentPromptTokens / previousPromptTokens;
  if (
    promptSizeRatio < options.minimumPromptSizeRatio
    || promptSizeRatio > options.maximumPromptSizeRatio
  ) {
    return { kind: "excluded", reason: "promptSizeChanged" };
  }

  const cacheRatio = currentCall.cacheReadTokens / previousCall.cacheReadTokens;
  const evidence = {
    cacheReadTokens: currentCall.cacheReadTokens,
    gapMinutes,
    inputOtherTokens: currentCall.inputOtherTokens,
    interveningGlobalCallCount,
    interveningSessionCallCount,
    model: currentCall.model,
    previousCacheReadTokens: previousCall.cacheReadTokens,
    promptSizeRatio,
  };
  if (cacheRatio >= options.minimumHitCacheRatio) {
    return { kind: "classified", evidence: { ...evidence, classification: "hit" } };
  }

  const tokensRemovedFromCache = previousCall.cacheReadTokens - currentCall.cacheReadTokens;
  const wereRemovedTokensRebilled = tokensRemovedFromCache > 0
    && currentCall.inputOtherTokens >= options.minimumRebilledTokenRatio * tokensRemovedFromCache;
  if (cacheRatio <= options.maximumMissCacheRatio && wereRemovedTokensRebilled) {
    return { kind: "classified", evidence: { ...evidence, classification: "miss" } };
  }
  return { kind: "ambiguous" };
}

function hasStableRequestConfiguration(previousCall: CacheCall, currentCall: CacheCall): boolean {
  return previousCall.systemPromptHash !== null
    && previousCall.systemPromptHash === currentCall.systemPromptHash
    && previousCall.toolsHash !== null
    && previousCall.toolsHash === currentCall.toolsHash;
}

function groupCallsByStream(calls: readonly CacheCall[]): ReadonlyMap<string, readonly CacheCall[]> {
  const streams = new Map<string, CacheCall[]>();
  for (const call of calls) {
    const streamKey = `${call.sessionId}\u0000${call.agentId}\u0000${call.model}`;
    const streamCalls = streams.get(streamKey) ?? [];
    streamCalls.push(call);
    streams.set(streamKey, streamCalls);
  }

  for (const streamCalls of streams.values()) {
    streamCalls.sort(compareCalls);
  }
  return streams;
}

function mapSessionCallPositions(calls: readonly CacheCall[]): ReadonlyMap<string, number> {
  const callsBySession = new Map<string, CacheCall[]>();
  for (const call of calls) {
    const sessionCalls = callsBySession.get(call.sessionId) ?? [];
    sessionCalls.push(call);
    callsBySession.set(call.sessionId, sessionCalls);
  }

  const positions = new Map<string, number>();
  for (const sessionCalls of callsBySession.values()) {
    sessionCalls.sort(compareCalls);
    for (let index = 0; index < sessionCalls.length; index += 1) {
      const call = sessionCalls[index];
      if (call !== undefined) {
        positions.set(call.eventFingerprint, index);
      }
    }
  }
  return positions;
}

function mapCallPositions(calls: readonly CacheCall[]): ReadonlyMap<string, number> {
  const positions = new Map<string, number>();
  const sortedCalls = [...calls].sort(compareCalls);
  for (let index = 0; index < sortedCalls.length; index += 1) {
    const call = sortedCalls[index];
    if (call !== undefined) {
      positions.set(call.eventFingerprint, index);
    }
  }
  return positions;
}

function countInterveningCalls(
  previousCall: CacheCall,
  currentCall: CacheCall,
  positions: ReadonlyMap<string, number>,
): number {
  const previousPosition = positions.get(previousCall.eventFingerprint);
  const currentPosition = positions.get(currentCall.eventFingerprint);
  if (previousPosition === undefined || currentPosition === undefined) {
    return 0;
  }
  return Math.max(0, currentPosition - previousPosition - 1);
}

function countInterveningSessionCalls(
  previousCall: CacheCall,
  currentCall: CacheCall,
  positions: ReadonlyMap<string, number>,
): number {
  const previousPosition = positions.get(previousCall.eventFingerprint);
  const currentPosition = positions.get(currentCall.eventFingerprint);
  if (previousPosition === undefined || currentPosition === undefined) {
    return 0;
  }
  return Math.max(0, currentPosition - previousPosition - 1);
}

function compareCalls(left: CacheCall, right: CacheCall): number {
  return left.requestTimestampMs - right.requestTimestampMs
    || left.usageTimestampMs - right.usageTimestampMs
    || left.eventFingerprint.localeCompare(right.eventFingerprint);
}

function findChangePoint(transitions: readonly ClassifiedTransition[]): CacheChangePoint | null {
  const sortedTransitions = [...transitions].sort((left, right) => left.gapMinutes - right.gapMinutes);
  const lastHitBefore = [...sortedTransitions]
    .reverse()
    .find(({ classification }) => classification === "hit");
  if (lastHitBefore === undefined) {
    return null;
  }
  const firstMissAfter = sortedTransitions.find(({ classification, gapMinutes }) =>
    classification === "miss" && gapMinutes > lastHitBefore.gapMinutes);
  if (firstMissAfter === undefined) {
    return null;
  }

  const before = sortedTransitions.filter(({ gapMinutes }) =>
    gapMinutes <= lastHitBefore.gapMinutes);
  const after = sortedTransitions.filter(({ gapMinutes }) =>
    gapMinutes >= firstMissAfter.gapMinutes);

  return {
    beforeHitCount: before.length - countMisses(before),
    beforeMissCount: countMisses(before),
    estimatedMinutes: (lastHitBefore.gapMinutes + firstMissAfter.gapMinutes) / 2,
    firstMissAfter: stripInternalTransitionFields(firstMissAfter),
    lastHitBefore: stripInternalTransitionFields(lastHitBefore),
    lowerObservedMinutes: lastHitBefore.gapMinutes,
    postCalendarDayCount: new Set(after.map(({ currentRequestTimestampMs }) =>
      new Date(currentRequestTimestampMs).toISOString().slice(0, 10))).size,
    postHitCount: after.length - countMisses(after),
    postMissCount: countMisses(after),
    postSessionCount: new Set(after.map(({ sessionId }) => sessionId)).size,
    postStreamCount: new Set(after.map(({ streamKey }) => streamKey)).size,
    upperObservedMinutes: firstMissAfter.gapMinutes,
  };
}

function stripInternalTransitionFields(
  transition: ClassifiedTransition,
): CacheTransitionEvidence {
  return {
    cacheReadTokens: transition.cacheReadTokens,
    classification: transition.classification,
    gapMinutes: transition.gapMinutes,
    inputOtherTokens: transition.inputOtherTokens,
    interveningGlobalCallCount: transition.interveningGlobalCallCount,
    interveningSessionCallCount: transition.interveningSessionCallCount,
    model: transition.model,
    previousCacheReadTokens: transition.previousCacheReadTokens,
    promptSizeRatio: transition.promptSizeRatio,
  };
}

function countMisses(transitions: readonly CacheTransitionEvidence[]): number {
  return transitions.filter(({ classification }) => classification === "miss").length;
}

function buildGapBands(transitions: readonly CacheTransitionEvidence[]): readonly CacheGapBand[] {
  const definitions = [
    { label: "< 30 min", lower: Number.NEGATIVE_INFINITY, upper: 30 },
    { label: "30–50 min", lower: 30, upper: 50 },
    { label: "50–60 min", lower: 50, upper: 60 },
    { label: "60–75 min", lower: 60, upper: 75 },
    { label: "≥ 75 min", lower: 75, upper: Number.POSITIVE_INFINITY },
  ] as const;

  return definitions.map(({ label, lower, upper }) => {
    const matchingTransitions = transitions.filter(
      ({ gapMinutes }) => gapMinutes >= lower && gapMinutes < upper,
    );
    const missCount = countMisses(matchingTransitions);
    return {
      hitCount: matchingTransitions.length - missCount,
      label,
      missCount,
    };
  });
}

function countCallsByModel(calls: readonly CacheCall[]): Readonly<Record<string, number>> {
  const counts: Record<string, number> = {};
  for (const call of calls) {
    counts[call.model] = (counts[call.model] ?? 0) + 1;
  }
  return counts;
}

function createExclusionCounts(): Record<TransitionExclusion, number> {
  return Object.fromEntries(transitionExclusions.map((reason) => [reason, 0])) as Record<
    TransitionExclusion,
    number
  >;
}

function median(values: readonly number[]): number | null {
  if (values.length === 0) {
    return null;
  }
  const sortedValues = [...values].sort((left, right) => left - right);
  const middleIndex = Math.floor(sortedValues.length / 2);
  const middleValue = sortedValues[middleIndex];
  if (middleValue === undefined) {
    return null;
  }
  if (sortedValues.length % 2 === 1) {
    return middleValue;
  }
  const lowerValue = sortedValues[middleIndex - 1];
  return lowerValue === undefined ? middleValue : (lowerValue + middleValue) / 2;
}

function validateOptions(options: CacheAnalysisOptions): void {
  if (
    options.minimumCacheReadTokens <= 0
    || options.minimumPromptSizeRatio <= 0
    || options.maximumPromptSizeRatio < options.minimumPromptSizeRatio
    || options.minimumHitCacheRatio <= options.maximumMissCacheRatio
    || options.minimumRebilledTokenRatio <= 0
  ) {
    throw new Error("Invalid cache-analysis options.");
  }
}
