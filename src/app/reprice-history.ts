import { CallLedger } from "../call-accounting/ledger";
import { PricingCatalog } from "../pricing/catalog";
import { parseRuntimeOptions } from "./config";
import { openDashboardDatabase } from "./database";

const options = parseRuntimeOptions();
const database = openDashboardDatabase(options.databasePath);
try {
  const catalog = new PricingCatalog(database, options.dataDirectory);
  await catalog.initialize();
  const pricingRefresh = await catalog.forceRefresh();
  const ledger = new CallLedger(database, catalog);
  ledger.repriceAllCalls();
  const totals = database
    .query<{ call_count: number; total_cost_nano: number; unpriced_call_count: number }, []>(`
      SELECT
        COALESCE(SUM(CASE WHEN is_metered = 1 THEN 1 ELSE 0 END), 0) AS call_count,
        COALESCE(SUM(CASE WHEN is_metered = 1 THEN total_cost_nano ELSE 0 END), 0)
          AS total_cost_nano,
        COALESCE(SUM(CASE WHEN is_metered = 1 AND total_cost_nano IS NULL THEN 1 ELSE 0 END), 0)
          AS unpriced_call_count
      FROM api_calls
    `)
    .get();
  console.log(JSON.stringify({ pricingRefresh, totals }, null, 2));
} finally {
  database.close();
}
