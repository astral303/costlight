/**
 * Diagnoses a shortfall reported by `bun run audit:claude-usage`. Each mode writes one CSV table
 * to stdout, so the output pipes straight into a CSV tool; progress goes to stderr.
 */
import { parseRuntimeOptions, parseUsageDiagnosticsArguments } from "../app/config";
import { openDashboardDatabase } from "../app/database";
import { type CsvRow, formatCsvTable } from "../call-accounting/csv";
import { loadReplayClassifications } from "./replay-loader";
import {
  summarizeAbortMarkers,
  summarizeCallsPerHour,
  summarizeReplayClassifications,
  summarizeSessionIntegrity,
} from "./reports";
import { loadClaudeTranscripts } from "./transcript-loader";

const diagnosticsArguments = parseUsageDiagnosticsArguments();
const options = parseRuntimeOptions(diagnosticsArguments.runtimeArguments);

if (diagnosticsArguments.mode === "replays") {
  console.error(`database: ${options.databasePath}`);
  console.error(`UTC days: ${diagnosticsArguments.fromDate} to ${diagnosticsArguments.toDate}`);

  const database = openDashboardDatabase(options.databasePath);
  try {
    const classifications = loadReplayClassifications(
      database,
      diagnosticsArguments.fromDate,
      diagnosticsArguments.toDate,
    );
    process.stdout.write(formatCsvTable(summarizeReplayClassifications(classifications)));
  } finally {
    database.close();
  }
} else {
  console.error(`transcripts: ${options.claudeRoots.join(", ")}`);
  const transcripts = await loadClaudeTranscripts(options.claudeRoots);
  console.error(`${transcripts.length} transcripts read`);

  if (diagnosticsArguments.mode === "aborts") {
    process.stdout.write(formatCsvTable(summarizeAbortMarkers(transcripts)));
  } else if (diagnosticsArguments.mode === "hourly") {
    process.stdout.write(formatCsvTable(
      summarizeCallsPerHour(transcripts, diagnosticsArguments.day),
    ));
  } else {
    const table = summarizeSessionIntegrity(transcripts, diagnosticsArguments.day);
    process.stdout.write(formatCsvTable(table));
    console.error(describeSessionIntegrity(table.rows));
  }
}

function describeSessionIntegrity(rows: readonly CsvRow[]): string {
  const suspect = rows.filter((row) => (
    Number(row.dangling) > 0 || Number(row.roots) > 1 || Number(row.malformed) > 0
  ));
  return suspect.length === 0
    ? "every session on this day is structurally intact"
    : `${suspect.length} session(s) show missing records`;
}
