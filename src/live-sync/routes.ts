import type { Database } from "bun:sqlite";
import type { PricingCatalog } from "../pricing/catalog";
import type { SessionMonitor } from "../session-import/monitor";
import type { LiveUpdateHub } from "./hub";

interface LiveRouteDependencies {
  database: Database;
  hub: LiveUpdateHub;
  monitor: SessionMonitor;
  pricingCatalog: PricingCatalog;
  startedAtMs: number;
}

export function handleLiveRoute(
  request: Request,
  url: URL,
  dependencies: LiveRouteDependencies,
): Response | null {
  if (url.pathname === "/api/events") {
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
        (SELECT COUNT(*) FROM sessions) AS session_count,
        (SELECT COUNT(*) FROM api_calls) AS call_count,
        (SELECT COUNT(*) FROM api_calls WHERE total_cost_nano IS NULL) AS unpriced_call_count
    `)
    .get() ?? { call_count: 0, session_count: 0, unpriced_call_count: 0 };
  const ingestion = dependencies.monitor.getStatus();
  const pricingRefresh = dependencies.pricingCatalog.getLastRefreshResults();
  const warnings = [
    ...(ingestion.lastError === null ? [] : [ingestion.lastError]),
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
    ingestion,
    pricing: {
      lastRefresh: pricingRefresh,
      newestSnapshotMs: dependencies.pricingCatalog.getNewestSnapshotTimestamp(),
    },
    sessionCount: counts.session_count,
    startedAtMs: dependencies.startedAtMs,
    status: warnings.length === 0 ? "ok" : "warning",
    version: "0.1.0",
    warnings,
  });
}

function methodNotAllowed(allowedMethod: string): Response {
  return Response.json(
    { error: "Method not allowed" },
    { status: 405, headers: { Allow: allowedMethod } },
  );
}
