import { basename, extname, relative, resolve, sep } from "node:path";
import { timingSafeEqual } from "node:crypto";
import { CallLedger } from "../call-accounting/ledger";
import { handleDashboardRoute } from "../dashboard/routes";
import { RotatingErrorLog, type ErrorLogContext } from "../error-logging/rotating-error-log";
import { LiveUpdateHub } from "../live-sync/hub";
import { handleLiveRoute } from "../live-sync/routes";
import { MeteredUsageService } from "../metered-usage/service";
import { isProMeteredClaudeModel } from "../pricing/anthropic-catalog";
import { PricingCatalog } from "../pricing/catalog";
import { handlePricingRoute } from "../pricing/routes";
import { createClaudeImportProvider } from "../session-import/claude/provider";
import { SessionImporter } from "../session-import/importer";
import { createKimiImportProvider } from "../session-import/kimi/provider";
import { SessionMonitor } from "../session-import/monitor";
import { handleSessionImportRoute } from "../session-import/routes";
import { isLoopbackHost, parseRuntimeOptions } from "./config";
import { openDashboardDatabase } from "./database";
import { createApplicationShutdown, OperationDrain } from "./shutdown";
import { registerTerminalExitShortcut } from "./terminal-exit";

const PRICING_REFRESH_INTERVAL_MS = 24 * 60 * 60 * 1_000;
const startedAtMs = Date.now();
const options = parseRuntimeOptions();
const errorLog = new RotatingErrorLog(options.dataDirectory);
const database = openDashboardDatabase(options.databasePath);
const hub = new LiveUpdateHub();
const pricingCatalog = new PricingCatalog(database, options.dataDirectory, {
  onRefreshFailure: ({ error, provider, sourceName }) => {
    reportError("pricing.refresh.failed", error, { provider, sourceName });
  },
});
await pricingCatalog.initialize();
await pricingCatalog.refreshIfStale();
const meteredUsage = new MeteredUsageService(database, {
  isProMeteredModel: isProMeteredClaudeModel,
});
const ledger = new CallLedger(database, pricingCatalog, meteredUsage.resolveMetering);
ledger.priceUnpricedCalls();
const importer = new SessionImporter(database, [
  createKimiImportProvider(options.kimiRoots),
  createClaudeImportProvider(options.claudeRoots),
], ledger);
const monitor = new SessionMonitor(importer, {
  onDataChanged: () => {
    hub.publish("usage-data");
  },
  onStatusChanged: () => {
    hub.publish("scan-status");
  },
  prepareForReconciliation: async (trigger) => {
    const refresh = await meteredUsage.refreshClaudeAccount(
      trigger === "manual" || trigger === "startup",
    );
    if (refresh.affectedFingerprints.length > 0) {
      ledger.rebuildCanonicalCalls(refresh.affectedFingerprints);
      hub.publish("metering-policy");
    }
  },
  watchFiles: options.watchFiles,
});
await monitor.start();

const requestDrain = new OperationDrain();
const server = Bun.serve({
  hostname: options.host,
  port: options.port,
  fetch(request) {
    return requestDrain.tryRun(() => handleRequest(request))
      ?? withSecurityHeaders(Response.json(
        { error: "Server is shutting down" },
        { status: 503, headers: { Connection: "close" } },
      ));
  },
});

const pricingRefreshTimer = setInterval(() => {
  void pricingCatalog.refreshIfStale().then((results) => {
    if (results.some((result) => result.status === "refreshed")) {
      hub.publish("pricing-catalog");
    }
  });
}, PRICING_REFRESH_INTERVAL_MS);

console.log(`Costlight listening on ${server.url.origin}`);

const stopListeningForTerminalExit = registerTerminalExitShortcut(requestShutdown);
const shutdown = createApplicationShutdown({
  closeDatabase: () => database.close(),
  closeLiveUpdates: () => hub.close(),
  requestDrain,
  stopHttpServer: () => server.stop(true),
  stopMonitor: () => monitor.close(),
  stopPricingTimer: () => clearInterval(pricingRefreshTimer),
  stopTerminalInput: stopListeningForTerminalExit,
  waitForPricingRefreshes: () => pricingCatalog.waitForRefreshes(),
});
let shutdownRequest: Promise<void> | null = null;

function requestShutdown(): void {
  if (shutdownRequest !== null) {
    return;
  }
  shutdownRequest = shutdown();
  void shutdownRequest.then(
    () => console.log("Costlight stopped."),
    (error) => {
      reportError("server.shutdown.failed", error);
      process.exitCode = 1;
    },
  );
}

process.once("SIGINT", requestShutdown);
process.once("SIGTERM", requestShutdown);

async function handleRequest(request: Request): Promise<Response> {
  let requestPath = "unknown";
  try {
    const url = new URL(request.url);
    requestPath = url.pathname;
    if (!isAuthorized(request)) {
      return withSecurityHeaders(Response.json(
        { error: "Unauthorized" },
        { status: 401, headers: { "WWW-Authenticate": "Basic realm=\"Costlight\"" } },
      ));
    }

    const response = handleLiveRoute(request, url, {
      database,
      hub,
      monitor,
      meteredUsage,
      pricingCatalog,
      startedAtMs,
    })
      ?? await handleSessionImportRoute(request, url, monitor)
      ?? await handlePricingRoute(request, url, { catalog: pricingCatalog, hub, ledger })
      ?? handleDashboardRoute(request, url, {
        database,
        privacyMode: options.privacyMode,
      })
      ?? await serveDashboardAsset(url);
    return withSecurityHeaders(response);
  } catch (error) {
    reportError("http.request.failed", error, {
      method: request.method,
      path: requestPath,
    });
    return withSecurityHeaders(Response.json({ error: "Internal server error" }, { status: 500 }));
  }
}

function isAuthorized(request: Request): boolean {
  if (isLoopbackHost(options.host)) {
    return true;
  }
  const authorization = request.headers.get("Authorization");
  if (authorization?.startsWith("Bearer ")) {
    return tokenMatches(authorization.slice("Bearer ".length));
  }
  if (authorization?.startsWith("Basic ")) {
    try {
      const credentials = Buffer.from(authorization.slice("Basic ".length), "base64").toString("utf8");
      const separatorIndex = credentials.indexOf(":");
      return separatorIndex !== -1 && tokenMatches(credentials.slice(separatorIndex + 1));
    } catch {
      return false;
    }
  }
  return false;
}

function tokenMatches(candidateToken: string): boolean {
  const configuredToken = options.accessToken;
  if (configuredToken === undefined) {
    return false;
  }
  const candidateBytes = Buffer.from(candidateToken);
  const configuredBytes = Buffer.from(configuredToken);
  return candidateBytes.length === configuredBytes.length
    && timingSafeEqual(candidateBytes, configuredBytes);
}

async function serveDashboardAsset(url: URL): Promise<Response> {
  if (url.pathname.startsWith("/api/")) {
    return Response.json({ error: "Not found" }, { status: 404 });
  }

  const distributionRoot = resolve("dist");
  let requestedPath: string;
  try {
    requestedPath = decodeURIComponent(url.pathname).replace(/^\/+/, "");
  } catch {
    return new Response("Invalid path", { status: 400 });
  }
  const candidatePath = resolve(distributionRoot, requestedPath || "index.html");
  const candidateRelativePath = relative(distributionRoot, candidatePath);
  if (candidateRelativePath.startsWith(`..${sep}`) || candidateRelativePath === "..") {
    return new Response("Invalid path", { status: 400 });
  }

  const candidateFile = Bun.file(candidatePath);
  if (await candidateFile.exists()) {
    return new Response(candidateFile);
  }
  if (extname(requestedPath) === "") {
    const indexFile = Bun.file(resolve(distributionRoot, "index.html"));
    if (await indexFile.exists()) {
      return new Response(indexFile);
    }
  }
  return new Response(`Not found: ${basename(candidatePath)}`, { status: 404 });
}

function withSecurityHeaders(response: Response): Response {
  const headers = new Headers(response.headers);
  headers.set("Content-Security-Policy", [
    "default-src 'self'",
    "base-uri 'none'",
    "connect-src 'self'",
    "font-src 'self'",
    "frame-ancestors 'none'",
    "img-src 'self' data:",
    "object-src 'none'",
    "script-src 'self'",
    "style-src 'self'",
  ].join("; "));
  headers.set("Cross-Origin-Opener-Policy", "same-origin");
  headers.set("Referrer-Policy", "no-referrer");
  headers.set("X-Content-Type-Options", "nosniff");
  headers.set("X-Frame-Options", "DENY");
  return new Response(response.body, {
    headers,
    status: response.status,
    statusText: response.statusText,
  });
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function reportError(event: string, error: unknown, context: ErrorLogContext = {}): void {
  console.error(`[${event}] ${errorMessage(error)}`);
  errorLog.writeError(event, error, context);
}
