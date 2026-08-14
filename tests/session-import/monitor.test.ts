import { describe, expect, test } from "bun:test";
import type { ImportSummary } from "../../src/session-import/importer";
import { SessionMonitor } from "../../src/session-import/monitor";

const emptySummary: ImportSummary = {
  discoveredSessionCount: 0,
  discoveredSourceCount: 0,
  insertedOccurrenceCount: 0,
  malformedLineCount: 0,
  removedOccurrenceCount: 0,
  rewrittenSourceCount: 0,
  sourceDataBytesRead: 0,
  sourceErrorCount: 0,
};

describe("SessionMonitor", () => {
  test("serializes overlapping reconciliation requests", async () => {
    let activeReconciliations = 0;
    let maximumActiveReconciliations = 0;
    let reconciliationCount = 0;
    const monitor = new SessionMonitor({
      getWatchDirectories: () => [],
      isRelevantFile: () => false,
      async reconcile() {
        activeReconciliations += 1;
        maximumActiveReconciliations = Math.max(maximumActiveReconciliations, activeReconciliations);
        reconciliationCount += 1;
        await Bun.sleep(5);
        activeReconciliations -= 1;
        return emptySummary;
      },
    }, {
      reconciliationIntervalMs: 60_000,
      watchFiles: false,
    });

    try {
      await monitor.start();
      await Promise.all([
        monitor.requestReconciliation("manual"),
        monitor.requestReconciliation("watch"),
        monitor.requestReconciliation("periodic"),
      ]);
      expect(maximumActiveReconciliations).toBe(1);
      expect(reconciliationCount).toBe(4);
    } finally {
      await monitor.close();
    }
  });

  test("prepares one account snapshot before each serialized import", async () => {
    const events: string[] = [];
    const monitor = new SessionMonitor({
      getWatchDirectories: () => [],
      isRelevantFile: () => false,
      async reconcile() {
        events.push("import");
        return emptySummary;
      },
    }, {
      prepareForReconciliation: async (trigger) => {
        events.push(`prepare:${trigger}`);
      },
      reconciliationIntervalMs: 60_000,
      watchFiles: false,
    });

    try {
      await monitor.start();
      await monitor.requestReconciliation("manual");
      expect(events).toEqual([
        "prepare:startup",
        "import",
        "prepare:manual",
        "import",
      ]);
    } finally {
      await monitor.close();
    }
  });
});
