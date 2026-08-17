import type { Database } from "bun:sqlite";
import { zonedDayKey } from "../dashboard/bucketing";
import {
  type ClaudeAccountPolicy,
  describeUnmeteredAccount,
  readClaudeAccountPolicy,
} from "../metered-usage/claude-account-policy";
import { modelKeyFromRawModel } from "../pricing/anthropic-catalog";
import type { AnthropicUsageReport, UsageDayTotals, UsageTotals } from "./anthropic-usage-report";

const ANTHROPIC_PROVIDER = "anthropic";
const NANO_PER_USD = 1_000_000_000;
const COST_DECIMAL_PLACES = 4;
const CSV_KEY_COLUMNS = ["date", "model"] as const;
// Both tables keep each heading next to the value it prints, so no layout can let the two drift.
const CSV_SOURCE_COLUMNS: readonly CsvSourceColumn[] = [
  { name: "anthropic", read: (row) => row.anthropic },
  { name: "costlight", read: (row) => row.costlight },
  { name: "difference", read: (row) => subtractTotals(row.costlight, row.anthropic) },
];
const CSV_MEASURE_COLUMNS: readonly CsvMeasureColumn[] = [
  { format: (totals) => totals.costUsd.toFixed(COST_DECIMAL_PLACES), name: "cost_usd" },
  { format: (totals) => totals.requestCount, name: "requests" },
  { format: (totals) => totals.tokens.input, name: "input" },
  { format: (totals) => totals.tokens.output, name: "output" },
  { format: (totals) => totals.tokens.cacheRead, name: "cache_read" },
  { format: (totals) => totals.tokens.cacheWrite5m, name: "cache_write_5m" },
  { format: (totals) => totals.tokens.cacheWrite1h, name: "cache_write_1h" },
  { format: (totals) => totals.tokens.cacheWriteUntyped, name: "cache_write_untyped" },
];

/**
 * `long` writes one row per source, which pivot tables and plotting tools expect. `wide` puts the
 * three sources side by side per measure, which reads better when scanning for a deviation.
 */
export type CsvLayout = "long" | "wide";

export interface UsageComparisonRow {
  anthropic: UsageTotals;
  costlight: UsageTotals;
  date: string;
  modelKey: string;
}

export interface ModelDeviation {
  anthropicUsd: number;
  costlightUsd: number;
  differenceUsd: number;
  modelKey: string;
}

export interface CostComparison {
  anthropicUsd: number;
  costlightUsd: number;
  differencePercent: number | null;
  differenceUsd: number;
}

export interface ComparedRange {
  endDate: string;
  startDate: string;
  timeZone: string;
}

/**
 * The two ways the ledger falls short of the bill without any single day looking wrong: calls the
 * account policy never metered, and metered calls no rate could price.
 */
export interface LedgerGaps {
  unmeteredCallCount: number;
  unpricedCallCount: number;
}

export interface ClaudeUsageAuditSummary {
  account: ClaudeAccountPolicy;
  ledgerGaps: LedgerGaps;
  modelDeviations: readonly ModelDeviation[];
  range: ComparedRange;
  requestCounts: { anthropic: number; costlight: number };
  totals: CostComparison;
}

export type ClaudeUsageAuditReport =
  | { rows: readonly UsageComparisonRow[]; status: "compared"; summary: ClaudeUsageAuditSummary }
  | { reason: string; status: "not-detected" }
  | ({ reason: string; status: "nothing-metered" } & ClaudeAccountPolicy);

interface CsvMeasureColumn {
  format: (totals: UsageTotals) => number | string;
  name: string;
}

interface CsvSourceColumn {
  name: string;
  read: (row: UsageComparisonRow) => UsageTotals;
}

interface LedgerCallRow {
  cache_creation_1h_tokens: number;
  cache_creation_5m_tokens: number;
  cache_creation_tokens: number;
  cache_read_tokens: number;
  input_other_tokens: number;
  is_metered: number;
  model_key: string;
  output_tokens: number;
  timestamp_ms: number;
  total_cost_nano: number | null;
}

interface LedgerAggregate {
  gaps: LedgerGaps;
  totalsByDayModel: ReadonlyMap<string, UsageDayTotals>;
}

/**
 * Compares metered Claude calls against a usage export downloaded from Anthropic's web UI.
 * Unlike the ccusage audit this reads Costlight's own per-call rows, so metering is filtered
 * per call rather than per model and a mid-range policy change stays correctly split.
 */
export function auditClaudeAgainstUsageReport(
  database: Database,
  report: AnthropicUsageReport,
  timeZone: string,
): ClaudeUsageAuditReport {
  const calls = queryClaudeCalls(database);
  if (calls.length === 0) {
    return { reason: `no ${ANTHROPIC_PROVIDER} calls in the ledger`, status: "not-detected" };
  }

  const account = readClaudeAccountPolicy(database);
  if (calls.every((call) => call.is_metered === 0)) {
    return { ...account, reason: describeUnmeteredAccount(account), status: "nothing-metered" };
  }

  const range: ComparedRange = { endDate: report.endDate, startDate: report.startDate, timeZone };
  const ledger = aggregateMeteredCalls(calls, range);
  const rows = buildComparisonRows(report.days, ledger.totalsByDayModel);
  const anthropic = sumTotals(rows.map((row) => row.anthropic));
  const costlight = sumTotals(rows.map((row) => row.costlight));
  return {
    rows,
    status: "compared",
    summary: {
      account,
      ledgerGaps: ledger.gaps,
      modelDeviations: summarizeModelDeviations(rows),
      range,
      requestCounts: { anthropic: anthropic.requestCount, costlight: costlight.requestCount },
      totals: compareCosts(anthropic.costUsd, costlight.costUsd),
    },
  };
}

/** Emits Anthropic's figure, Costlight's figure, and their difference for each day and model. */
export function formatUsageComparisonCsv(
  rows: readonly UsageComparisonRow[],
  layout: CsvLayout,
): string {
  return layout === "wide" ? formatWideCsv(rows) : formatLongCsv(rows);
}

/**
 * Loads every Claude call instead of bounding the range in SQL: an export day is a calendar day in
 * the reporting zone, which a `timestamp_ms` comparison cannot express across a DST change.
 */
function queryClaudeCalls(database: Database): readonly LedgerCallRow[] {
  return database
    .query<LedgerCallRow, [string]>(`
      SELECT timestamp_ms, is_metered, total_cost_nano,
             COALESCE(resolved_model_key, raw_model) AS model_key,
             input_other_tokens, output_tokens, cache_read_tokens,
             cache_creation_tokens, cache_creation_5m_tokens, cache_creation_1h_tokens
      FROM api_calls
      WHERE provider = ?
    `)
    .all(ANTHROPIC_PROVIDER);
}

function aggregateMeteredCalls(
  calls: readonly LedgerCallRow[],
  range: ComparedRange,
): LedgerAggregate {
  const totalsByDayModel = new Map<string, UsageDayTotals>();
  const gaps: LedgerGaps = { unmeteredCallCount: 0, unpricedCallCount: 0 };
  for (const call of calls) {
    const date = zonedDayKey(call.timestamp_ms, range.timeZone);
    if (date < range.startDate || date > range.endDate) {
      continue;
    }
    if (call.is_metered === 0) {
      gaps.unmeteredCallCount += 1;
      continue;
    }
    if (call.total_cost_nano === null) {
      gaps.unpricedCallCount += 1;
    }
    accumulateDay(totalsByDayModel, {
      ...callTotals(call),
      date,
      modelKey: modelKeyFromRawModel(call.model_key),
    });
  }

  return { gaps, totalsByDayModel };
}

function buildComparisonRows(
  anthropicDays: readonly UsageDayTotals[],
  costlightDaysByKey: ReadonlyMap<string, UsageDayTotals>,
): readonly UsageComparisonRow[] {
  const anthropicDaysByKey = new Map<string, UsageDayTotals>();
  for (const day of anthropicDays) {
    accumulateDay(anthropicDaysByKey, day);
  }

  // Either side alone identifies the day and model, so the union covers a model that only one
  // side recorded instead of dropping it.
  const comparedDays = new Map([...costlightDaysByKey, ...anthropicDaysByKey]);
  return [...comparedDays]
    .map(([key, day]) => ({
      anthropic: anthropicDaysByKey.get(key) ?? emptyTotals(),
      costlight: costlightDaysByKey.get(key) ?? emptyTotals(),
      date: day.date,
      modelKey: day.modelKey,
    }))
    .sort((left, right) =>
      left.date.localeCompare(right.date) || left.modelKey.localeCompare(right.modelKey)
    );
}

function summarizeModelDeviations(rows: readonly UsageComparisonRow[]): readonly ModelDeviation[] {
  const costsByModel = new Map<string, { anthropicUsd: number; costlightUsd: number }>();
  for (const row of rows) {
    const costs = costsByModel.get(row.modelKey) ?? { anthropicUsd: 0, costlightUsd: 0 };
    costsByModel.set(row.modelKey, {
      anthropicUsd: costs.anthropicUsd + row.anthropic.costUsd,
      costlightUsd: costs.costlightUsd + row.costlight.costUsd,
    });
  }

  return [...costsByModel]
    .map(([modelKey, costs]) => ({
      ...costs,
      differenceUsd: costs.costlightUsd - costs.anthropicUsd,
      modelKey,
    }))
    .sort((left, right) => Math.abs(right.differenceUsd) - Math.abs(left.differenceUsd));
}

function compareCosts(anthropicUsd: number, costlightUsd: number): CostComparison {
  const differenceUsd = costlightUsd - anthropicUsd;
  return {
    anthropicUsd,
    costlightUsd,
    differencePercent: anthropicUsd === 0 ? null : (differenceUsd / anthropicUsd) * 100,
    differenceUsd,
  };
}

function accumulateDay(totalsByDayModel: Map<string, UsageDayTotals>, day: UsageDayTotals): void {
  const key = dayModelKey(day.date, day.modelKey);
  const recorded = totalsByDayModel.get(key);
  totalsByDayModel.set(key, recorded === undefined ? day : { ...day, ...addTotals(recorded, day) });
}

/** Dates are fixed-width, so one separator cannot merge two different day-and-model pairs. */
function dayModelKey(date: string, modelKey: string): string {
  return `${date} ${modelKey}`;
}

function callTotals(call: LedgerCallRow): UsageTotals {
  return {
    costUsd: (call.total_cost_nano ?? 0) / NANO_PER_USD,
    requestCount: 1,
    tokens: {
      cacheRead: call.cache_read_tokens,
      cacheWrite1h: call.cache_creation_1h_tokens,
      cacheWrite5m: call.cache_creation_5m_tokens,
      // Cache writes the transcript reported without a TTL; the parser stores them apart from
      // the 5m and 1h counts, and Anthropic's export has no matching bucket.
      cacheWriteUntyped: call.cache_creation_tokens,
      input: call.input_other_tokens,
      output: call.output_tokens,
    },
  };
}

function sumTotals(totals: readonly UsageTotals[]): UsageTotals {
  return totals.reduce<UsageTotals>(addTotals, emptyTotals());
}

function addTotals(left: UsageTotals, right: UsageTotals): UsageTotals {
  return combineTotals(left, right, (leftValue, rightValue) => leftValue + rightValue);
}

function subtractTotals(left: UsageTotals, right: UsageTotals): UsageTotals {
  return combineTotals(left, right, (leftValue, rightValue) => leftValue - rightValue);
}

function combineTotals(
  left: UsageTotals,
  right: UsageTotals,
  combine: (leftValue: number, rightValue: number) => number,
): UsageTotals {
  return {
    costUsd: combine(left.costUsd, right.costUsd),
    requestCount: combine(left.requestCount, right.requestCount),
    tokens: {
      cacheRead: combine(left.tokens.cacheRead, right.tokens.cacheRead),
      cacheWrite1h: combine(left.tokens.cacheWrite1h, right.tokens.cacheWrite1h),
      cacheWrite5m: combine(left.tokens.cacheWrite5m, right.tokens.cacheWrite5m),
      cacheWriteUntyped: combine(left.tokens.cacheWriteUntyped, right.tokens.cacheWriteUntyped),
      input: combine(left.tokens.input, right.tokens.input),
      output: combine(left.tokens.output, right.tokens.output),
    },
  };
}

function emptyTotals(): UsageTotals {
  return {
    costUsd: 0,
    requestCount: 0,
    tokens: {
      cacheRead: 0,
      cacheWrite1h: 0,
      cacheWrite5m: 0,
      cacheWriteUntyped: 0,
      input: 0,
      output: 0,
    },
  };
}

function formatLongCsv(rows: readonly UsageComparisonRow[]): string {
  const headings = [
    ...CSV_KEY_COLUMNS,
    "source",
    ...CSV_MEASURE_COLUMNS.map((column) => column.name),
  ];
  const lines = [headings.join(",")];
  for (const row of rows) {
    for (const source of CSV_SOURCE_COLUMNS) {
      const totals = source.read(row);
      lines.push([
        ...keyFields(row),
        source.name,
        ...CSV_MEASURE_COLUMNS.map((column) => column.format(totals)),
      ].join(","));
    }
  }

  return csvText(lines);
}

/** Headings and cells walk the measure and source tables in the same order, so they stay aligned. */
function formatWideCsv(rows: readonly UsageComparisonRow[]): string {
  const headings = [
    ...CSV_KEY_COLUMNS,
    ...CSV_MEASURE_COLUMNS.flatMap((column) =>
      CSV_SOURCE_COLUMNS.map((source) => `${source.name}.${column.name}`)
    ),
  ];
  const lines = [headings.join(",")];
  for (const row of rows) {
    const totalsPerSource = CSV_SOURCE_COLUMNS.map((source) => source.read(row));
    lines.push([
      ...keyFields(row),
      ...CSV_MEASURE_COLUMNS.flatMap((column) =>
        totalsPerSource.map((totals) => column.format(totals))
      ),
    ].join(","));
  }

  return csvText(lines);
}

function keyFields(row: UsageComparisonRow): readonly string[] {
  return [csvField(row.date), csvField(row.modelKey)];
}

function csvText(lines: readonly string[]): string {
  return `${lines.join("\n")}\n`;
}

function csvField(value: string): string {
  return /["\n,]/.test(value) ? `"${value.replaceAll('"', '""')}"` : value;
}
