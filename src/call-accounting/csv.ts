export type CsvRow = Readonly<Record<string, number | string>>;

export interface CsvTable {
  columns: readonly string[];
  rows: readonly CsvRow[];
}

/** Cells follow the column order, so a row missing a column reads as empty instead of shifting. */
export function formatCsvTable(table: CsvTable): string {
  const lines = [table.columns.map((column) => csvField(column)).join(",")];
  for (const row of table.rows) {
    lines.push(table.columns
      .map((column) => csvField(String(row[column] ?? "")))
      .join(","));
  }

  return csvText(lines);
}

/** Quotes only what RFC 4180 requires, so ordinary values stay readable in a diff. */
export function csvField(value: string): string {
  return /["\n,]/.test(value) ? `"${value.replaceAll('"', '""')}"` : value;
}

/** Readers expect a trailing newline, so the last row is terminated like every other. */
export function csvText(lines: readonly string[]): string {
  return `${lines.join("\n")}\n`;
}
