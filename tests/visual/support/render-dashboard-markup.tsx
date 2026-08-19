import { expect, mock } from "bun:test";
import { render, screen, waitFor } from "@testing-library/react";
import { CostChartDouble } from "../../dashboard/cost-chart-double";

// Registered here rather than in the test file so it is always in place before the
// dynamic import of `Dashboard` below.
mock.module("../../../src/dashboard/CostChart", () => ({ CostChart: CostChartDouble }));

/**
 * Frozen responses for a capture. Deliberately separate from the fixtures in
 * `tests/dashboard/Dashboard.test.tsx`: a baseline needs values chosen to hold still,
 * where the behavioural test needs values chosen to exercise edge cases.
 *
 * Timestamps are built inside the current year because `formatPricingDate` appends a
 * year only when the date falls outside it, which would otherwise change the header
 * text every January.
 */
const PRICING_UPDATED_MS = new Date(new Date().getFullYear(), 7, 17, 12).getTime();

/** Reports itself open so the capture guards the connected header, not "Reconnecting". */
class ConnectedEventSource {
  onerror: ((event: Event) => void) | null = null;
  onopen: ((event: Event) => void) | null = null;

  constructor() {
    queueMicrotask(() => this.onopen?.(new Event("open")));
  }

  addEventListener(): void {}
  close(): void {}
}

const RESPONSES: Record<string, unknown> = {
  "/api/health": {
    dataVersion: 1,
    detectedProviders: ["anthropic", "moonshotai"],
    ingestion: { isScanning: false, lastSuccessfulScanMs: PRICING_UPDATED_MS, watcherStatus: "running" },
    metering: {
      claude: {
        detectedAtMs: PRICING_UPDATED_MS,
        error: null,
        lastAttemptAtMs: PRICING_UPDATED_MS,
        lastSuccessAtMs: PRICING_UPDATED_MS,
        policy: "pro-fable",
        subscriptionType: "pro",
      },
    },
    pricing: {
      providers: [
        {
          error: null,
          hasOverrides: false,
          isStale: false,
          provider: "anthropic",
          refreshStatus: "succeeded",
          sourceKind: "remote",
          sourceName: "anthropic",
          updatedAtMs: PRICING_UPDATED_MS,
        },
        {
          error: null,
          hasOverrides: false,
          isStale: false,
          provider: "moonshotai",
          refreshStatus: "succeeded",
          sourceKind: "remote",
          sourceName: "litellm",
          updatedAtMs: PRICING_UPDATED_MS,
        },
      ],
    },
    warnings: [],
  },
  "/api/models": { models: [] },
  "/api/options": {
    agents: [{ label: "Explore", value: "agent:Explore" }],
    models: [{ label: "claude-opus-4-1", value: "claude-opus-4-1" }],
    providers: [
      { label: "Claude", value: "anthropic" },
      { label: "Kimi", value: "moonshotai" },
    ],
    sessions: [],
    workspaces: [{ label: "Workspace one", value: "workspace-1" }],
  },
  "/api/sessions": { sessions: [] },
  "/api/summary": {
    activeSessionCostNano: 31_780_000_000,
    cacheHitRatio: 0.98,
    cacheReadTokens: 4_120_000,
    callCount: 7_748,
    costTodayNano: 69_280_000_000,
    inputTokens: 812_000,
    outputTokens: 140_500,
    replayExcludedCount: 179,
    totalCostNano: 610_210_000_000,
    unpricedCallCount: 0,
  },
  "/api/timeseries": { fromMs: 1, points: [], resolution: "hour", timeZone: "UTC", toMs: 2 },
};

export async function renderDashboardMarkup(): Promise<string> {
  globalThis.EventSource = ConnectedEventSource as unknown as typeof EventSource;
  globalThis.fetch = mock(async (input: RequestInfo | URL) => {
    const path = String(input).split("?")[0] ?? "";
    const body = RESPONSES[path] ?? RESPONSES[path.replace(/\/api\/sessions\/.*/, "/api/sessions")];
    return Response.json(body ?? {});
  }) as unknown as typeof fetch;

  const { Dashboard } = await import("../../../src/dashboard/Dashboard");
  const { container } = render(<Dashboard />);
  await waitFor(() => expect(screen.getByText("$610.21")).toBeTruthy());
  return container.innerHTML;
}
