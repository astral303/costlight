import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

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
      return Response.json({ sessions: [createSession()] });
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
            value: "session-1",
            workspace: "workspace-1",
          },
          {
            label: "Other session",
            provider: "anthropic",
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
        ingestion: { isScanning: false, lastSuccessfulScanMs: 1, watcherStatus: "running" },
        metering: {
          claude: {
            detectedAtMs: 1,
            error: null,
            lastAttemptAtMs: 1,
            lastSuccessAtMs: 1,
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
              refreshStatus: "not-attempted",
              sourceKind: "bundled",
              sourceName: "bundled-claude-2026-08-09",
              updatedAtMs: null,
            },
            {
              error: null,
              hasOverrides: false,
              isStale: false,
              provider: "moonshotai",
              refreshStatus: "not-attempted",
              sourceKind: "bundled",
              sourceName: "bundled-kimi-2026-08-09",
              updatedAtMs: null,
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
    expect(screen.getByText(/Claude Pro subscription detected/)).toBeTruthy();
    expect(screen.getAllByText("Test session").length).toBe(2);
    expect(screen.getByTestId("bucket-chart")).toBeTruthy();
    expect(screen.getByTestId("cumulative-chart")).toBeTruthy();
  });

  test("keeps refresh details explicit and secondary actions disclosed", async () => {
    const { Dashboard } = await import("../../src/dashboard/Dashboard");
    render(<Dashboard />);
    await screen.findAllByText("$1.23");

    expect(screen.queryByText("Local usage intelligence")).toBeNull();
    expect(screen.queryByText(/Canonical API spend/)).toBeNull();
    expect(screen.getByText("Watches files · Rechecks every 30s")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Rescan" }).getAttribute("title")).toBe("Rescan");

    const pricingSummary = screen.getByText(/Pricing:/).closest("summary");
    expect(pricingSummary).not.toBeNull();
    fireEvent.click(pricingSummary as HTMLElement);
    expect(screen.getByText("Checked at startup and every 24 hours. Existing calls keep their recorded rates.")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Update pricing" }));
    await waitFor(() => expect(requestedUrls).toContain("/api/pricing/refresh"));
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
