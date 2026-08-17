import { describe, expect, test } from "bun:test";
import {
  parseClaudeUsageAuditArguments,
  parseRuntimeOptions,
  parseUsageDiagnosticsArguments,
  selectCompatibleDataDirectory,
} from "../../src/app/config";

const environment = {
  LOCALAPPDATA: "C:\\synthetic-app-data",
};

describe("parseRuntimeOptions", () => {
  test("binds to loopback and uses the platform application-data directory by default", () => {
    const options = parseRuntimeOptions([], environment);

    expect(options.host).toBe("127.0.0.1");
    expect(options.databasePath).toContain("Costlight");
    expect(options.claudeRoots[0]).toContain(".claude");
    expect(options.watchFiles).toBe(true);
  });

  test("honors an explicit Claude transcript root", () => {
    const options = parseRuntimeOptions(
      ["--claude-root", "C:\\synthetic-claude"],
      environment,
    );

    expect(options.claudeRoots).toEqual(["C:\\synthetic-claude"]);
  });

  test("requires a sufficiently long token for non-loopback access", () => {
    expect(() => parseRuntimeOptions(["--host", "0.0.0.0"], environment)).toThrow(
      "Non-loopback binding requires",
    );
    expect(() => parseRuntimeOptions([
      "--host",
      "0.0.0.0",
      "--access-token",
      "short",
    ], environment)).toThrow();

    const options = parseRuntimeOptions([
      "--host",
      "0.0.0.0",
      "--access-token",
      "a-secure-test-token",
    ], environment);
    expect(options.host).toBe("0.0.0.0");
  });

  test("reuses the existing pre-Costlight data directory", () => {
    const selectedDirectory = selectCompatibleDataDirectory(
      "application-data",
      "Costlight",
      "PreviousName",
      (path) => path.endsWith("PreviousName"),
    );

    expect(selectedDirectory).toContain("PreviousName");
  });
});

describe("parseClaudeUsageAuditArguments", () => {
  test("keeps runtime options for the shared parser and defaults the export time zone", () => {
    const auditArguments = parseClaudeUsageAuditArguments([
      "--report",
      "usage.json",
      "--data-dir",
      "C:\\synthetic-data",
    ]);

    expect(auditArguments.reportPath).toBe("usage.json");
    expect(auditArguments.csvPath).toBeUndefined();
    expect(auditArguments.layout).toBe("long");
    expect(auditArguments.timeZone).toBe("UTC");
    expect(auditArguments.runtimeArguments).toEqual(["--data-dir", "C:\\synthetic-data"]);
  });

  test("accepts an explicit deviation file, layout and time zone", () => {
    const auditArguments = parseClaudeUsageAuditArguments([
      "--csv",
      "deviations.csv",
      "--layout",
      "wide",
      "--report",
      "usage.json",
      "--timezone",
      "America/New_York",
    ]);

    expect(auditArguments.csvPath).toBe("deviations.csv");
    expect(auditArguments.layout).toBe("wide");
    expect(auditArguments.timeZone).toBe("America/New_York");
    expect(auditArguments.runtimeArguments).toEqual([]);
  });

  test("rejects a missing export, an unknown layout and an unusable time zone", () => {
    expect(() => parseClaudeUsageAuditArguments([])).toThrow("--report requires the usage export");
    expect(() => parseClaudeUsageAuditArguments(["--report", "usage.json", "--layout", "tall"]))
      .toThrow("--layout accepts long or wide, not tall.");
    expect(() => parseClaudeUsageAuditArguments(["--report", "usage.json", "--timezone", "Mars"]))
      .toThrow("Invalid time zone: Mars");
  });
});

describe("parseUsageDiagnosticsArguments", () => {
  const today = new Date("2026-08-17T12:00:00Z");

  test("defaults to the replay summary over the trailing thirty days", () => {
    const diagnostics = parseUsageDiagnosticsArguments(["--data-dir", "C:\\synthetic-data"], today);

    expect(diagnostics.mode).toBe("replays");
    expect(diagnostics).toMatchObject({ fromDate: "2026-07-19", toDate: "2026-08-17" });
    expect(diagnostics.runtimeArguments).toEqual(["--data-dir", "C:\\synthetic-data"]);
  });

  test("carries only the scope its mode reads", () => {
    const sessions = parseUsageDiagnosticsArguments(
      ["--mode", "sessions", "--day", "2026-08-03"],
      today,
    );
    const aborts = parseUsageDiagnosticsArguments(["--mode", "aborts"], today);

    expect(sessions).toEqual({ day: "2026-08-03", mode: "sessions", runtimeArguments: [] });
    expect(aborts).toEqual({ mode: "aborts", runtimeArguments: [] });
  });

  test("rejects an unknown mode, a day-scoped mode with no day and a malformed date", () => {
    expect(() => parseUsageDiagnosticsArguments(["--mode", "guess"], today))
      .toThrow("--mode accepts aborts, hourly, replays, sessions, not guess.");
    expect(() => parseUsageDiagnosticsArguments(["--mode", "hourly"], today))
      .toThrow("--mode hourly requires --day <YYYY-MM-DD>.");
    expect(() => parseUsageDiagnosticsArguments(["--from", "08/03/2026"], today))
      .toThrow("--from requires a YYYY-MM-DD date, not 08/03/2026.");
  });
});
