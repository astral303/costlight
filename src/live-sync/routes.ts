import type { Database } from "bun:sqlite";
import { APPLICATION_VERSION } from "../app-version/server-version";
import type { PricingCatalog } from "../pricing/catalog";
import type { MeteredUsageService } from "../metered-usage/service";
import type { SessionMonitor } from "../session-import/monitor";
import type { LiveUpdateHub } from "./hub";

const LIVE_EVENTS_PATH = "/api/events";

interface LiveRouteDependencies {
  database: Database;
  hub: LiveUpdateHub;
  meteredUsage: MeteredUsageService;
  monitor: SessionMonitor;
  pricingCatalog: PricingCatalog;
  startedAtMs: number;
}

export function isSSEStreamRequest(request: Request, url: URL): boolean {
  return request.method === "GET" && url.pathname === LIVE_EVENTS_PATH;
}

export function handleLiveRoute(
  request: Request,
  url: URL,
  dependencies: LiveRouteDependencies,
): Response | null {
  if (url.pathname === LIVE_EVENTS_PATH) {
    return request.method === "GET"
      ? dependencies.hub.createEventResponse()
      : methodNotAllowed("GET");
  }
  if (url.pathname !== "/api/health") {
    return null;
  }
  if (request.method !== "GET") {
    return methodNotAllowed("GET");
  }

  const counts = dependencies.database
    .query<{
      call_count: number;
      session_count: number;
      unpriced_call_count: number;
    }, []>(`
      SELECT
        (
          SELECT COUNT(DISTINCT session_id)
          FROM api_calls
          WHERE is_metered = 1
        ) AS session_count,
        (SELECT COUNT(*) FROM api_calls WHERE is_metered = 1) AS call_count,
        (
          SELECT COUNT(*) FROM api_calls
          WHERE is_metered = 1 AND total_cost_nano IS NULL
        ) AS unpriced_call_count
    `)
    .get() ?? { call_count: 0, session_count: 0, unpriced_call_count: 0 };
  const detectedProviders = dependencies.database
    .query<{ provider: string }, []>(`
      SELECT DISTINCT provider
      FROM sessions
      ORDER BY provider
    `)
    .all()
    .map(({ provider }) => provider);
  const ingestion = dependencies.monitor.getStatus();
  const pricingRefresh = dependencies.pricingCatalog.getLastRefreshResults();
  const claudeMetering = dependencies.meteredUsage.getClaudeStatus();
  const warnings = [
    ...(ingestion.lastError === null ? [] : [ingestion.lastError]),
    ...(claudeMetering.error === null
      ? []
      : [`Claude account check: ${claudeMetering.error}`]),
    ...pricingRefresh
      .filter((result) => result.status === "failed")
      .map((result) => `${result.sourceName}: ${result.error ?? "refresh failed"}`),
    ...(counts.unpriced_call_count === 0
      ? []
      : [`${counts.unpriced_call_count} call(s) have no matching price.`]),
  ];

  return Response.json({
    callCount: counts.call_count,
    dataVersion: dependencies.hub.getDataVersion(),
    detectedProviders,
    ingestion,
    metering: {
      claude: claudeMetering,
    },
    pricing: {
      lastRefresh: pricingRefresh,
      providers: dependencies.pricingCatalog.getProviderPricingStatuses(),
    },
    sessionCount: counts.session_count,
    startedAtMs: dependencies.startedAtMs,
    status: warnings.length === 0 ? "ok" : "warning",
    version: APPLICATION_VERSION,
    warnings,
  });
}

function methodNotAllowed(allowedMethod: string): Response {
  return Response.json(
    { error: "Method not allowed" },
    { status: 405, headers: { Allow: allowedMethod } },
  );
}
