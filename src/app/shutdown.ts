export class OperationDrain {
  #activeOperationCount = 0;
  #isAcceptingOperations = true;
  readonly #idleWaiters = new Set<() => void>();

  tryRun<Value>(operation: () => Value | PromiseLike<Value>): Promise<Value> | null {
    if (!this.#isAcceptingOperations) {
      return null;
    }

    this.#activeOperationCount += 1;
    try {
      return Promise.resolve(operation()).finally(() => this.#finishOperation());
    } catch (error) {
      this.#finishOperation();
      return Promise.reject(error);
    }
  }

  stopAccepting(): void {
    this.#isAcceptingOperations = false;
  }

  waitForIdle(): Promise<void> {
    if (this.#activeOperationCount === 0) {
      return Promise.resolve();
    }
    return new Promise((resolve) => this.#idleWaiters.add(resolve));
  }

  #finishOperation(): void {
    this.#activeOperationCount -= 1;
    if (this.#activeOperationCount !== 0) {
      return;
    }
    for (const resolve of this.#idleWaiters) {
      resolve();
    }
    this.#idleWaiters.clear();
  }
}

interface ApplicationShutdownDependencies {
  closeDatabase(): void;
  closeLiveUpdates(): void;
  requestDrain: Pick<OperationDrain, "stopAccepting" | "waitForIdle">;
  stopHttpServer(): Promise<void>;
  stopMonitor(): Promise<void>;
  stopPricingTimer(): void;
  stopTerminalInput(): void;
  waitForPricingRefreshes(): Promise<void>;
}

export function createApplicationShutdown(
  dependencies: ApplicationShutdownDependencies,
): () => Promise<void> {
  let shutdownPromise: Promise<void> | null = null;

  return () => {
    shutdownPromise ??= performShutdown(dependencies);
    return shutdownPromise;
  };
}

async function performShutdown(dependencies: ApplicationShutdownDependencies): Promise<void> {
  dependencies.stopTerminalInput();
  dependencies.stopPricingTimer();
  dependencies.requestDrain.stopAccepting();
  const serverStopped = dependencies.stopHttpServer();
  dependencies.closeLiveUpdates();

  await Promise.all([
    serverStopped,
    dependencies.requestDrain.waitForIdle(),
    dependencies.stopMonitor(),
    dependencies.waitForPricingRefreshes(),
  ]);

  dependencies.closeDatabase();
}
