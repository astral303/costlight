import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { APPLICATION_VERSION } from "../../src/app-version/browser-version";

mock.module("../../src/dashboard/CostChart", () => ({
  CostChart: ({ kind }: { kind: string }) => <div data-testid={`${kind}-chart`} />,
}));

class FakeEventSource {
  static readonly instances: FakeEventSource[] = [];
  onerror: ((event: Event) => void) | null = null;
  onopen: ((event: Event) => void) | null = null;
  readonly listeners = new Map<string, (event: MessageEvent<string>) => void>();

  constructor(_url: string | URL, _options?: EventSourceInit) {
    FakeEventSource.instances.push(this);
  }

  addEventListener(type: string, listener: EventListener): void {
    this.listeners.set(type, listener as (event: MessageEvent<string>) => void);
  }

  close(): void {}

  emit(type: string, value: unknown): void {
    this.listeners.get(type)?.(new MessageEvent(type, { data: JSON.stringify(value) }));
  }
}

const requestedUrls: string[] = [];
const statusTimestampMs = new Date(new Date().getFullYear(), 7, 14, 16, 38).getTime();

beforeEach(() => {
  requestedUrls.length = 0;
  FakeEventSource.instances.length = 0;
  globalThis.EventSource = FakeEventSource as unknown as typeof EventSource;
  globalThis.fetch = mock(async (input: RequestInfo | URL) => {
    const url = String(input);
    requestedUrls.push(url);
    if (url.startsWith("/api/summary")) {
      return Response.json({
        activeSessionCostNano: 500_000_000,
        cacheHitRatio: 0.75,
        cacheReadTokens: 750,
        callCount: 10,
        costTodayNano: 250_000_000,
        inputTokens: 1_000,
        outputTokens: 200,
        replayExcludedCount: 2,
        totalCostNano: 1_230_000_000,
        unpricedCallCount: 0,
      });
    }
    if (url.startsWith("/api/timeseries")) {
      return Response.json({
        fromMs: 1,
        points: [],
        resolution: url.includes("session=session-1") ? "call" : "hour",
        timeZone: "UTC",
        toMs: 2,
      });
    }
    if (url.startsWith("/api/sessions/session-1/agents")) {
      return Response.json({ agents: [] });
    }
    if (url.startsWith("/api/sessions")) {
      return Response.json({
        sessions: [
          createSession(),
          {
            ...createSession(),
            createdAtMs: 0,
            lastCallAtMs: 1,
            sessionId: "session-high",
            title: "Highest-cost session",
            totalCostNano: 2_000_000_000,
          },
          {
            ...createSession(),
            createdAtMs: 3,
            lastCallAtMs: 3,
            sessionId: "session-newest",
            title: "Newest session",
            totalCostNano: 100_000_000,
          },
        ],
      });
    }
    if (url.startsWith("/api/models")) {
      return Response.json({ models: [] });
    }
    if (url === "/api/options") {
      return Response.json({
        agents: [],
        models: [],
        providers: [
          { label: "Kimi", value: "moonshotai" },
          { label: "Claude", value: "anthropic" },
        ],
        sessions: [
          {
            label: "Test session",
            provider: "moonshotai",
            recencyGroup: "Last 24 hours",
            value: "session-1",
            workspace: "workspace-1",
          },
          {
            label: "Other session",
            provider: "anthropic",
            recencyGroup: "2+ days ago",
            value: "session-2",
            workspace: "workspace-2",
          },
        ],
        workspaces: [
          { label: "Workspace one", value: "workspace-1" },
          { label: "Workspace two", value: "workspace-2" },
        ],
      });
    }
    if (url === "/api/health") {
      return Response.json({
        dataVersion: 1,
        detectedProviders: ["anthropic", "moonshotai"],
        ingestion: { isScanning: false, lastSuccessfulScanMs: 1, watcherStatus: "running" },
        metering: {
          claude: {
            detectedAtMs: statusTimestampMs,
            error: null,
            lastAttemptAtMs: statusTimestampMs,
            lastSuccessAtMs: statusTimestampMs,
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
              updatedAtMs: statusTimestampMs,
            },
            {
              error: null,
              hasOverrides: false,
              isStale: false,
              provider: "moonshotai",
              refreshStatus: "succeeded",
              sourceKind: "remote",
              sourceName: "litellm",
              updatedAtMs: statusTimestampMs,
            },
          ],
        },
        status: "ok",
        warnings: [],
      });
    }
    return Response.json({});
  }) as unknown as typeof fetch;
});

afterEach(() => cleanup());

describe("Dashboard", () => {
  test("renders the reconciled initial report", async () => {
    const { Dashboard } = await import("../../src/dashboard/Dashboard");
    render(<Dashboard />);

    expect((await screen.findAllByText("$1.23")).length).toBe(2);
    expect(screen.getByText("2 replay copies")).toBeTruthy();
    expect(screen.getByText("Total API cost*").getAttribute("title")).toBe(
      "Estimated from recorded tokens and configured rates.",
    );
    expect(screen.getByText("Claude Pro")).toBeTruthy();
    expect(screen.getAllByText("Test session").length).toBe(2);
    expect(screen.getByTestId("bucket-chart")).toBeTruthy();
    expect(screen.getByTestId("cumulative-chart")).toBeTruthy();
    expect(screen.getByText(`Costlight v${APPLICATION_VERSION}`)).toBeTruthy();
  });

  test("keeps provider and scan status compact in the header", async () => {
    const { Dashboard } = await import("../../src/dashboard/Dashboard");
    render(<Dashboard />);
    await screen.findAllByText("$1.23");

    expect(screen.queryByText("Local usage intelligence")).toBeNull();
    expect(screen.queryByText(/Canonical API spend/)).toBeNull();
    expect(screen.getByText("Watches files · Rechecks every 30s")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Rescan" }).getAttribute("title")).toBe("Rescan");
    expect(screen.queryByText(/Claude Pro subscription detected/)).toBeNull();
    expect(screen.getByText("Pricing: Aug 14 (Claude Official)")).toBeTruthy();
    expect(screen.getByLabelText(/Metered API usage: Fable only/).getAttribute("title"))
      .toContain("Account checked");
    expect(screen.getByText("Pricing: Aug 14 (Kimi LiteLLM)")).toBeTruthy();

    fireEvent.click(screen.getByText("Claude Pro").closest("summary") as HTMLElement);
    fireEvent.click(screen.getByRole("button", { name: "Refresh Claude pricing" }));
    await waitFor(() => expect(requestedUrls).toContain("/api/pricing/refresh"));
  });

  test("keeps session ordering beside the table it controls", async () => {
    const { Dashboard } = await import("../../src/dashboard/Dashboard");
    render(<Dashboard />);
    await screen.findAllByText("$1.23");

    const filterBar = screen.getByRole("region", { name: "Dashboard filters" });
    expect(within(filterBar).queryByLabelText("Session order")).toBeNull();
    const sessionsPanel = screen.getByRole("heading", { name: "Sessions" }).closest("section");
    expect(sessionsPanel).not.toBeNull();
    const sessionOrder = within(sessionsPanel as HTMLElement).getByLabelText("Session order");
    const requestCount = requestedUrls.length;
    const sessionTitles = () => [...(sessionsPanel as HTMLElement).querySelectorAll(
      "tbody > tr > td:first-child strong",
    )].map((title) => title.textContent);

    expect(sessionTitles()).toEqual(["Highest-cost session", "Test session", "Newest session"]);

    fireEvent.change(sessionOrder, { target: { value: "start" } });

    expect(sessionTitles()).toEqual(["Newest session", "Test session", "Highest-cost session"]);
    expect(requestedUrls).toHaveLength(requestCount);
    expect(requestedUrls.every((url) => !url.includes("sort="))).toBe(true);
  });

  test("offers complete and current calendar-month ranges", async () => {
    const { Dashboard } = await import("../../src/dashboard/Dashboard");
    render(<Dashboard />);
    await screen.findAllByText("$1.23");

    const rangeSelect = screen.getByLabelText("Range") as HTMLSelectElement;
    expect([...rangeSelect.options].map((option) => option.text)).toEqual([
      "All time",
      "Today",
      "This month",
      "Last month",
      "Last 7 days",
      "Last 30 days",
    ]);
    const now = new Date();
    const currentMonthStartMs = new Date(now.getFullYear(), now.getMonth(), 1).getTime();
    const previousMonthStartMs = new Date(now.getFullYear(), now.getMonth() - 1, 1).getTime();

    fireEvent.change(rangeSelect, { target: { value: "last-month" } });
    await waitFor(() => {
      const parameters = latestSummaryParameters();
      expect(parameters.get("from")).toBe(String(previousMonthStartMs));
      expect(parameters.get("to")).toBe(String(currentMonthStartMs - 1));
    });

    const beforeCurrentMonthRequestMs = Date.now();
    fireEvent.change(rangeSelect, { target: { value: "this-month" } });
    await waitFor(() => {
      const parameters = latestSummaryParameters();
      expect(parameters.get("from")).toBe(String(currentMonthStartMs));
      expect(Number(parameters.get("to"))).toBeGreaterThanOrEqual(beforeCurrentMonthRequestMs);
      expect(Number(parameters.get("to"))).toBeLessThanOrEqual(Date.now());
    });
  });

  test("applies workspace filters to every report request", async () => {
    const { Dashboard } = await import("../../src/dashboard/Dashboard");
    render(<Dashboard />);
    await screen.findAllByText("$1.23");

    fireEvent.change(screen.getByLabelText("Workspace"), { target: { value: "workspace-1" } });
    await waitFor(() => {
      expect(requestedUrls.some((url) => (
        url.startsWith("/api/summary?") && url.includes("workspace=workspace-1")
      ))).toBe(true);
      expect(requestedUrls.some((url) => (
        url.startsWith("/api/timeseries?") && url.includes("workspace=workspace-1")
      ))).toBe(true);
      expect(requestedUrls.some((url) => (
        url.startsWith("/api/sessions?") && url.includes("workspace=workspace-1")
      ))).toBe(true);
      expect(requestedUrls.some((url) => (
        url.startsWith("/api/models?") && url.includes("workspace=workspace-1")
      ))).toBe(true);
    });
  });

  test("limits session choices to the selected workspace", async () => {
    const { Dashboard } = await import("../../src/dashboard/Dashboard");
    render(<Dashboard />);
    await screen.findAllByText("$1.23");

    const sessionSelect = screen.getByLabelText("Session") as HTMLSelectElement;
    fireEvent.change(sessionSelect, { target: { value: "session-2" } });
    fireEvent.change(screen.getByLabelText("Workspace"), { target: { value: "workspace-1" } });

    expect(sessionSelect.value).toBe("");
    expect([...sessionSelect.options].map((option) => option.text)).toEqual(["All", "Test session"]);
    await waitFor(() => {
      const latestSummaryRequest = requestedUrls
        .filter((url) => url.startsWith("/api/summary?"))
        .at(-1);
      expect(latestSummaryRequest).toContain("workspace=workspace-1");
      expect(latestSummaryRequest).not.toContain("session=");
    });
  });

  test("renders session recency groups in their supplied order", async () => {
    const { Dashboard } = await import("../../src/dashboard/Dashboard");
    render(<Dashboard />);
    await screen.findAllByText("$1.23");

    const sessionSelect = screen.getByLabelText("Session");
    expect([...sessionSelect.querySelectorAll("optgroup")].map((group) => group.label)).toEqual([
      "Last 24 hours",
      "2+ days ago",
    ]);
  });

  test("filters reports and session choices by provider", async () => {
    const { Dashboard } = await import("../../src/dashboard/Dashboard");
    render(<Dashboard />);
    await screen.findAllByText("$1.23");

    fireEvent.change(screen.getByLabelText("Provider"), {
      target: { value: "anthropic" },
    });

    const sessionSelect = screen.getByLabelText("Session") as HTMLSelectElement;
    expect([...sessionSelect.options].map((option) => option.text)).toEqual([
      "All",
      "Other session",
    ]);
    expect([...sessionSelect.querySelectorAll("optgroup")].map((group) => group.label)).toEqual([
      "2+ days ago",
    ]);
    await waitFor(() => {
      const latestSummaryRequest = requestedUrls
        .filter((url) => url.startsWith("/api/summary?"))
        .at(-1);
      expect(latestSummaryRequest).toContain("provider=anthropic");
    });
  });

  test("shows individual calls when a session is selected", async () => {
    const { Dashboard } = await import("../../src/dashboard/Dashboard");
    render(<Dashboard />);
    await screen.findAllByText("$1.23");

    fireEvent.change(screen.getByLabelText("Session"), { target: { value: "session-1" } });

    expect((screen.getByLabelText("Bucket") as HTMLSelectElement).disabled).toBe(true);
    await waitFor(() => expect(screen.getByText("API cost by call")).toBeTruthy());
    expect(screen.getByText("One bar per call · idle time removed")).toBeTruthy();
  });

  test("refetches active reports after an SSE invalidation", async () => {
    const { Dashboard } = await import("../../src/dashboard/Dashboard");
    render(<Dashboard />);
    await screen.findAllByText("$1.23");
    const initialSummaryRequestCount = requestedUrls.filter((url) => url.startsWith("/api/summary?")).length;
    const eventSource = FakeEventSource.instances.at(-1);
    expect(eventSource).toBeDefined();

    act(() => eventSource?.emit("invalidate", { dataVersion: 2, reason: "usage-data" }));
    await waitFor(() => {
      expect(requestedUrls.filter((url) => url.startsWith("/api/summary?")).length)
        .toBeGreaterThan(initialSummaryRequestCount);
    });
  });
});

function createSession() {
  return {
    agentCount: 1,
    callCount: 10,
    createdAtMs: 1,
    inheritedOccurrenceCount: 2,
    lastCallAtMs: 2,
    sessionId: "session-1",
    title: "Test session",
    totalCostNano: 1_230_000_000,
    unpricedCallCount: 0,
    workDirectory: null,
    workspaceKey: "Workspace one",
  };
}

function latestSummaryParameters(): URLSearchParams {
  const latestRequest = requestedUrls.filter((url) => url.startsWith("/api/summary?")).at(-1);
  expect(latestRequest).toBeDefined();
  return new URLSearchParams(latestRequest?.split("?")[1]);
}
