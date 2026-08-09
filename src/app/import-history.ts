import { CallLedger } from "../call-accounting/ledger";
import { PricingCatalog } from "../pricing/catalog";
import { SessionImporter } from "../session-import/importer";
import { parseRuntimeOptions } from "./config";
import { openDashboardDatabase } from "./database";

const options = parseRuntimeOptions();
const database = openDashboardDatabase(options.databasePath);

try {
  const pricingCatalog = new PricingCatalog(database, options.dataDirectory);
  await pricingCatalog.initialize();
  const pricingRefresh = await pricingCatalog.refreshIfStale();
  const ledger = new CallLedger(database, pricingCatalog.resolve.bind(pricingCatalog));
  const importer = new SessionImporter(database, options.kimiRoots, ledger);
  const summary = await importer.reconcile();
  ledger.priceUnpricedCalls();
  const totals = database
    .query<{
      api_call_count: number;
      occurrence_count: number;
      session_count: number;
      subagent_call_count: number;
      total_cost_nano: number;
      unpriced_call_count: number;
    }, []>(`
      SELECT
        (SELECT COUNT(*) FROM sessions) AS session_count,
        (SELECT COUNT(*) FROM usage_occurrences) AS occurrence_count,
        (SELECT COUNT(*) FROM api_calls) AS api_call_count,
        (SELECT COUNT(*) FROM api_calls WHERE total_cost_nano IS NULL) AS unpriced_call_count,
        (SELECT COALESCE(SUM(total_cost_nano), 0) FROM api_calls) AS total_cost_nano,
        (
          SELECT COUNT(*)
          FROM api_calls AS call
          JOIN agents AS agent
            ON agent.session_id = call.session_id AND agent.agent_id = call.agent_id
          WHERE agent.agent_type = 'sub'
        ) AS subagent_call_count
    `)
    .get();

  console.log(JSON.stringify({ ...summary, pricingRefresh, totals }, null, 2));
} finally {
  database.close();
}
