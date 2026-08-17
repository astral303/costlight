import { join } from "node:path";
import {
  auditClaudeAgainstUsageReport,
  formatUsageComparisonCsv,
} from "../call-accounting/anthropic-usage-audit";
import { parseAnthropicUsageReport } from "../call-accounting/anthropic-usage-report";
import { parseClaudeUsageAuditArguments, parseRuntimeOptions } from "./config";
import { openDashboardDatabase } from "./database";

const auditArguments = parseClaudeUsageAuditArguments();
const options = parseRuntimeOptions(auditArguments.runtimeArguments);
const usageReport = parseAnthropicUsageReport(await Bun.file(auditArguments.reportPath).json());
const database = openDashboardDatabase(options.databasePath);
try {
  const report = auditClaudeAgainstUsageReport(database, usageReport, auditArguments.timeZone);
  if (report.status !== "compared") {
    console.log(JSON.stringify(report, null, 2));
  } else {
    // The per-day deviations are too wide to read as JSON, so stdout keeps the totals and the
    // detail goes to a spreadsheet-ready file whose path the summary reports.
    const csvPath = auditArguments.csvPath
      ?? join(options.dataDirectory, "claude-usage-deviations.csv");
    await Bun.write(csvPath, formatUsageComparisonCsv(report.rows));
    console.log(JSON.stringify({ csvPath, status: report.status, ...report.summary }, null, 2));
  }
} finally {
  database.close();
}
