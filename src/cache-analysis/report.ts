import type { ImportSummary } from "../session-import/importer";
import type { LoadedCacheCalls } from "./call-loader";
import type { CacheWindowAnalysis } from "./analyzer";

export interface CacheAnalysisReportInput {
  generatedAt: Date;
  importSummary: ImportSummary;
  loadedCalls: LoadedCacheCalls;
  primary: CacheWindowAnalysis;
  sensitivity: readonly CacheWindowAnalysis[];
}

export function formatCacheAnalysisReport(input: CacheAnalysisReportInput): string {
  const { changePoint } = input.primary;
  const lines = ["# Kimi cache-window analysis", ""];
  if (changePoint === null) {
    lines.push(
      "No defensible cache-duration change point was found in the available logs.",
      "",
    );
  } else {
    lines.push(
      `**Best estimate: ${Math.round(changePoint.estimatedMinutes)} minutes of inactivity.**`,
      "",
      `The closest same-agent observations bracket the transition between ${formatMinutes(changePoint.lowerObservedMinutes)} and ${formatMinutes(changePoint.upperObservedMinutes)} minutes. `
        + "This is a sliding inactivity window: active hit sequences last much longer than one hour.",
      "",
    );
  }

  lines.push(
    "## Evidence",
    "",
    `- Scanned ${formatInteger(input.importSummary.discoveredSessionCount)} sessions and ${formatInteger(input.importSummary.discoveredSourceCount)} wire files into a temporary in-memory ledger.`,
    `- Analyzed ${formatInteger(input.primary.callCount)} canonical Moonshot calls across ${formatInteger(input.primary.streamCount)} session/agent/model streams.`,
    `- Request range: ${formatTimestampRange(input.loadedCalls.firstRequestTimestampMs, input.loadedCalls.lastRequestTimestampMs)}. Models: ${formatModelCounts(input.primary.modelCallCounts)}.`,
    `- Recovered client request-start timestamps for ${formatInteger(input.loadedCalls.requestTimestampCount)} calls; ${formatInteger(input.loadedCalls.usageTimestampFallbackCount)} used the later usage timestamp.`,
    `- Classified ${formatInteger(input.primary.classifiedTransitionCount)} stable, large-prefix transitions: ${formatInteger(input.primary.hitCount)} hits and ${formatInteger(input.primary.missCount)} misses.`,
  );
  if (changePoint !== null) {
    lines.push(
      `- Latest strong same-agent hit: ${formatMinutes(changePoint.lastHitBefore.gapMinutes)} minutes; ${formatInteger(changePoint.lastHitBefore.previousCacheReadTokens)} cached tokens grew to ${formatInteger(changePoint.lastHitBefore.cacheReadTokens)}. ${formatInteger(changePoint.lastHitBefore.interveningGlobalCallCount)} other canonical calls occurred in between.`,
      `- First later miss: ${formatMinutes(changePoint.firstMissAfter.gapMinutes)} minutes; ${formatInteger(changePoint.firstMissAfter.previousCacheReadTokens)} cached tokens fell to ${formatInteger(changePoint.firstMissAfter.cacheReadTokens)}, while ${formatInteger(changePoint.firstMissAfter.inputOtherTokens)} tokens were billed as uncached input.`,
      `- Before the observed boundary: ${formatInteger(changePoint.beforeHitCount)} hits / ${formatInteger(changePoint.beforeMissCount)} incidental misses. After it: ${formatInteger(changePoint.postHitCount)} hits / ${formatInteger(changePoint.postMissCount)} misses.`,
      `- The later misses span ${formatInteger(changePoint.postSessionCount)} sessions, ${formatInteger(changePoint.postStreamCount)} streams, and ${formatInteger(changePoint.postCalendarDayCount)} UTC dates.`,
      `- Longest uninterrupted hit sequence: ${formatMinutes(input.primary.longestHitRunMinutes)} minutes across ${formatInteger(input.primary.longestHitRunTransitionCount)} requests.`,
    );
    const rateDiagnostic = formatRateDiagnostic(changePoint);
    if (rateDiagnostic !== null) {
      lines.push(`- ${rateDiagnostic}`);
    }
  }
  if (input.primary.sessionIdleChangePoint !== null) {
    const idleChangePoint = input.primary.sessionIdleChangePoint;
    lines.push(
      `- Conservative session-idle bracket: ${formatMinutes(idleChangePoint.lowerObservedMinutes)}–${formatMinutes(idleChangePoint.upperObservedMinutes)} minutes when no other agent in the session made an intervening call.`,
    );
  }
  if (input.primary.accountIdleChangePoint !== null) {
    const idleChangePoint = input.primary.accountIdleChangePoint;
    lines.push(
      `- Strongest account-idle bracket: ${formatMinutes(idleChangePoint.lowerObservedMinutes)}–${formatMinutes(idleChangePoint.upperObservedMinutes)} minutes with no intervening call anywhere in the scanned logs.`,
    );
  }

  lines.push(
    "",
    "## Gap distribution",
    "",
    "| Request-start gap | Hits | Misses | Miss rate |",
    "|---|---:|---:|---:|",
  );
  for (const band of input.primary.gapBands) {
    const total = band.hitCount + band.missCount;
    const missRate = total === 0 ? "—" : formatPercent(band.missCount / total);
    lines.push(
      `| ${band.label} | ${formatInteger(band.hitCount)} | ${formatInteger(band.missCount)} | ${missRate} |`,
    );
  }

  lines.push(
    "",
    "## Sensitivity to the large-prefix cutoff",
    "",
    "| Minimum prior cached tokens | Observed interval | Midpoint |",
    "|---:|---:|---:|",
  );
  for (const analysis of input.sensitivity) {
    const sensitivityChangePoint = analysis.changePoint;
    lines.push(sensitivityChangePoint === null
      ? `| ${formatInteger(analysis.options.minimumCacheReadTokens)} | no estimate | — |`
      : `| ${formatInteger(analysis.options.minimumCacheReadTokens)} | ${formatMinutes(sensitivityChangePoint.lowerObservedMinutes)}–${formatMinutes(sensitivityChangePoint.upperObservedMinutes)} min | ${formatMinutes(sensitivityChangePoint.estimatedMinutes)} min |`);
  }

  lines.push(
    "",
    "## Interpretation limits",
    "",
    "- A cache miss is identified by token conservation: a large cached prefix disappears while nearly the same tokens reappear as uncached input.",
    "- Prompt-size changes, decreasing message counts, and changed system/tool hashes are excluded so compaction and cache-key changes do not masquerade as expiry.",
    "- Rare early misses are treated as eviction or routing noise. The lower bound is the latest strong hit, not the first observed miss.",
    "- Calls from sibling agents may refresh a shared conversation prefix. The session-idle and account-idle brackets exclude those intervals progressively.",
    `- Even clear misses retain a shared prefix (median ${formatNullableInteger(input.primary.cacheReadAfterMissMedian)} cached tokens), so testing for zero cached tokens would miss expirations.`,
    "",
    `Generated ${input.generatedAt.toISOString()}. No prompt, response, tool argument, or tool output was retained by this analysis.`,
  );
  return `${lines.join("\n")}\n`;
}

function formatInteger(value: number): string {
  return Math.round(value).toLocaleString("en-US");
}

function formatNullableInteger(value: number | null): string {
  return value === null ? "unknown" : formatInteger(value);
}

function formatMinutes(value: number): string {
  return value.toFixed(2);
}

function formatPercent(value: number): string {
  return `${(value * 100).toFixed(1)}%`;
}

function formatTimestampRange(firstTimestampMs: number | null, lastTimestampMs: number | null): string {
  if (firstTimestampMs === null || lastTimestampMs === null) {
    return "unknown";
  }
  return `${new Date(firstTimestampMs).toISOString()} to ${new Date(lastTimestampMs).toISOString()}`;
}

function formatModelCounts(modelCallCounts: Readonly<Record<string, number>>): string {
  return Object.entries(modelCallCounts)
    .sort((left, right) => right[1] - left[1])
    .map(([model, count]) => `${model} (${formatInteger(count)})`)
    .join(", ");
}

function formatRateDiagnostic(changePoint: NonNullable<CacheWindowAnalysis["changePoint"]>): string | null {
  const beforeCount = changePoint.beforeHitCount + changePoint.beforeMissCount;
  if (
    beforeCount === 0
    || changePoint.beforeMissCount === 0
    || changePoint.postHitCount > 0
    || changePoint.postMissCount === 0
  ) {
    return null;
  }

  const backgroundMissRate = changePoint.beforeMissCount / beforeCount;
  const log10Probability = changePoint.postMissCount * Math.log10(backgroundMissRate);
  return `The incidental miss rate before the boundary was ${formatPercent(backgroundMissRate)}. At that rate, ${formatInteger(changePoint.postMissCount)} consecutive later misses have a nominal probability around 10^${Math.round(log10Probability)} (a diagnostic, not a preregistered p-value).`;
}
