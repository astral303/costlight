import type { Database } from "bun:sqlite";
import { MeteredUsageService } from "../metered-usage/service";
import { isProMeteredClaudeModel, modelKeyFromRawModel } from "../pricing/anthropic-catalog";

const ANTHROPIC_PROVIDER = "anthropic";
const KIMI_PROVIDER = "moonshotai";
const CCUSAGE_ENTRY_KEYS = ["daily", "data", "reports"] as const;
const NANO_PER_USD = 1_000_000_000;

export type CcusageRunner = (commandArguments: readonly string[]) => Promise<unknown>;

export interface CcusageAuditResult {
  canonicalCallCount: number;
  ccusageTotalUsd: number;
  differenceUsd: number;
  localTotalUsd: number;
  occurrenceCount: number;
  replayExcludedCount: number;
}

export interface ClaudeCcusageAuditResult extends CcusageAuditResult {
  meteredModels: readonly string[];
  meteringPolicy: string | null;
  subscriptionType: string | null;
  unmeteredModels: readonly string[];
}

export type ProviderAuditReport<TResult> =
  | ({ status: "compared" } & TResult)
  | { reason: string; status: "not-detected" }
  | { error: string; status: "failed" };

/**
 * Adds the case where Claude ran locally but the account policy meters none of it, which is
 * distinct from an absent provider and from a comparison that found no difference.
 */
export type ClaudeAuditReport =
  | ProviderAuditReport<ClaudeCcusageAuditResult>
  | {
    meteringPolicy: string | null;
    reason: string;
    status: "nothing-metered";
    subscriptionType: string | null;
  };

interface MeteredAuditTotals {
  canonical_call_count: number;
  occurrence_count: number;
  total_cost_nano: number;
}

interface ModelCostSplit {
  meteredTotalUsd: number;
  unmeteredModels: readonly string[];
}

export async function auditKimiWithCcusage(
  database: Database,
  runCcusage: CcusageRunner = runCcusageJson,
): Promise<ProviderAuditReport<CcusageAuditResult>> {
  const totals = queryKimiAuditTotals(database);
  if (totals.canonical_call_count === 0) {
    return notDetected(KIMI_PROVIDER);
  }

  try {
    const report = await runCcusage(["ccusage", "kimi", "daily", "--json"]);
    return { status: "compared", ...compareTotals(totals, extractCcusageTotalUsd(report)) };
  } catch (error) {
    return { error: errorMessage(error), status: "failed" };
  }
}

export async function auditClaudeWithCcusage(
  database: Database,
  runCcusage: CcusageRunner = runCcusageJson,
): Promise<ClaudeAuditReport> {
  if (countProviderCalls(database, ANTHROPIC_PROVIDER) === 0) {
    return notDetected(ANTHROPIC_PROVIDER);
  }

  const account = readClaudeAccountPolicy(database);
  const meteredModels = queryMeteredClaudeModelKeys(database);
  if (meteredModels.size === 0) {
    return {
      ...account,
      reason: `Claude calls exist but the ${
        account.meteringPolicy ?? "undetected"
      } account policy meters none of them.`,
      status: "nothing-metered",
    };
  }

  // Only the ccusage call and its parsing belong in the try: a failing local query is a defect,
  // not an audit result, and must not be reported as a ccusage failure.
  const totals = queryClaudeAuditTotals(database);
  try {
    const report = await runCcusage(["ccusage", "claude", "daily", "--json", "--mode", "calculate"]);
    const split = splitCostsByMeteredModel(extractCcusageModelCosts(report), meteredModels);
    return {
      status: "compared",
      ...compareTotals(totals, split.meteredTotalUsd),
      ...account,
      meteredModels: [...meteredModels].sort(),
      unmeteredModels: split.unmeteredModels,
    };
  } catch (error) {
    return { error: errorMessage(error), status: "failed" };
  }
}

export function queryKimiAuditTotals(database: Database): MeteredAuditTotals {
  return queryMeteredAuditTotals(database, KIMI_PROVIDER);
}

export function queryClaudeAuditTotals(database: Database): MeteredAuditTotals {
  return queryMeteredAuditTotals(database, ANTHROPIC_PROVIDER);
}

/**
 * Returns the model keys the ledger actually metered, so the audit mirrors the account policy
 * already applied to stored calls instead of re-deriving it.
 */
export function queryMeteredClaudeModelKeys(database: Database): ReadonlySet<string> {
  const rows = database
    .query<{ raw_model: string }, [string]>(`
      SELECT DISTINCT raw_model FROM api_calls
      WHERE provider = ? AND is_metered = 1
    `)
    .all(ANTHROPIC_PROVIDER);

  return new Set(rows.map((row) => modelKeyFromRawModel(row.raw_model)));
}

export function splitCostsByMeteredModel(
  modelCosts: ReadonlyMap<string, number>,
  meteredModels: ReadonlySet<string>,
): ModelCostSplit {
  let meteredTotalUsd = 0;
  const unmeteredModels: string[] = [];
  for (const [modelKey, cost] of modelCosts) {
    if (meteredModels.has(modelKey)) {
      meteredTotalUsd += cost;
    } else {
      unmeteredModels.push(modelKey);
    }
  }

  return { meteredTotalUsd, unmeteredModels: unmeteredModels.sort() };
}

export function extractCcusageTotalUsd(value: unknown): number {
  if (Array.isArray(value)) {
    return value.reduce((total, item) => total + directTotalCost(item), 0);
  }
  if (!isRecord(value)) {
    throw new Error("ccusage returned an unsupported JSON report.");
  }

  if (isRecord(value.totals) && typeof value.totals.totalCost === "number") {
    return value.totals.totalCost;
  }
  if (typeof value.totalCost === "number") {
    return value.totalCost;
  }
  for (const key of CCUSAGE_ENTRY_KEYS) {
    if (Array.isArray(value[key])) {
      return value[key].reduce((total, item) => total + directTotalCost(item), 0);
    }
  }
  throw new Error("ccusage JSON did not contain a recognizable totalCost value.");
}

export function extractCcusageModelCosts(value: unknown): Map<string, number> {
  const costs = new Map<string, number>();
  for (const entry of ccusageReportEntries(value)) {
    if (!isRecord(entry) || !Array.isArray(entry.modelBreakdowns)) {
      continue;
    }
    for (const breakdown of entry.modelBreakdowns) {
      if (!isRecord(breakdown)) continue;
      const { cost, modelName } = breakdown;
      if (typeof modelName !== "string" || typeof cost !== "number") continue;
      const modelKey = modelKeyFromRawModel(modelName);
      costs.set(modelKey, (costs.get(modelKey) ?? 0) + cost);
    }
  }

  return costs;
}

export async function runCcusageJson(commandArguments: readonly string[]): Promise<unknown> {
  const packageRunnerPath = Bun.which("bunx");
  if (packageRunnerPath === null) {
    throw new Error("bunx is unavailable. Run the audit with the project-pinned Bun toolchain.");
  }

  const auditProcess = Bun.spawn([packageRunnerPath, ...commandArguments], {
    env: { ...process.env, LOG_LEVEL: "0" },
    stderr: "pipe",
    stdout: "pipe",
  });
  const [exitCode, output, errorOutput] = await Promise.all([
    auditProcess.exited,
    new Response(auditProcess.stdout).text(),
    new Response(auditProcess.stderr).text(),
  ]);
  if (exitCode !== 0) {
    throw new Error(`ccusage audit failed with exit code ${exitCode}: ${errorOutput.trim()}`);
  }

  return JSON.parse(output);
}

function queryMeteredAuditTotals(database: Database, provider: string): MeteredAuditTotals {
  return database
    .query<MeteredAuditTotals, [{ provider: string }]>(`
      SELECT
        (
          SELECT COUNT(*) FROM api_calls
          WHERE provider = $provider AND is_metered = 1
        ) AS canonical_call_count,
        (
          SELECT COUNT(*)
          FROM usage_occurrences AS occurrence
          JOIN sessions AS session ON session.session_id = occurrence.session_id
          WHERE session.provider = $provider AND occurrence.is_metered = 1
        ) AS occurrence_count,
        (
          SELECT COALESCE(SUM(total_cost_nano), 0)
          FROM api_calls
          WHERE provider = $provider AND is_metered = 1
        ) AS total_cost_nano
    `)
    .get({ provider })
    ?? { canonical_call_count: 0, occurrence_count: 0, total_cost_nano: 0 };
}

/**
 * Counts every stored call, metered or not. Provider presence must not depend on the metering
 * policy: a Pro account that never used Fable still has Claude installed.
 */
function countProviderCalls(database: Database, provider: string): number {
  return database
    .query<{ call_count: number }, [string]>(
      "SELECT COUNT(*) AS call_count FROM api_calls WHERE provider = ?",
    )
    .get(provider)?.call_count ?? 0;
}

function readClaudeAccountPolicy(
  database: Database,
): { meteringPolicy: string | null; subscriptionType: string | null } {
  const status = new MeteredUsageService(database, {
    isProMeteredModel: isProMeteredClaudeModel,
  }).getClaudeStatus();

  return { meteringPolicy: status.policy, subscriptionType: status.subscriptionType };
}

function compareTotals(totals: MeteredAuditTotals, ccusageTotalUsd: number): CcusageAuditResult {
  const localTotalUsd = totals.total_cost_nano / NANO_PER_USD;
  return {
    canonicalCallCount: totals.canonical_call_count,
    ccusageTotalUsd,
    differenceUsd: localTotalUsd - ccusageTotalUsd,
    localTotalUsd,
    occurrenceCount: totals.occurrence_count,
    replayExcludedCount: totals.occurrence_count - totals.canonical_call_count,
  };
}

function notDetected(provider: string): { reason: string; status: "not-detected" } {
  return { reason: `no ${provider} calls in the ledger`, status: "not-detected" };
}

function ccusageReportEntries(value: unknown): readonly unknown[] {
  if (Array.isArray(value)) {
    return value;
  }
  if (!isRecord(value)) {
    throw new Error("ccusage returned an unsupported JSON report.");
  }
  for (const key of CCUSAGE_ENTRY_KEYS) {
    if (Array.isArray(value[key])) {
      return value[key];
    }
  }
  throw new Error("ccusage JSON did not contain per-model breakdowns.");
}

function directTotalCost(value: unknown): number {
  return isRecord(value) && typeof value.totalCost === "number" ? value.totalCost : 0;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
