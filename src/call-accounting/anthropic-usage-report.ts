import { z } from "zod";

const MINOR_UNITS_PER_USD = 100;

const isoDateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "expected a YYYY-MM-DD date");

const usageSeriesEntrySchema = z.object({
  bucket: isoDateSchema,
  cost_minor_units: z.number().nonnegative(),
  group_key: z.string().min(1),
  request_count: z.number().int().nonnegative(),
  tokens: z.object({
    cache_read: z.number().int().nonnegative(),
    cache_write_1h: z.number().int().nonnegative(),
    cache_write_5m: z.number().int().nonnegative(),
    input: z.number().int().nonnegative(),
    output: z.number().int().nonnegative(),
  }),
});

const usageReportSchema = z.object({
  currency: z.literal("usd"),
  end_date: isoDateSchema,
  granularity: z.literal("daily"),
  group_by: z.literal("model_tier"),
  series: z.array(usageSeriesEntrySchema),
  start_date: isoDateSchema,
});

export interface UsageTokens {
  cacheRead: number;
  cacheWrite1h: number;
  cacheWrite5m: number;
  cacheWriteUntyped: number;
  input: number;
  output: number;
}

export interface UsageTotals {
  costUsd: number;
  requestCount: number;
  tokens: UsageTokens;
}

export interface UsageDayTotals extends UsageTotals {
  date: string;
  modelKey: string;
}

export interface AnthropicUsageReport {
  days: readonly UsageDayTotals[];
  endDate: string;
  startDate: string;
}

/**
 * Reads the usage export downloaded from Anthropic's web UI. The literal `granularity`,
 * `group_by`, and `currency` checks reject an export taken at another grouping, where the
 * buckets would silently fail to line up with a daily per-model comparison.
 */
export function parseAnthropicUsageReport(value: unknown): AnthropicUsageReport {
  const parsed = usageReportSchema.safeParse(value);
  if (!parsed.success) {
    throw new Error(
      `Not a daily model-tier usage export in USD: ${describeParseIssues(parsed.error)}`,
    );
  }

  return {
    days: parsed.data.series.map((entry) => ({
      costUsd: entry.cost_minor_units / MINOR_UNITS_PER_USD,
      date: entry.bucket,
      modelKey: modelKeyFromGroupKey(entry.group_key),
      requestCount: entry.request_count,
      tokens: {
        cacheRead: entry.tokens.cache_read,
        cacheWrite1h: entry.tokens.cache_write_1h,
        cacheWrite5m: entry.tokens.cache_write_5m,
        // The export always splits cache writes by TTL. The field exists so that a Costlight
        // call whose transcript carried no TTL split stays visible on the other side.
        cacheWriteUntyped: 0,
        input: entry.tokens.input,
        output: entry.tokens.output,
      },
    })),
    endDate: parsed.data.end_date,
    startDate: parsed.data.start_date,
  };
}

/** The export writes model keys with underscores, as in `claude_opus_4_8`. */
function modelKeyFromGroupKey(groupKey: string): string {
  return groupKey.replaceAll("_", "-");
}

function describeParseIssues(error: z.ZodError): string {
  return error.issues
    .map((issue) => `${issue.path.join(".") || "<root>"}: ${issue.message}`)
    .join("; ");
}
