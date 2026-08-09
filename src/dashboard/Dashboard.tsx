import { lazy, Suspense, useEffect, useState } from "react";
import { ConnectionStatus } from "../live-sync/ConnectionStatus";
import { PricingWarning } from "../pricing/PricingWarning";
import type { AgentRow, FilterOption, SessionRow } from "./contracts";
import { formatUsdNano } from "./formatting";
import {
  initialDashboardFilters,
  type DashboardViewFilters,
  useDashboardData,
} from "./use-dashboard-data";
import "./dashboard.css";

const CostChart = lazy(async () => {
  const chartModule = await import("./CostChart");
  return { default: chartModule.CostChart };
});

export function Dashboard() {
  const [filters, setFilters] = useState<DashboardViewFilters>(initialDashboardFilters);
  const [expandedSessionId, setExpandedSessionId] = useState<string | null>(null);
  const dashboard = useDashboardData(filters);
  const summary = dashboard.summary;

  function updateFilter<Key extends keyof DashboardViewFilters>(
    key: Key,
    value: DashboardViewFilters[Key],
  ): void {
    setFilters((current) => ({ ...current, [key]: value }));
  }

  function requestReprice(): void {
    const shouldReprice = window.confirm(
      "Recalculate every historical call with the latest active rates? This changes stored historical totals.",
    );
    if (shouldReprice) {
      void dashboard.repriceHistory();
    }
  }

  return (
    <main className="dashboard-shell">
      <header className="dashboard-header">
        <h1>Kimi cost dashboard</h1>
        <div className="dashboard-header__actions">
          <ConnectionStatus
            isConnected={dashboard.isConnected}
            isScanning={dashboard.health?.ingestion.isScanning ?? dashboard.isLoading}
            lastSuccessfulScanMs={dashboard.health?.ingestion.lastSuccessfulScanMs ?? null}
          />
          <button
            type="button"
            className="rescan-button"
            aria-label="Rescan"
            title="Rescan"
            onClick={() => void dashboard.rescan()}
            disabled={dashboard.isActionRunning}
          >
            <span aria-hidden="true">↻</span>
          </button>
        </div>
      </header>

      {dashboard.error !== null && (
        <div className="dashboard-error" role="alert">
          <strong>Dashboard update failed.</strong> {dashboard.error}
        </div>
      )}
      {dashboard.health?.warnings.map((warning) => (
        <div className="dashboard-warning" role="status" key={warning}>{warning}</div>
      ))}

      <FilterBar filters={filters} options={dashboard.options} onChange={updateFilter} />

      <section className="metric-grid" aria-label="Cost summary">
        <Metric label="Total spend" value={formatUsdNano(summary?.totalCostNano ?? 0)} />
        <Metric label="Today" value={formatUsdNano(summary?.costTodayNano ?? 0)} />
        <Metric label="Active session" value={formatUsdNano(summary?.activeSessionCostNano ?? 0)} />
        <Metric label="Cache hit ratio" value={formatPercentage(summary?.cacheHitRatio ?? 0)} />
        <Metric label="Calls" value={(summary?.callCount ?? 0).toLocaleString()} detail={`${summary?.replayExcludedCount ?? 0} replay copies`} />
      </section>

      <PricingWarning
        isWorking={dashboard.isActionRunning}
        newestSnapshotMs={dashboard.health?.pricing.newestSnapshotMs ?? null}
        onRefresh={() => void dashboard.refreshPricing()}
        onReprice={requestReprice}
        unpricedCallCount={summary?.unpricedCallCount ?? 0}
      />

      <section className="chart-grid">
        <article className="dashboard-panel chart-panel">
          <PanelHeading
            title={dashboard.timeseries?.resolution === "call" ? "Spend by call" : "Spend by active bucket"}
            detail={dashboard.timeseries?.resolution === "call"
              ? "One bar per call · idle time removed"
              : `${dashboard.timeseries?.resolution ?? "automatic"} buckets · idle time removed`}
          />
          <Suspense fallback={<div className="chart-loading">Loading chart…</div>}>
            <CostChart kind="bucket" points={dashboard.timeseries?.points ?? []} />
          </Suspense>
        </article>
        <article className="dashboard-panel chart-panel">
          <PanelHeading title="Cumulative spend" detail="Idle time removed" />
          <Suspense fallback={<div className="chart-loading">Loading chart…</div>}>
            <CostChart kind="cumulative" points={dashboard.timeseries?.points ?? []} />
          </Suspense>
        </article>
      </section>

      <section className="dashboard-panel table-panel">
        <PanelHeading title="Sessions" />
        <div className="table-scroll">
          <table>
            <thead>
              <tr>
                <th scope="col">Session</th>
                <th scope="col">Last call</th>
                <th scope="col">Agents</th>
                <th scope="col">Calls</th>
                <th scope="col">Replays</th>
                <th scope="col" className="numeric">New spend</th>
              </tr>
            </thead>
            <tbody>
              {dashboard.sessions.map((session) => (
                <SessionTableRows
                  dataVersion={dashboard.dataVersion}
                  expanded={expandedSessionId === session.sessionId}
                  key={session.sessionId}
                  onToggle={() => setExpandedSessionId((current) => (
                    current === session.sessionId ? null : session.sessionId
                  ))}
                  queryString={dashboard.queryString}
                  session={session}
                />
              ))}
              {!dashboard.isLoading && dashboard.sessions.length === 0 && (
                <tr><td colSpan={6} className="empty-table">No sessions match these filters.</td></tr>
              )}
            </tbody>
          </table>
        </div>
      </section>

      <section className="dashboard-panel table-panel">
        <PanelHeading title="Models and rates" detail="Exact source and confidence for every priced group" />
        <div className="table-scroll">
          <table>
            <thead>
              <tr>
                <th scope="col">Model</th>
                <th scope="col">Rate source</th>
                <th scope="col">Input / cache / output per 1M</th>
                <th scope="col">Tokens</th>
                <th scope="col">Calls</th>
                <th scope="col" className="numeric">Spend</th>
              </tr>
            </thead>
            <tbody>
              {dashboard.models.map((model) => (
                <tr key={`${model.rawModel}-${model.pricingBasis}-${model.pricingConfidence}`}>
                  <td>
                    <strong>{model.rawModel}</strong>
                    <small>{model.resolvedModelKey ?? "Unresolved"}</small>
                  </td>
                  <td><RateBadge confidence={model.pricingConfidence} /> <small>{model.pricingBasis}</small></td>
                  <td className="rate-cell">
                    {formatRate(model.inputUsdPerMillion)} / {formatRate(model.cacheReadUsdPerMillion)} / {formatRate(model.outputUsdPerMillion)}
                  </td>
                  <td>{formatCompactNumber(model.totalTokens)}</td>
                  <td>{model.callCount.toLocaleString()}</td>
                  <td className="numeric"><strong>{formatUsdNano(model.totalCostNano)}</strong></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <footer className="dashboard-footer">
        <span>{formatCompactNumber(summary?.inputTokens ?? 0)} input tokens</span>
        <span>{formatCompactNumber(summary?.outputTokens ?? 0)} output tokens</span>
        <span>{formatCompactNumber(summary?.cacheReadTokens ?? 0)} cache-read tokens</span>
        <span>{dashboard.timeseries?.timeZone ?? Intl.DateTimeFormat().resolvedOptions().timeZone}</span>
      </footer>
    </main>
  );
}

interface FilterBarProps {
  filters: DashboardViewFilters;
  onChange: <Key extends keyof DashboardViewFilters>(key: Key, value: DashboardViewFilters[Key]) => void;
  options: {
    agents: readonly FilterOption[];
    models: readonly FilterOption[];
    sessions: readonly FilterOption[];
    workspaces: readonly FilterOption[];
  };
}

function FilterBar({ filters, onChange, options }: FilterBarProps) {
  const isShowingIndividualCalls = filters.sessionId !== "";
  return (
    <section className="filter-bar" aria-label="Dashboard filters">
      <FilterSelect label="Range" value={filters.range} onChange={(value) => onChange("range", value as DashboardViewFilters["range"])} options={[
        { label: "All time", value: "all" },
        { label: "Today", value: "today" },
        { label: "Last 7 days", value: "7d" },
        { label: "Last 30 days", value: "30d" },
      ]} />
      <FilterSelect label="Workspace" value={filters.workspace} onChange={(value) => onChange("workspace", value)} options={options.workspaces} includeAll />
      <FilterSelect label="Session" value={filters.sessionId} onChange={(value) => onChange("sessionId", value)} options={options.sessions} includeAll />
      <FilterSelect label="Model" value={filters.model} onChange={(value) => onChange("model", value)} options={options.models} includeAll />
      <FilterSelect label="Agent type" value={filters.agentType} onChange={(value) => onChange("agentType", value as DashboardViewFilters["agentType"])} options={[
        { label: "Main", value: "main" },
        { label: "Subagent", value: "sub" },
        { label: "Unknown", value: "unknown" },
      ]} includeAll />
      <FilterSelect label="Agent" value={filters.agentId} onChange={(value) => onChange("agentId", value)} options={options.agents} includeAll />
      <FilterSelect
        disabled={isShowingIndividualCalls}
        label="Bucket"
        value={filters.bucket}
        onChange={(value) => onChange("bucket", value as DashboardViewFilters["bucket"])}
        options={isShowingIndividualCalls
          ? [{ label: "Individual calls", value: filters.bucket }]
          : [
            { label: "Automatic", value: "auto" },
            { label: "Minute", value: "minute" },
            { label: "Hour", value: "hour" },
            { label: "Day", value: "day" },
            { label: "Week", value: "week" },
          ]}
      />
      <FilterSelect label="Session order" value={filters.sessionSort} onChange={(value) => onChange("sessionSort", value as DashboardViewFilters["sessionSort"])} options={[
        { label: "Highest cost", value: "cost" },
        { label: "Recent activity", value: "recent" },
        { label: "Newest start", value: "start" },
      ]} />
    </section>
  );
}

function FilterSelect({
  disabled = false,
  includeAll = false,
  label,
  onChange,
  options,
  value,
}: {
  disabled?: boolean;
  includeAll?: boolean;
  label: string;
  onChange: (value: string) => void;
  options: readonly FilterOption[];
  value: string;
}) {
  return (
    <label className="filter-field">
      <span>{label}</span>
      <select disabled={disabled} value={value} onChange={(event) => onChange(event.target.value)}>
        {includeAll && <option value="">All</option>}
        {options.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
      </select>
    </label>
  );
}

function Metric({ detail, label, value }: {
  detail?: string;
  label: string;
  value: string;
}) {
  return (
    <div className="metric">
      <span>{label}</span>
      <strong>{value}</strong>
      {detail !== undefined && <small>{detail}</small>}
    </div>
  );
}

function PanelHeading({ detail, title }: { detail?: string; title: string }) {
  return (
    <div className="panel-heading">
      <h2>{title}</h2>
      {detail !== undefined && <p>{detail}</p>}
    </div>
  );
}

function SessionTableRows({
  dataVersion,
  expanded,
  onToggle,
  queryString,
  session,
}: {
  dataVersion: number;
  expanded: boolean;
  onToggle: () => void;
  queryString: string;
  session: SessionRow;
}) {
  return (
    <>
      <tr>
        <td>
          <button type="button" className="session-toggle" onClick={onToggle} aria-expanded={expanded}>
            <span aria-hidden="true">{expanded ? "−" : "+"}</span>
            <span><strong>{session.title ?? session.sessionId}</strong><small>{session.workspaceKey}</small></span>
          </button>
        </td>
        <td>{formatDateTime(session.lastCallAtMs)}</td>
        <td>{session.agentCount}</td>
        <td>{session.callCount.toLocaleString()}</td>
        <td>{session.inheritedOccurrenceCount.toLocaleString()}</td>
        <td className="numeric"><strong>{formatUsdNano(session.totalCostNano)}</strong></td>
      </tr>
      {expanded && (
        <tr className="agent-detail-row">
          <td colSpan={6}>
            <SessionAgents dataVersion={dataVersion} queryString={queryString} sessionId={session.sessionId} />
          </td>
        </tr>
      )}
    </>
  );
}

function SessionAgents({
  dataVersion,
  queryString,
  sessionId,
}: {
  dataVersion: number;
  queryString: string;
  sessionId: string;
}) {
  const [agents, setAgents] = useState<readonly AgentRow[]>([]);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    const controller = new AbortController();
    void fetch(`/api/sessions/${encodeURIComponent(sessionId)}/agents?${queryString}`, {
      signal: controller.signal,
    }).then(async (response) => {
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      return response.json() as Promise<{ agents: readonly AgentRow[] }>;
    }).then((result) => {
      setAgents(result.agents);
      setError(null);
    }).catch((fetchError: unknown) => {
      if (!controller.signal.aborted) setError(fetchError instanceof Error ? fetchError.message : String(fetchError));
    });
    return () => controller.abort();
  }, [dataVersion, queryString, sessionId]);

  if (error !== null) return <p className="agent-error">Could not load agents: {error}</p>;
  return (
    <div className="agent-list">
      {agents.map((agent) => (
        <div className="agent-list__item" key={agent.agentId}>
          <span className={`agent-type agent-type--${agent.agentType}`}>{agent.agentType}</span>
          <span><strong>{agent.agentId}</strong><small>{agent.parentAgentId === null ? "Root agent" : `Child of ${agent.parentAgentId}`}</small></span>
          <span>{agent.callCount.toLocaleString()} calls</span>
          <strong>{formatUsdNano(agent.totalCostNano)}</strong>
        </div>
      ))}
    </div>
  );
}

function RateBadge({ confidence }: { confidence: string }) {
  return <span className={`rate-badge rate-badge--${confidence}`}>{confidence}</span>;
}

function formatRate(rate: number | null): string {
  return rate === null ? "—" : `$${rate.toFixed(rate < 1 ? 2 : 2)}`;
}

function formatPercentage(ratio: number): string {
  return new Intl.NumberFormat(undefined, { maximumFractionDigits: 1, style: "percent" }).format(ratio);
}

function formatCompactNumber(value: number): string {
  return new Intl.NumberFormat(undefined, { maximumFractionDigits: 1, notation: "compact" }).format(value);
}

function formatDateTime(timestampMs: number): string {
  return new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(timestampMs);
}
