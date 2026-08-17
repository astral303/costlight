import { auditClaudeWithCcusage, auditKimiWithCcusage } from "../call-accounting/ccusage-audit";
import { parseRuntimeOptions } from "./config";
import { openDashboardDatabase } from "./database";

const options = parseRuntimeOptions();
const database = openDashboardDatabase(options.databasePath);
try {
  const report = {
    claude: await auditClaudeWithCcusage(database),
    kimi: await auditKimiWithCcusage(database),
  };
  console.log(JSON.stringify(report, null, 2));
  // One provider's ccusage failure still prints the other's numbers, so the exit code carries
  // the failure that the report body no longer raises.
  if (report.claude.status === "failed" || report.kimi.status === "failed") {
    process.exitCode = 1;
  }
} finally {
  database.close();
}
