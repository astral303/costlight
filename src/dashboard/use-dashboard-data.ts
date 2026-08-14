import { useEffect, useMemo, useState } from "react";
import { useLiveVersion } from "../live-sync/use-live-version";
import type {
  BucketSize,
  FilterOptionsResponse,
  ModelRow,
  SessionRow,
  SummaryResponse,
  TimeseriesResponse,
} from "./contracts";

export interface DashboardViewFilters {
  agentId: string;
  agentType: "" | "main" | "sub" | "unknown";
  bucket: "auto" | BucketSize;
  model: string;
  provider: string;
  range: "all" | "today" | "7d" | "30d";
  sessionId: string;
  sessionSort: "cost" | "recent" | "start";
  workspace: string;
}

export const initialDashboardFilters: DashboardViewFilters = {
  agentId: "",
  agentType: "",
  bucket: "auto",
  model: "",
  provider: "",
  range: "all",
  sessionId: "",
  sessionSort: "cost",
  workspace: "",
};

interface HealthResponse {
  dataVersion: number;
  ingestion: {
    isScanning: boolean;
    lastSuccessfulScanMs: number | null;
    watcherStatus: string;
  };
  metering: {
    claude: {
      detectedAtMs: number | null;
      error: string | null;
      lastAttemptAtMs: number | null;
      lastSuccessAtMs: number | null;
      policy: "enterprise-api" | "pro-fable" | "subscription-excluded" | null;
      subscriptionType: string | null;
    };
  };
  pricing: {
    providers: readonly {
      error: string | null;
      hasOverrides: boolean;
      isStale: boolean;
      provider: "anthropic" | "moonshotai";
      refreshStatus: "failed" | "not-attempted" | "partial-failure" | "succeeded";
      sourceKind: "bundled" | "remote";
      sourceName: string;
      updatedAtMs: number | null;
    }[];
  };
  status: "ok" | "warning";
  warnings: readonly string[];
}

interface DashboardDataState {
  error: string | null;
  health: HealthResponse | null;
  isLoading: boolean;
  models: readonly ModelRow[];
  options: FilterOptionsResponse;
  sessions: readonly SessionRow[];
  summary: SummaryResponse | null;
  timeseries: TimeseriesResponse | null;
}

const emptyOptions: FilterOptionsResponse = {
  agents: [],
  models: [],
  providers: [],
  sessions: [],
  workspaces: [],
};

export function useDashboardData(filters: DashboardViewFilters) {
  const liveConnection = useLiveVersion();
  const [manualVersion, setManualVersion] = useState(0);
  const [isActionRunning, setIsActionRunning] = useState(false);
  const [state, setState] = useState<DashboardDataState>({
    error: null,
    health: null,
    isLoading: true,
    models: [],
    options: emptyOptions,
    sessions: [],
    summary: null,
    timeseries: null,
  });
  const queryString = useMemo(() => createQueryString(filters), [filters]);

  useEffect(() => {
    const abortController = new AbortController();
    setState((current) => ({ ...current, error: null, isLoading: current.summary === null }));
    void Promise.all([
      fetchJson<SummaryResponse>(`/api/summary?${queryString}`, abortController.signal),
      fetchJson<TimeseriesResponse>(`/api/timeseries?${queryString}`, abortController.signal),
      fetchJson<{ sessions: readonly SessionRow[] }>(`/api/sessions?${queryString}`, abortController.signal),
      fetchJson<{ models: readonly ModelRow[] }>(`/api/models?${queryString}`, abortController.signal),
      fetchJson<FilterOptionsResponse>("/api/options", abortController.signal),
      fetchJson<HealthResponse>("/api/health", abortController.signal),
    ]).then(([summary, timeseries, sessions, models, options, health]) => {
      setState({
        error: null,
        health,
        isLoading: false,
        models: models.models,
        options,
        sessions: sessions.sessions,
        summary,
        timeseries,
      });
    }).catch((error: unknown) => {
      if (!abortController.signal.aborted) {
        setState((current) => ({ ...current, error: errorMessage(error), isLoading: false }));
      }
    });
    return () => abortController.abort();
  }, [liveConnection.dataVersion, manualVersion, queryString]);

  async function runAction(path: string): Promise<void> {
    setIsActionRunning(true);
    try {
      const response = await fetch(path, { method: "POST" });
      if (!response.ok) {
        throw new Error(await readError(response));
      }
      setManualVersion((version) => version + 1);
    } catch (error) {
      setState((current) => ({ ...current, error: errorMessage(error) }));
    } finally {
      setIsActionRunning(false);
    }
  }

  return {
    ...state,
    dataVersion: liveConnection.dataVersion,
    isActionRunning,
    isConnected: liveConnection.isConnected,
    queryString,
    refreshPricing: () => runAction("/api/pricing/refresh"),
    repriceHistory: () => runAction("/api/pricing/reprice"),
    rescan: () => runAction("/api/rescan"),
  };
}

function createQueryString(filters: DashboardViewFilters): string {
  const parameters = new URLSearchParams({
    bucket: filters.bucket,
    sort: filters.sessionSort,
    timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
  });
  const now = Date.now();
  if (filters.range === "today") {
    const startOfToday = new Date();
    startOfToday.setHours(0, 0, 0, 0);
    parameters.set("from", String(startOfToday.getTime()));
    parameters.set("to", String(now));
  } else if (filters.range === "7d" || filters.range === "30d") {
    const dayCount = filters.range === "7d" ? 7 : 30;
    parameters.set("from", String(now - dayCount * 24 * 60 * 60 * 1_000));
    parameters.set("to", String(now));
  }
  setOptionalParameter(parameters, "workspace", filters.workspace);
  setOptionalParameter(parameters, "session", filters.sessionId);
  setOptionalParameter(parameters, "model", filters.model);
  setOptionalParameter(parameters, "provider", filters.provider);
  setOptionalParameter(parameters, "agentType", filters.agentType);
  setOptionalParameter(parameters, "agentId", filters.agentId);
  return parameters.toString();
}

function setOptionalParameter(parameters: URLSearchParams, key: string, value: string): void {
  if (value.length > 0) {
    parameters.set(key, value);
  }
}

async function fetchJson<Value>(url: string, signal: AbortSignal): Promise<Value> {
  const response = await fetch(url, { signal });
  if (!response.ok) {
    throw new Error(await readError(response));
  }
  return response.json() as Promise<Value>;
}

async function readError(response: Response): Promise<string> {
  try {
    const value: unknown = await response.json();
    if (typeof value === "object" && value !== null && "error" in value && typeof value.error === "string") {
      return value.error;
    }
  } catch {
    // Fall through to the HTTP status when the response is not JSON.
  }
  return `Request failed with HTTP ${response.status}.`;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
