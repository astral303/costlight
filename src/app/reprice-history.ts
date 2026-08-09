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
  const ledger = new CallLedger(database, catalog.resolve.bind(catalog));
  ledger.repriceAllCalls();
  const totals = database
    .query<{ call_count: number; total_cost_nano: number; unpriced_call_count: number }, []>(`
      SELECT
        COUNT(*) AS call_count,
        COALESCE(SUM(total_cost_nano), 0) AS total_cost_nano,
        SUM(CASE WHEN total_cost_nano IS NULL THEN 1 ELSE 0 END) AS unpriced_call_count
      FROM api_calls
    `)
    .get();
  console.log(JSON.stringify({ pricingRefresh, totals }, null, 2));
} finally {
  database.close();
}
