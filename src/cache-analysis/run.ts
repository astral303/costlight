import { openDashboardDatabase } from "../app/database";
import { parseRuntimeOptions } from "../app/config";
import { SessionImporter } from "../session-import/importer";
import { analyzeCacheWindow, defaultCacheAnalysisOptions } from "./analyzer";
import { loadCanonicalCacheCalls } from "./call-loader";
import { formatCacheAnalysisReport } from "./report";

const options = parseRuntimeOptions();
const database = openDashboardDatabase(":memory:");

try {
  const importer = new SessionImporter(database, options.kimiRoots);
  const importSummary = await importer.reconcile();
  if (importSummary.sourceErrorCount > 0) {
    throw new Error(
      `Unable to analyze all Kimi logs: ${importSummary.sourceErrorCount} source files failed to import.`,
    );
  }

  const loadedCalls = await loadCanonicalCacheCalls(database);
  const primary = analyzeCacheWindow(loadedCalls.calls);
  const sensitivity = [65_536, 98_304, 131_072].map((minimumCacheReadTokens) =>
    analyzeCacheWindow(loadedCalls.calls, {
      ...defaultCacheAnalysisOptions,
      minimumCacheReadTokens,
    }));

  console.log(formatCacheAnalysisReport({
    generatedAt: new Date(),
    importSummary,
    loadedCalls,
    primary,
    sensitivity,
  }));
} finally {
  database.close();
}
