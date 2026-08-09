import type { Database } from "bun:sqlite";
import { bucketTimestampMs, fixedBucketDurationMs, selectAutomaticBucket } from "./bucketing";
import type {
  AgentRow,
  BucketSize,
  DashboardFilters,
  FilterOption,
  FilterOptionsResponse,
  ModelRow,
  SessionRow,
  SummaryResponse,
  TimeseriesPoint,
  TimeseriesResponse,
} from "./contracts";
import { formatUsdNano } from "./formatting";

const SESSION_TITLE_MAX_CHARACTERS = 48;

type SqlParameter = bigint | boolean | number | string | null | Uint8Array;

interface FilterSql {
  clause: string;
  parameters: SqlParameter[];
}

interface AggregateRow {
  cache_creation_cost_nano: number;
  cache_creation_tokens: number;
  cache_read_cost_nano: number;
  cache_read_tokens: number;
  call_count: number;
  input_cost_nano: number;
  input_other_tokens: number;
  output_cost_nano: number;
  output_tokens: number;
  total_cost_nano: number;
  unpriced_call_count: number;
}

interface TimeRangeRow {
  maximum_timestamp_ms: number | null;
  minimum_timestamp_ms: number | null;
}

interface TimeseriesSqlRow {
  bucket_start_ms: number;
  cache_creation_cost_nano: number;
  cache_read_cost_nano: number;
  call_count: number;
  input_cost_nano: number;
  output_cost_nano: number;
  total_cost_nano: number;
  unpriced_call_count: number;
}

interface RawCostRow extends Omit<TimeseriesSqlRow, "bucket_start_ms"> {
  timestamp_ms: number;
}

export function querySummary(
  database: Database,
  filters: DashboardFilters,
  nowMs = Date.now(),
): SummaryResponse {
  const filterSql = buildCallFilter(filters);
  const aggregate = queryAggregate(database, filterSql);
  const todayStartMs = bucketTimestampMs(nowMs, "day", filters.timeZone);
  const todayAggregate = queryAggregate(database, appendCondition(filterSql, "call.timestamp_ms >= ?", todayStartMs));
  const activeSessionId = queryRows<{ session_id: string }>(database, `
    SELECT call.session_id
    FROM api_calls AS call
    JOIN sessions AS session ON session.session_id = call.session_id
    JOIN agents AS agent ON agent.session_id = call.session_id AND agent.agent_id = call.agent_id
    ${filterSql.clause}
    ORDER BY session.updated_at_ms DESC, call.timestamp_ms DESC
    LIMIT 1
  `, filterSql.parameters)[0]?.session_id;
  const activeSessionAggregate = activeSessionId === undefined
    ? emptyAggregate()
    : queryAggregate(database, appendCondition(filterSql, "call.session_id = ?", activeSessionId));
  const replayExcludedCount = queryReplayCount(database, filters);
  const allInputTokens = aggregate.input_other_tokens
    + aggregate.cache_creation_tokens
    + aggregate.cache_read_tokens;

  return {
    activeSessionCostNano: activeSessionAggregate.total_cost_nano,
    cacheHitRatio: allInputTokens === 0 ? 0 : aggregate.cache_read_tokens / allInputTokens,
    cacheReadTokens: aggregate.cache_read_tokens,
    callCount: aggregate.call_count,
    costTodayNano: todayAggregate.total_cost_nano,
    inputTokens: allInputTokens,
    outputTokens: aggregate.output_tokens,
    replayExcludedCount,
    totalCostNano: aggregate.total_cost_nano,
    unpricedCallCount: aggregate.unpriced_call_count,
  };
}

export function queryTimeseries(
  database: Database,
  filters: DashboardFilters,
): TimeseriesResponse {
  const filterSql = buildCallFilter(filters);
  const storedRange = queryRows<TimeRangeRow>(database, `
    SELECT MIN(call.timestamp_ms) AS minimum_timestamp_ms,
           MAX(call.timestamp_ms) AS maximum_timestamp_ms
    FROM api_calls AS call
    JOIN sessions AS session ON session.session_id = call.session_id
    JOIN agents AS agent ON agent.session_id = call.session_id AND agent.agent_id = call.agent_id
    ${filterSql.clause}
  `, filterSql.parameters)[0];
  const toMs = filters.toMs ?? storedRange?.maximum_timestamp_ms ?? Date.now();
  const fromMs = filters.fromMs ?? storedRange?.minimum_timestamp_ms ?? toMs - 24 * 60 * 60 * 1_000;
  const resolution = filters.sessionId === undefined
    ? filters.bucket === "auto" ? selectAutomaticBucket(fromMs, toMs) : filters.bucket
    : "call";
  const rows = resolution === "call"
    ? queryCallTimeseries(database, filterSql)
    : queryBucketTimeseries(database, filterSql, resolution, filters.timeZone);

  return {
    fromMs,
    points: addCumulativeCosts(rows),
    resolution,
    timeZone: filters.timeZone,
    toMs,
  };
}

export function querySessions(
  database: Database,
  filters: DashboardFilters,
  privacyMode: boolean,
): readonly SessionRow[] {
  const filterSql = buildCallFilter(filters);
  const orderBy = filters.sessionSort === "recent"
    ? "last_call_at_ms DESC"
    : filters.sessionSort === "start"
      ? "session.created_at_ms DESC"
      : "total_cost_nano DESC";
  const rows = queryRows<{
    agent_count: number;
    call_count: number;
    created_at_ms: number;
    last_call_at_ms: number;
    session_id: string;
    title: string | null;
    total_cost_nano: number;
    unpriced_call_count: number;
    work_directory: string | null;
    workspace_key: string;
  }>(database, `
    SELECT
      session.session_id,
      session.workspace_key,
      session.work_directory,
      session.title,
      session.created_at_ms,
      MAX(call.timestamp_ms) AS last_call_at_ms,
      COUNT(*) AS call_count,
      COALESCE(SUM(call.total_cost_nano), 0) AS total_cost_nano,
      SUM(CASE WHEN call.total_cost_nano IS NULL THEN 1 ELSE 0 END) AS unpriced_call_count,
      (SELECT COUNT(*) FROM agents AS count_agent WHERE count_agent.session_id = session.session_id) AS agent_count
    FROM api_calls AS call
    JOIN sessions AS session ON session.session_id = call.session_id
    JOIN agents AS agent ON agent.session_id = call.session_id AND agent.agent_id = call.agent_id
    ${filterSql.clause}
    GROUP BY session.session_id
    ORDER BY ${orderBy}
  `, filterSql.parameters);
  const replayCounts = queryReplayCountsBySession(database, filters);

  return rows.map((row) => ({
    agentCount: row.agent_count,
    callCount: row.call_count,
    createdAtMs: row.created_at_ms,
    inheritedOccurrenceCount: replayCounts.get(row.session_id) ?? 0,
    lastCallAtMs: row.last_call_at_ms,
    sessionId: row.session_id,
    title: privacyMode ? "Hidden session" : row.title,
    totalCostNano: row.total_cost_nano,
    unpricedCallCount: row.unpriced_call_count,
    workDirectory: privacyMode ? null : row.work_directory,
    workspaceKey: privacyMode ? "Hidden workspace" : row.workspace_key,
  }));
}

export function queryAgents(
  database: Database,
  sessionId: string,
  filters: DashboardFilters,
): readonly AgentRow[] {
  const conditions = ["agent.session_id = ?"];
  const parameters: SqlParameter[] = [sessionId];
  if (filters.fromMs !== undefined) {
    conditions.push("call.timestamp_ms >= ?");
    parameters.push(filters.fromMs);
  }
  if (filters.toMs !== undefined) {
    conditions.push("call.timestamp_ms <= ?");
    parameters.push(filters.toMs);
  }
  if (filters.model !== undefined) {
    conditions.push("call.raw_model = ?");
    parameters.push(filters.model);
  }
  if (filters.agentType !== undefined) {
    conditions.push("agent.agent_type = ?");
    parameters.push(filters.agentType);
  }
  if (filters.agentId !== undefined) {
    conditions.push("agent.agent_id = ?");
    parameters.push(filters.agentId);
  }

  const rows = queryRows<{
    agent_id: string;
    agent_type: AgentRow["agentType"];
    call_count: number;
    parent_agent_id: string | null;
    total_cost_nano: number;
    unpriced_call_count: number;
  }>(database, `
    SELECT
      agent.agent_id,
      agent.agent_type,
      agent.parent_agent_id,
      COUNT(call.event_fingerprint) AS call_count,
      COALESCE(SUM(call.total_cost_nano), 0) AS total_cost_nano,
      SUM(CASE WHEN call.event_fingerprint IS NOT NULL AND call.total_cost_nano IS NULL THEN 1 ELSE 0 END)
        AS unpriced_call_count
    FROM agents AS agent
    LEFT JOIN api_calls AS call
      ON call.session_id = agent.session_id AND call.agent_id = agent.agent_id
    WHERE ${conditions.join(" AND ")}
    GROUP BY agent.session_id, agent.agent_id
    ORDER BY CASE agent.agent_type WHEN 'main' THEN 0 WHEN 'sub' THEN 1 ELSE 2 END, agent.agent_id
  `, parameters);
  return rows.map((row) => ({
    agentId: row.agent_id,
    agentType: row.agent_type,
    callCount: row.call_count,
    parentAgentId: row.parent_agent_id,
    totalCostNano: row.total_cost_nano,
    unpricedCallCount: row.unpriced_call_count,
  }));
}

export function queryModels(database: Database, filters: DashboardFilters): readonly ModelRow[] {
  const filterSql = buildCallFilter(filters);
  const rows = queryRows<{
    cache_creation_nano_per_token: number | null;
    cache_read_nano_per_token: number | null;
    call_count: number;
    input_nano_per_token: number | null;
    output_nano_per_token: number | null;
    pricing_basis: string;
    pricing_confidence: string;
    raw_model: string;
    resolved_model_key: string | null;
    total_cost_nano: number;
    total_tokens: number;
    unpriced_call_count: number;
  }>(database, `
    SELECT
      call.raw_model,
      call.resolved_model_key,
      call.pricing_confidence,
      call.pricing_basis,
      COUNT(*) AS call_count,
      COALESCE(SUM(call.total_cost_nano), 0) AS total_cost_nano,
      SUM(call.input_other_tokens + call.cache_creation_tokens + call.cache_read_tokens + call.output_tokens)
        AS total_tokens,
      SUM(CASE WHEN call.total_cost_nano IS NULL THEN 1 ELSE 0 END) AS unpriced_call_count,
      MAX(rate.input_nano_per_token) AS input_nano_per_token,
      MAX(rate.cache_creation_nano_per_token) AS cache_creation_nano_per_token,
      MAX(rate.cache_read_nano_per_token) AS cache_read_nano_per_token,
      MAX(rate.output_nano_per_token) AS output_nano_per_token
    FROM api_calls AS call
    JOIN sessions AS session ON session.session_id = call.session_id
    JOIN agents AS agent ON agent.session_id = call.session_id AND agent.agent_id = call.agent_id
    LEFT JOIN model_rates AS rate ON rate.rate_id = call.rate_id
    ${filterSql.clause}
    GROUP BY call.raw_model, call.resolved_model_key, call.pricing_confidence, call.pricing_basis
    ORDER BY total_cost_nano DESC
  `, filterSql.parameters);
  return rows.map((row) => ({
    cacheCreationUsdPerMillion: nanoPerTokenToUsdPerMillion(row.cache_creation_nano_per_token),
    cacheReadUsdPerMillion: nanoPerTokenToUsdPerMillion(row.cache_read_nano_per_token),
    callCount: row.call_count,
    inputUsdPerMillion: nanoPerTokenToUsdPerMillion(row.input_nano_per_token),
    outputUsdPerMillion: nanoPerTokenToUsdPerMillion(row.output_nano_per_token),
    pricingBasis: row.pricing_basis,
    pricingConfidence: row.pricing_confidence,
    rawModel: row.raw_model,
    resolvedModelKey: row.resolved_model_key,
    totalCostNano: row.total_cost_nano,
    totalTokens: row.total_tokens,
    unpricedCallCount: row.unpriced_call_count,
  }));
}

export function queryFilterOptions(
  database: Database,
  privacyMode: boolean,
): FilterOptionsResponse {
  const workspaces = queryRows<{ workspace_key: string }>(database, `
    SELECT DISTINCT workspace_key FROM sessions ORDER BY workspace_key
  `).map(({ workspace_key }, index) => ({
    label: privacyMode ? `Workspace ${index + 1}` : workspace_key,
    value: workspace_key,
  }));
  const sessions = queryRows<{
    session_id: string;
    title: string | null;
    total_cost_nano: number;
    workspace_key: string;
  }>(database, `
    SELECT
      session.session_id,
      session.workspace_key,
      session.title,
      COALESCE(SUM(call.total_cost_nano), 0) AS total_cost_nano
    FROM sessions AS session
    LEFT JOIN api_calls AS call ON call.session_id = session.session_id
    GROUP BY session.session_id
    HAVING COALESCE(SUM(call.total_cost_nano), 0) > 0
    ORDER BY session.updated_at_ms DESC
  `).map(({ session_id, title, total_cost_nano, workspace_key }, index) => ({
    label: formatSessionOptionLabel({
      projectId: privacyMode ? "Hidden project" : workspace_key,
      spendNano: total_cost_nano,
      title: privacyMode ? `Session ${index + 1}` : title ?? session_id,
    }),
    value: session_id,
  }));
  const models = queryRows<{ raw_model: string }>(database, `
    SELECT DISTINCT raw_model FROM api_calls ORDER BY raw_model
  `).map(({ raw_model }) => ({ label: raw_model, value: raw_model }));
  const agents = queryRows<{ agent_id: string }>(database, `
    SELECT DISTINCT agent_id FROM agents ORDER BY agent_id
  `).map(({ agent_id }) => ({ label: agent_id, value: agent_id }));
  return { agents, models, sessions, workspaces };
}

function formatSessionOptionLabel({
  projectId,
  spendNano,
  title,
}: {
  projectId: string;
  spendNano: number;
  title: string;
}): string {
  return `${formatUsdNano(spendNano)} · ${truncateSessionTitle(title)} · ${projectId}`;
}

function truncateSessionTitle(title: string): string {
  const normalizedTitle = title.replace(/\s+/g, " ").trim();
  const characters = [...normalizedTitle];
  if (characters.length <= SESSION_TITLE_MAX_CHARACTERS) {
    return normalizedTitle;
  }

  return `${characters.slice(0, SESSION_TITLE_MAX_CHARACTERS - 1).join("")}…`;
}

function queryAggregate(database: Database, filterSql: FilterSql): AggregateRow {
  return queryRows<AggregateRow>(database, `
    SELECT
      COUNT(*) AS call_count,
      COALESCE(SUM(call.total_cost_nano), 0) AS total_cost_nano,
      COALESCE(SUM(call.input_cost_nano), 0) AS input_cost_nano,
      COALESCE(SUM(call.cache_creation_cost_nano), 0) AS cache_creation_cost_nano,
      COALESCE(SUM(call.cache_read_cost_nano), 0) AS cache_read_cost_nano,
      COALESCE(SUM(call.output_cost_nano), 0) AS output_cost_nano,
      COALESCE(SUM(call.input_other_tokens), 0) AS input_other_tokens,
      COALESCE(SUM(call.cache_creation_tokens), 0) AS cache_creation_tokens,
      COALESCE(SUM(call.cache_read_tokens), 0) AS cache_read_tokens,
      COALESCE(SUM(call.output_tokens), 0) AS output_tokens,
      SUM(CASE WHEN call.total_cost_nano IS NULL THEN 1 ELSE 0 END) AS unpriced_call_count
    FROM api_calls AS call
    JOIN sessions AS session ON session.session_id = call.session_id
    JOIN agents AS agent ON agent.session_id = call.session_id AND agent.agent_id = call.agent_id
    ${filterSql.clause}
  `, filterSql.parameters)[0] ?? emptyAggregate();
}

function emptyAggregate(): AggregateRow {
  return {
    cache_creation_cost_nano: 0,
    cache_creation_tokens: 0,
    cache_read_cost_nano: 0,
    cache_read_tokens: 0,
    call_count: 0,
    input_cost_nano: 0,
    input_other_tokens: 0,
    output_cost_nano: 0,
    output_tokens: 0,
    total_cost_nano: 0,
    unpriced_call_count: 0,
  };
}

function queryReplayCount(database: Database, filters: DashboardFilters): number {
  const conditions = ["occurrence.is_canonical = 0"];
  const parameters: SqlParameter[] = [];
  addCommonConditions(conditions, parameters, filters, "occurrence");
  return queryScalar(database, `
    SELECT COUNT(*) AS value
    FROM usage_occurrences AS occurrence
    JOIN sessions AS session ON session.session_id = occurrence.session_id
    JOIN agents AS agent
      ON agent.session_id = occurrence.session_id AND agent.agent_id = occurrence.agent_id
    WHERE ${conditions.join(" AND ")}
  `, parameters);
}

function queryReplayCountsBySession(
  database: Database,
  filters: DashboardFilters,
): ReadonlyMap<string, number> {
  const conditions = ["occurrence.is_canonical = 0"];
  const parameters: SqlParameter[] = [];
  addCommonConditions(conditions, parameters, filters, "occurrence");
  const rows = queryRows<{ replay_count: number; session_id: string }>(database, `
    SELECT occurrence.session_id, COUNT(*) AS replay_count
    FROM usage_occurrences AS occurrence
    JOIN sessions AS session ON session.session_id = occurrence.session_id
    JOIN agents AS agent
      ON agent.session_id = occurrence.session_id AND agent.agent_id = occurrence.agent_id
    WHERE ${conditions.join(" AND ")}
    GROUP BY occurrence.session_id
  `, parameters);
  return new Map(rows.map((row) => [row.session_id, row.replay_count]));
}

function queryFixedTimeseries(
  database: Database,
  filterSql: FilterSql,
  bucketDurationMs: number,
): readonly TimeseriesSqlRow[] {
  return queryRows<TimeseriesSqlRow>(database, `
    SELECT
      CAST(call.timestamp_ms / ? AS INTEGER) * ? AS bucket_start_ms,
      COUNT(*) AS call_count,
      COALESCE(SUM(call.input_cost_nano), 0) AS input_cost_nano,
      COALESCE(SUM(call.cache_creation_cost_nano), 0) AS cache_creation_cost_nano,
      COALESCE(SUM(call.cache_read_cost_nano), 0) AS cache_read_cost_nano,
      COALESCE(SUM(call.output_cost_nano), 0) AS output_cost_nano,
      COALESCE(SUM(call.total_cost_nano), 0) AS total_cost_nano,
      SUM(CASE WHEN call.total_cost_nano IS NULL THEN 1 ELSE 0 END) AS unpriced_call_count
    FROM api_calls AS call
    JOIN sessions AS session ON session.session_id = call.session_id
    JOIN agents AS agent ON agent.session_id = call.session_id AND agent.agent_id = call.agent_id
    ${filterSql.clause}
    GROUP BY bucket_start_ms
    ORDER BY bucket_start_ms
  `, [bucketDurationMs, bucketDurationMs, ...filterSql.parameters]);
}

function queryBucketTimeseries(
  database: Database,
  filterSql: FilterSql,
  bucket: BucketSize,
  timeZone: string,
): readonly TimeseriesSqlRow[] {
  const fixedDuration = fixedBucketDurationMs(bucket);
  return fixedDuration === null
    ? queryCalendarTimeseries(database, filterSql, bucket, timeZone)
    : queryFixedTimeseries(database, filterSql, fixedDuration);
}

function queryCallTimeseries(
  database: Database,
  filterSql: FilterSql,
): readonly TimeseriesSqlRow[] {
  return queryRows<TimeseriesSqlRow>(database, `
    SELECT
      call.timestamp_ms AS bucket_start_ms,
      1 AS call_count,
      COALESCE(call.input_cost_nano, 0) AS input_cost_nano,
      COALESCE(call.cache_creation_cost_nano, 0) AS cache_creation_cost_nano,
      COALESCE(call.cache_read_cost_nano, 0) AS cache_read_cost_nano,
      COALESCE(call.output_cost_nano, 0) AS output_cost_nano,
      COALESCE(call.total_cost_nano, 0) AS total_cost_nano,
      CASE WHEN call.total_cost_nano IS NULL THEN 1 ELSE 0 END AS unpriced_call_count
    FROM api_calls AS call
    JOIN sessions AS session ON session.session_id = call.session_id
    JOIN agents AS agent ON agent.session_id = call.session_id AND agent.agent_id = call.agent_id
    ${filterSql.clause}
    ORDER BY call.timestamp_ms, call.event_fingerprint
  `, filterSql.parameters);
}

function queryCalendarTimeseries(
  database: Database,
  filterSql: FilterSql,
  bucket: BucketSize,
  timeZone: string,
): readonly TimeseriesSqlRow[] {
  const rawRows = queryRows<RawCostRow>(database, `
    SELECT
      call.timestamp_ms,
      1 AS call_count,
      COALESCE(call.input_cost_nano, 0) AS input_cost_nano,
      COALESCE(call.cache_creation_cost_nano, 0) AS cache_creation_cost_nano,
      COALESCE(call.cache_read_cost_nano, 0) AS cache_read_cost_nano,
      COALESCE(call.output_cost_nano, 0) AS output_cost_nano,
      COALESCE(call.total_cost_nano, 0) AS total_cost_nano,
      CASE WHEN call.total_cost_nano IS NULL THEN 1 ELSE 0 END AS unpriced_call_count
    FROM api_calls AS call
    JOIN sessions AS session ON session.session_id = call.session_id
    JOIN agents AS agent ON agent.session_id = call.session_id AND agent.agent_id = call.agent_id
    ${filterSql.clause}
    ORDER BY call.timestamp_ms
  `, filterSql.parameters);
  const buckets = new Map<number, TimeseriesSqlRow>();
  for (const row of rawRows) {
    const bucketStartMs = bucketTimestampMs(row.timestamp_ms, bucket, timeZone);
    const aggregate = buckets.get(bucketStartMs) ?? {
      bucket_start_ms: bucketStartMs,
      cache_creation_cost_nano: 0,
      cache_read_cost_nano: 0,
      call_count: 0,
      input_cost_nano: 0,
      output_cost_nano: 0,
      total_cost_nano: 0,
      unpriced_call_count: 0,
    };
    aggregate.call_count += row.call_count;
    aggregate.input_cost_nano += row.input_cost_nano;
    aggregate.cache_creation_cost_nano += row.cache_creation_cost_nano;
    aggregate.cache_read_cost_nano += row.cache_read_cost_nano;
    aggregate.output_cost_nano += row.output_cost_nano;
    aggregate.total_cost_nano += row.total_cost_nano;
    aggregate.unpriced_call_count += row.unpriced_call_count;
    buckets.set(bucketStartMs, aggregate);
  }
  return [...buckets.values()].sort((left, right) => left.bucket_start_ms - right.bucket_start_ms);
}

function addCumulativeCosts(rows: readonly TimeseriesSqlRow[]): readonly TimeseriesPoint[] {
  let cumulativeInput = 0;
  let cumulativeCacheCreation = 0;
  let cumulativeCacheRead = 0;
  let cumulativeOutput = 0;
  return rows.map((row) => {
    cumulativeInput += row.input_cost_nano;
    cumulativeCacheCreation += row.cache_creation_cost_nano;
    cumulativeCacheRead += row.cache_read_cost_nano;
    cumulativeOutput += row.output_cost_nano;
    return {
      bucketStartMs: row.bucket_start_ms,
      cacheCreationCostNano: row.cache_creation_cost_nano,
      cacheReadCostNano: row.cache_read_cost_nano,
      callCount: row.call_count,
      cumulativeCacheCreationCostNano: cumulativeCacheCreation,
      cumulativeCacheReadCostNano: cumulativeCacheRead,
      cumulativeInputCostNano: cumulativeInput,
      cumulativeOutputCostNano: cumulativeOutput,
      cumulativeTotalCostNano: cumulativeInput + cumulativeCacheCreation + cumulativeCacheRead + cumulativeOutput,
      inputCostNano: row.input_cost_nano,
      outputCostNano: row.output_cost_nano,
      totalCostNano: row.total_cost_nano,
      unpricedCallCount: row.unpriced_call_count,
    };
  });
}

function buildCallFilter(filters: DashboardFilters): FilterSql {
  const conditions: string[] = [];
  const parameters: SqlParameter[] = [];
  addCommonConditions(conditions, parameters, filters, "call");
  return {
    clause: conditions.length === 0 ? "" : `WHERE ${conditions.join(" AND ")}`,
    parameters,
  };
}

function addCommonConditions(
  conditions: string[],
  parameters: SqlParameter[],
  filters: DashboardFilters,
  callAlias: "call" | "occurrence",
): void {
  if (filters.fromMs !== undefined) {
    conditions.push(`${callAlias}.timestamp_ms >= ?`);
    parameters.push(filters.fromMs);
  }
  if (filters.toMs !== undefined) {
    conditions.push(`${callAlias}.timestamp_ms <= ?`);
    parameters.push(filters.toMs);
  }
  if (filters.workspace !== undefined) {
    conditions.push("session.workspace_key = ?");
    parameters.push(filters.workspace);
  }
  if (filters.sessionId !== undefined) {
    conditions.push(`${callAlias}.session_id = ?`);
    parameters.push(filters.sessionId);
  }
  if (filters.model !== undefined) {
    conditions.push(`${callAlias}.raw_model = ?`);
    parameters.push(filters.model);
  }
  if (filters.agentType !== undefined) {
    conditions.push("agent.agent_type = ?");
    parameters.push(filters.agentType);
  }
  if (filters.agentId !== undefined) {
    conditions.push(`${callAlias}.agent_id = ?`);
    parameters.push(filters.agentId);
  }
}

function appendCondition(filterSql: FilterSql, condition: string, parameter: SqlParameter): FilterSql {
  return {
    clause: filterSql.clause.length === 0
      ? `WHERE ${condition}`
      : `${filterSql.clause} AND ${condition}`,
    parameters: [...filterSql.parameters, parameter],
  };
}

function queryRows<Row>(
  database: Database,
  sql: string,
  parameters: readonly SqlParameter[] = [],
): Row[] {
  return database.query(sql).all(...parameters) as Row[];
}

function queryScalar(
  database: Database,
  sql: string,
  parameters: readonly SqlParameter[],
): number {
  return queryRows<{ value: number }>(database, sql, parameters)[0]?.value ?? 0;
}

function nanoPerTokenToUsdPerMillion(value: number | null): number | null {
  return value === null ? null : value / 1_000;
}
