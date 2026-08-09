import { basename, join } from "node:path";
import { watch, type FSWatcher } from "chokidar";
import type { ImportSummary, SessionImporter } from "./importer";

const DEFAULT_RECONCILIATION_INTERVAL_MS = 30_000;
const WATCH_DEBOUNCE_MS = 250;

export interface IngestionStatus {
  isScanning: boolean;
  lastError: string | null;
  lastScanStartedAtMs: number | null;
  lastSuccessfulScanMs: number | null;
  lastSummary: ImportSummary | null;
  watcherStatus: "disabled" | "running" | "starting" | "stopped";
}

interface SessionMonitorOptions {
  onDataChanged?: (summary: ImportSummary) => void;
  onStatusChanged?: (status: IngestionStatus) => void;
  reconciliationIntervalMs?: number;
  sourceRoots: readonly string[];
  watchFiles: boolean;
}

export class SessionMonitor {
  readonly #importer: Pick<SessionImporter, "reconcile">;
  readonly #options: SessionMonitorOptions;
  #debounceTimer: ReturnType<typeof setTimeout> | null = null;
  #isClosed = false;
  #queue: Promise<void> = Promise.resolve();
  #reconciliationTimer: ReturnType<typeof setInterval> | null = null;
  #status: IngestionStatus;
  #watcher: FSWatcher | null = null;

  constructor(importer: Pick<SessionImporter, "reconcile">, options: SessionMonitorOptions) {
    this.#importer = importer;
    this.#options = options;
    this.#status = {
      isScanning: false,
      lastError: null,
      lastScanStartedAtMs: null,
      lastSuccessfulScanMs: null,
      lastSummary: null,
      watcherStatus: options.watchFiles ? "starting" : "disabled",
    };
  }

  async start(): Promise<ImportSummary> {
    if (this.#options.watchFiles) {
      const sessionDirectories = this.#options.sourceRoots.map((root) => join(root, "sessions"));
      this.#watcher = watch(sessionDirectories, {
        awaitWriteFinish: { pollInterval: 50, stabilityThreshold: 100 },
        ignoreInitial: true,
        persistent: true,
      });
      this.#watcher.on("all", (_eventName, changedPath) => {
        if (isRelevantKimiFile(changedPath)) {
          this.#scheduleWatchedReconciliation();
        }
      });
      this.#watcher.on("error", (error) => {
        this.#status = { ...this.#status, lastError: errorMessage(error) };
        this.#emitStatus();
      });
      this.#status = { ...this.#status, watcherStatus: "running" };
      this.#emitStatus();
    }

    const reconciliationInterval = this.#options.reconciliationIntervalMs
      ?? DEFAULT_RECONCILIATION_INTERVAL_MS;
    this.#reconciliationTimer = setInterval(() => {
      void this.requestReconciliation("periodic");
    }, reconciliationInterval);

    return this.requestReconciliation("startup");
  }

  requestReconciliation(trigger: "manual" | "periodic" | "startup" | "watch" = "manual") {
    if (this.#isClosed) {
      return Promise.reject(new Error("The session monitor is stopped."));
    }

    const task = this.#queue.then(() => this.#runReconciliation(trigger));
    this.#queue = task.then(() => undefined, () => undefined);
    return task;
  }

  getStatus(): IngestionStatus {
    return this.#status;
  }

  async close(): Promise<void> {
    this.#isClosed = true;
    if (this.#debounceTimer !== null) {
      clearTimeout(this.#debounceTimer);
      this.#debounceTimer = null;
    }
    if (this.#reconciliationTimer !== null) {
      clearInterval(this.#reconciliationTimer);
      this.#reconciliationTimer = null;
    }
    if (this.#watcher !== null) {
      await this.#watcher.close();
      this.#watcher = null;
    }
    await this.#queue;
    this.#status = { ...this.#status, watcherStatus: "stopped" };
    this.#emitStatus();
  }

  async #runReconciliation(
    trigger: "manual" | "periodic" | "startup" | "watch",
  ): Promise<ImportSummary> {
    this.#status = {
      ...this.#status,
      isScanning: true,
      lastError: null,
      lastScanStartedAtMs: Date.now(),
    };
    this.#emitStatus();

    try {
      const summary = await this.#importer.reconcile();
      this.#status = {
        ...this.#status,
        isScanning: false,
        lastError: summary.sourceErrorCount > 0
          ? `${summary.sourceErrorCount} source file(s) could not be read; they will be retried.`
          : null,
        lastSuccessfulScanMs: Date.now(),
        lastSummary: summary,
      };
      if (trigger !== "periodic" || didLedgerChange(summary)) {
        this.#options.onDataChanged?.(summary);
      }
      this.#emitStatus();
      return summary;
    } catch (error) {
      this.#status = {
        ...this.#status,
        isScanning: false,
        lastError: errorMessage(error),
      };
      this.#emitStatus();
      throw error;
    }
  }

  #scheduleWatchedReconciliation(): void {
    if (this.#debounceTimer !== null) {
      clearTimeout(this.#debounceTimer);
    }
    this.#debounceTimer = setTimeout(() => {
      this.#debounceTimer = null;
      void this.requestReconciliation("watch");
    }, WATCH_DEBOUNCE_MS);
  }

  #emitStatus(): void {
    this.#options.onStatusChanged?.(this.#status);
  }
}

function isRelevantKimiFile(filePath: string): boolean {
  const fileName = basename(filePath);
  return fileName === "state.json" || fileName === "wire.jsonl";
}

function didLedgerChange(summary: ImportSummary): boolean {
  return summary.insertedOccurrenceCount > 0
    || summary.removedOccurrenceCount > 0
    || summary.rewrittenSourceCount > 0;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
