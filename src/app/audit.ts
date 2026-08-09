import { auditWithCcusage } from "../call-accounting/ccusage-audit";
import { parseRuntimeOptions } from "./config";
import { openDashboardDatabase } from "./database";

const options = parseRuntimeOptions();
const database = openDashboardDatabase(options.databasePath);
try {
  console.log(JSON.stringify(await auditWithCcusage(database), null, 2));
} finally {
  database.close();
}
