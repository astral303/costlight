import { z } from "zod";
import { assertValidTimeZone } from "./bucketing";
import type { DashboardFilters } from "./contracts";

const optionalTimestamp = z.string().regex(/^\d+$/).transform(Number).optional();

const querySchema = z.object({
  agentId: z.string().min(1).optional(),
  agentType: z.enum(["main", "sub", "unknown"]).optional(),
  bucket: z.enum(["auto", "minute", "hour", "day", "week"]).default("auto"),
  from: optionalTimestamp,
  model: z.string().min(1).optional(),
  session: z.string().min(1).optional(),
  sort: z.enum(["cost", "recent", "start"]).default("cost"),
  timeZone: z.string().min(1).default(Intl.DateTimeFormat().resolvedOptions().timeZone),
  to: optionalTimestamp,
  workspace: z.string().min(1).optional(),
});

export function parseDashboardFilters(url: URL): DashboardFilters {
  const parsed = querySchema.parse(Object.fromEntries(url.searchParams));
  if (parsed.from !== undefined && parsed.to !== undefined && parsed.from > parsed.to) {
    throw new Error("The from timestamp must not be later than the to timestamp.");
  }

  return {
    ...(parsed.agentId === undefined ? {} : { agentId: parsed.agentId }),
    ...(parsed.agentType === undefined ? {} : { agentType: parsed.agentType }),
    bucket: parsed.bucket,
    ...(parsed.from === undefined ? {} : { fromMs: parsed.from }),
    ...(parsed.model === undefined ? {} : { model: parsed.model }),
    ...(parsed.session === undefined ? {} : { sessionId: parsed.session }),
    sessionSort: parsed.sort,
    timeZone: assertValidTimeZone(parsed.timeZone),
    ...(parsed.to === undefined ? {} : { toMs: parsed.to }),
    ...(parsed.workspace === undefined ? {} : { workspace: parsed.workspace }),
  };
}
