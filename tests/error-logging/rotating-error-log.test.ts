import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RotatingErrorLog } from "../../src/error-logging/rotating-error-log";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) => rm(directory, { force: true, recursive: true })),
  );
});

describe("RotatingErrorLog", () => {
  test("writes structured errors inside the data-directory logs subdirectory", async () => {
    const dataDirectory = await createTemporaryDirectory();
    const log = new RotatingErrorLog(dataDirectory, {
      now: () => new Date("2026-08-15T17:30:00.000Z"),
    });

    log.writeError("pricing.refresh.failed", new Error("FOREIGN KEY constraint failed"), {
      provider: "anthropic",
      sourceName: "anthropic",
    });

    expect((await stat(join(dataDirectory, "logs"))).isDirectory()).toBe(true);
    const record = JSON.parse(await readFile(log.filePath, "utf8")) as Record<string, unknown>;
    expect(record).toMatchObject({
      context: { provider: "anthropic", sourceName: "anthropic" },
      event: "pricing.refresh.failed",
      level: "error",
      message: "FOREIGN KEY constraint failed",
      name: "Error",
      timestamp: "2026-08-15T17:30:00.000Z",
    });
    expect(record.stack).toBeString();
  });

  test("rotates the active log and bounds retained archives", async () => {
    const dataDirectory = await createTemporaryDirectory();
    const log = new RotatingErrorLog(dataDirectory, {
      archiveCount: 2,
      maxFileBytes: 1,
    });

    for (const event of ["first", "second", "third", "fourth"]) {
      log.writeError(event, new Error(event));
    }

    expect(await readEvent(log.filePath)).toBe("fourth");
    expect(await readEvent(join(log.directoryPath, "costlight.1.log"))).toBe("third");
    expect(await readEvent(join(log.directoryPath, "costlight.2.log"))).toBe("second");
  });
});

async function createTemporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "costlight-error-log-test-"));
  temporaryDirectories.push(directory);
  return directory;
}

async function readEvent(path: string): Promise<unknown> {
  const record = JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
  return record.event;
}
