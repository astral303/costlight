import { describe, expect, test } from "bun:test";
import { parseRuntimeOptions, selectCompatibleDataDirectory } from "../../src/app/config";

const environment = {
  LOCALAPPDATA: "C:\\synthetic-app-data",
};

describe("parseRuntimeOptions", () => {
  test("binds to loopback and uses the platform application-data directory by default", () => {
    const options = parseRuntimeOptions([], environment);

    expect(options.host).toBe("127.0.0.1");
    expect(options.databasePath).toContain("Costlight");
    expect(options.watchFiles).toBe(true);
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
