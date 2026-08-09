import type { Database } from "bun:sqlite";
import { ZodError } from "zod";
import { parseDashboardFilters } from "./filters";
import {
  queryAgents,
  queryFilterOptions,
  queryModels,
  querySessions,
  querySummary,
  queryTimeseries,
} from "./queries";

interface DashboardRouteOptions {
  database: Database;
  privacyMode: boolean;
}

export function handleDashboardRoute(
  request: Request,
  url: URL,
  options: DashboardRouteOptions,
): Response | null {
  if (!url.pathname.startsWith("/api/")) {
    return null;
  }
  if (request.method !== "GET") {
    return null;
  }

  let filters;
  try {
    filters = parseDashboardFilters(url);
  } catch (error) {
    if (error instanceof ZodError || error instanceof Error) {
      return Response.json({ error: error.message }, { status: 400 });
    }
    throw error;
  }

  if (url.pathname === "/api/summary") {
    return Response.json(querySummary(options.database, filters));
  }
  if (url.pathname === "/api/timeseries") {
    return Response.json(queryTimeseries(options.database, filters));
  }
  if (url.pathname === "/api/sessions") {
    return Response.json({ sessions: querySessions(options.database, filters, options.privacyMode) });
  }
  if (url.pathname === "/api/models") {
    return Response.json({ models: queryModels(options.database, filters) });
  }
  if (url.pathname === "/api/options") {
    return Response.json(queryFilterOptions(options.database, options.privacyMode));
  }

  const agentPathMatch = /^\/api\/sessions\/([^/]+)\/agents$/.exec(url.pathname);
  if (agentPathMatch?.[1] !== undefined) {
    return Response.json({
      agents: queryAgents(options.database, decodeURIComponent(agentPathMatch[1]), filters),
    });
  }

  return null;
}
