import {
  appendFileSync,
  existsSync,
  mkdirSync,
  renameSync,
  rmSync,
  statSync,
} from "node:fs";
import { join } from "node:path";

const DEFAULT_ARCHIVE_COUNT = 5;
const DEFAULT_MAX_FILE_BYTES = 5 * 1024 * 1024;
const LOG_DIRECTORY_NAME = "logs";
const LOG_FILE_NAME = "costlight.log";

type ErrorLogContextValue = boolean | null | number | string;

export type ErrorLogContext = Readonly<Record<string, ErrorLogContextValue>>;

export interface RotatingErrorLogOptions {
  archiveCount?: number;
  maxFileBytes?: number;
  now?: () => Date;
}

export class RotatingErrorLog {
  readonly directoryPath: string;
  readonly filePath: string;
  readonly #archiveCount: number;
  readonly #maxFileBytes: number;
  readonly #now: () => Date;

  constructor(dataDirectory: string, options: RotatingErrorLogOptions = {}) {
    this.#archiveCount = options.archiveCount ?? DEFAULT_ARCHIVE_COUNT;
    this.#maxFileBytes = options.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES;
    this.#now = options.now ?? (() => new Date());
    requirePositiveInteger(this.#archiveCount, "archiveCount");
    requirePositiveInteger(this.#maxFileBytes, "maxFileBytes");

    this.directoryPath = join(dataDirectory, LOG_DIRECTORY_NAME);
    this.filePath = join(this.directoryPath, LOG_FILE_NAME);
    mkdirSync(this.directoryPath, { recursive: true });
  }

  writeError(event: string, error: unknown, context: ErrorLogContext = {}): void {
    const entry = serializeEntry(this.#now(), event, error, context);
    try {
      this.#rotateBeforeWriting(Buffer.byteLength(entry));
      appendFileSync(this.filePath, entry, "utf8");
    } catch (writeError) {
      console.error(`Unable to write local error log: ${errorMessage(writeError)}`);
    }
  }

  #rotateBeforeWriting(nextEntryBytes: number): void {
    if (!existsSync(this.filePath)) {
      return;
    }
    const currentFileBytes = statSync(this.filePath).size;
    if (currentFileBytes === 0 || currentFileBytes + nextEntryBytes <= this.#maxFileBytes) {
      return;
    }

    rmSync(this.#archivePath(this.#archiveCount), { force: true });
    for (let archive = this.#archiveCount - 1; archive >= 1; archive -= 1) {
      const source = this.#archivePath(archive);
      if (existsSync(source)) {
        renameSync(source, this.#archivePath(archive + 1));
      }
    }
    renameSync(this.filePath, this.#archivePath(1));
  }

  #archivePath(archive: number): string {
    return join(this.directoryPath, `costlight.${archive}.log`);
  }
}

function serializeEntry(
  timestamp: Date,
  event: string,
  error: unknown,
  context: ErrorLogContext,
): string {
  const details = errorDetails(error);
  return `${JSON.stringify({
    context,
    event,
    level: "error",
    message: details.message,
    name: details.name,
    ...(details.stack === undefined ? {} : { stack: details.stack }),
    timestamp: timestamp.toISOString(),
  })}\n`;
}

function errorDetails(error: unknown): { message: string; name: string; stack?: string } {
  if (error instanceof Error) {
    return {
      message: error.message,
      name: error.name,
      ...(error.stack === undefined ? {} : { stack: error.stack }),
    };
  }
  return { message: String(error), name: "NonError" };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function requirePositiveInteger(value: number, optionName: string): void {
  if (!Number.isInteger(value) || value < 1) {
    throw new RangeError(`${optionName} must be a positive integer.`);
  }
}
