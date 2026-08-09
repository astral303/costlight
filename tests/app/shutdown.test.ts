import { describe, expect, test } from "bun:test";
import { createApplicationShutdown, OperationDrain } from "../../src/app/shutdown";

describe("application shutdown", () => {
  test("drains active work before closing the database", async () => {
    const activeRequest = deferred();
    const httpServer = deferred();
    const monitor = deferred();
    const pricing = deferred();
    const requestDrain = new OperationDrain();
    const events: string[] = [];
    const request = requestDrain.tryRun(() => activeRequest.promise);
    expect(request).not.toBeNull();

    const shutdown = createApplicationShutdown({
      closeDatabase() {
        events.push("database closed");
      },
      closeLiveUpdates() {
        events.push("live updates closed");
      },
      requestDrain,
      stopHttpServer() {
        events.push("HTTP server stopping");
        return httpServer.promise;
      },
      stopMonitor() {
        events.push("monitor stopping");
        return monitor.promise;
      },
      stopPricingTimer() {
        events.push("pricing timer stopped");
      },
      stopTerminalInput() {
        events.push("terminal input stopped");
      },
      waitForPricingRefreshes() {
        events.push("pricing draining");
        return pricing.promise;
      },
    });

    const firstShutdown = shutdown();
    expect(shutdown()).toBe(firstShutdown);
    expect(requestDrain.tryRun(() => Promise.resolve())).toBeNull();
    expect(events).toEqual([
      "terminal input stopped",
      "pricing timer stopped",
      "HTTP server stopping",
      "live updates closed",
      "monitor stopping",
      "pricing draining",
    ]);

    activeRequest.resolve();
    httpServer.resolve();
    monitor.resolve();
    await Promise.resolve();
    expect(events).not.toContain("database closed");

    pricing.resolve();
    await firstShutdown;
    await request;
    expect(events.at(-1)).toBe("database closed");
  });

  test("releases its drain when an operation throws synchronously", async () => {
    const requestDrain = new OperationDrain();
    const failedOperation = requestDrain.tryRun(() => {
      throw new Error("synthetic failure");
    });

    await expect(failedOperation).rejects.toThrow("synthetic failure");
    await expect(requestDrain.waitForIdle()).resolves.toBeUndefined();
  });
});

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolvePromise = () => {};
  const promise = new Promise<void>((resolve) => {
    resolvePromise = resolve;
  });
  return { promise, resolve: resolvePromise };
}
