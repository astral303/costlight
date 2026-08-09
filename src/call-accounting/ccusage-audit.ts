import type { Database } from "bun:sqlite";

export interface CcusageAuditResult {
  canonicalCallCount: number;
  ccusageTotalUsd: number;
  differenceUsd: number;
  localTotalUsd: number;
  occurrenceCount: number;
  replayExcludedCount: number;
}

export async function auditWithCcusage(database: Database): Promise<CcusageAuditResult> {
  const packageRunnerPath = Bun.which("bunx");
  if (packageRunnerPath === null) {
    throw new Error("bunx is unavailable. Run the audit with the project-pinned Bun toolchain.");
  }

  const auditProcess = Bun.spawn([packageRunnerPath, "ccusage", "kimi", "daily", "--json"], {
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

  const ccusageTotalUsd = extractCcusageTotalUsd(JSON.parse(output));
  const local = database
    .query<{
      canonical_call_count: number;
      occurrence_count: number;
      total_cost_nano: number;
    }, []>(`
      SELECT
        (SELECT COUNT(*) FROM api_calls) AS canonical_call_count,
        (SELECT COUNT(*) FROM usage_occurrences) AS occurrence_count,
        (SELECT COALESCE(SUM(total_cost_nano), 0) FROM api_calls) AS total_cost_nano
    `)
    .get() ?? { canonical_call_count: 0, occurrence_count: 0, total_cost_nano: 0 };
  const localTotalUsd = local.total_cost_nano / 1_000_000_000;
  return {
    canonicalCallCount: local.canonical_call_count,
    ccusageTotalUsd,
    differenceUsd: localTotalUsd - ccusageTotalUsd,
    localTotalUsd,
    occurrenceCount: local.occurrence_count,
    replayExcludedCount: local.occurrence_count - local.canonical_call_count,
  };
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
  for (const key of ["daily", "data", "reports"]) {
    if (Array.isArray(value[key])) {
      return value[key].reduce((total, item) => total + directTotalCost(item), 0);
    }
  }
  throw new Error("ccusage JSON did not contain a recognizable totalCost value.");
}

function directTotalCost(value: unknown): number {
  return isRecord(value) && typeof value.totalCost === "number" ? value.totalCost : 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
