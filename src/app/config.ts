import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { z } from "zod";
import { assertValidTimeZone } from "../dashboard/bucketing";

const DEFAULT_PORT = 4637;
// Anthropic's web UI buckets the usage export server-side, so its days are not the local ones.
const DEFAULT_USAGE_REPORT_TIME_ZONE = "UTC";

const runtimeOptionsSchema = z.object({
  dataDirectory: z.string().min(1),
  databasePath: z.string().min(1),
  host: z.string().min(1),
  port: z.number().int().min(1).max(65_535),
  accessToken: z.string().min(16).optional(),
  claudeRoots: z.array(z.string().min(1)).min(1),
  kimiRoots: z.array(z.string().min(1)).min(1),
  privacyMode: z.boolean(),
  watchFiles: z.boolean(),
});

export type RuntimeOptions = z.infer<typeof runtimeOptionsSchema>;

interface MutableRuntimeOptions {
  accessToken: string | undefined;
  claudeRoots: string[];
  dataDirectory: string | undefined;
  host: string;
  kimiRoots: string[];
  port: number;
  privacyMode: boolean;
  watchFiles: boolean;
}

export function parseRuntimeOptions(
  arguments_: readonly string[] = Bun.argv.slice(2),
  environment: Readonly<Record<string, string | undefined>> = Bun.env,
): RuntimeOptions {
  const options: MutableRuntimeOptions = {
    accessToken: environment.COSTLIGHT_TOKEN,
    claudeRoots: resolveClaudeRoots(environment),
    dataDirectory: undefined,
    host: "127.0.0.1",
    kimiRoots: resolveKimiRoots(environment),
    port: DEFAULT_PORT,
    privacyMode: false,
    watchFiles: true,
  };

  for (let index = 0; index < arguments_.length; index += 1) {
    const argument = arguments_[index];
    if (argument === undefined) {
      continue;
    }

    switch (argument) {
      case "--access-token":
        options.accessToken = requireOptionValue(arguments_, ++index, argument);
        break;
      case "--claude-root":
        options.claudeRoots = [requireOptionValue(arguments_, ++index, argument)];
        break;
      case "--data-dir":
        options.dataDirectory = requireOptionValue(arguments_, ++index, argument);
        break;
      case "--host":
        options.host = requireOptionValue(arguments_, ++index, argument);
        break;
      case "--kimi-root":
        options.kimiRoots = [requireOptionValue(arguments_, ++index, argument)];
        break;
      case "--no-watch":
        options.watchFiles = false;
        break;
      case "--port":
        options.port = Number(requireOptionValue(arguments_, ++index, argument));
        break;
      case "--privacy":
        options.privacyMode = true;
        break;
      default:
        throw new Error(`Unknown option: ${argument}`);
    }
  }

  const dataDirectory = resolve(options.dataDirectory ?? resolveDefaultDataDirectory(environment));
  const parsedOptions = runtimeOptionsSchema.parse({
    ...options,
    dataDirectory,
    databasePath: join(dataDirectory, "dashboard.sqlite"),
    claudeRoots: options.claudeRoots.map((root) => resolve(root)),
    kimiRoots: options.kimiRoots.map((root) => resolve(root)),
  });

  if (!isLoopbackHost(parsedOptions.host) && parsedOptions.accessToken === undefined) {
    throw new Error("Non-loopback binding requires --access-token or COSTLIGHT_TOKEN.");
  }

  return parsedOptions;
}

export interface ClaudeUsageAuditArguments {
  csvPath: string | undefined;
  reportPath: string;
  runtimeArguments: readonly string[];
  timeZone: string;
}

/**
 * Splits the usage-audit options out of the command line and passes everything else through to
 * `parseRuntimeOptions`, so the shared runtime options carry no audit-only flags.
 */
export function parseClaudeUsageAuditArguments(
  arguments_: readonly string[] = Bun.argv.slice(2),
): ClaudeUsageAuditArguments {
  const runtimeArguments: string[] = [];
  let csvPath: string | undefined;
  let reportPath: string | undefined;
  let timeZone = DEFAULT_USAGE_REPORT_TIME_ZONE;

  for (let index = 0; index < arguments_.length; index += 1) {
    const argument = arguments_[index];
    if (argument === undefined) {
      continue;
    }

    switch (argument) {
      case "--csv":
        csvPath = requireOptionValue(arguments_, ++index, argument);
        break;
      case "--report":
        reportPath = requireOptionValue(arguments_, ++index, argument);
        break;
      case "--timezone":
        timeZone = assertValidTimeZone(requireOptionValue(arguments_, ++index, argument));
        break;
      default:
        runtimeArguments.push(argument);
    }
  }

  if (reportPath === undefined) {
    throw new Error("--report requires the usage export downloaded from Anthropic's web UI.");
  }

  return { csvPath, reportPath, runtimeArguments, timeZone };
}

export function isLoopbackHost(host: string): boolean {
  const normalizedHost = host.toLowerCase();
  return normalizedHost === "127.0.0.1" || normalizedHost === "::1" || normalizedHost === "localhost";
}

function requireOptionValue(
  arguments_: readonly string[],
  index: number,
  optionName: string,
): string {
  const value = arguments_[index];
  if (value === undefined || value.startsWith("--")) {
    throw new Error(`${optionName} requires a value.`);
  }

  return value;
}

function resolveKimiRoots(environment: Readonly<Record<string, string | undefined>>): string[] {
  const configuredRoot = environment.KIMI_CODE_HOME;
  const candidateRoots = configuredRoot === undefined
    ? [join(homedir(), ".kimi-code"), join(homedir(), ".kimi")]
    : [resolveEnvironmentPath(configuredRoot)];

  return [...new Set(candidateRoots.map((root) => resolve(root)))];
}

function resolveClaudeRoots(
  environment: Readonly<Record<string, string | undefined>>,
): string[] {
  const configuredRoot = environment.CLAUDE_CONFIG_DIR;
  const root = configuredRoot === undefined ? join(homedir(), ".claude") : configuredRoot;
  return [resolve(root)];
}

function resolveDefaultDataDirectory(
  environment: Readonly<Record<string, string | undefined>>,
): string {
  if (process.platform === "win32") {
    return selectCompatibleDataDirectory(
      environment.LOCALAPPDATA ?? join(homedir(), "AppData", "Local"),
      "Costlight",
      "KimiCostDashboard",
    );
  }

  if (process.platform === "darwin") {
    return selectCompatibleDataDirectory(
      join(homedir(), "Library", "Application Support"),
      "Costlight",
      "KimiCostDashboard",
    );
  }

  return selectCompatibleDataDirectory(
    resolveXdgDataHome(environment),
    "costlight",
    "kimi-cost-dashboard",
  );
}

function resolveXdgDataHome(
  environment: Readonly<Record<string, string | undefined>>,
): string {
  const configuredDirectory = environment.XDG_DATA_HOME;
  return configuredDirectory !== undefined && isAbsolute(configuredDirectory)
    ? configuredDirectory
    : join(homedir(), ".local", "share");
}

export function selectCompatibleDataDirectory(
  parentDirectory: string,
  currentName: string,
  legacyName: string,
  pathExists: (path: string) => boolean = existsSync,
): string {
  const currentDirectory = join(parentDirectory, currentName);
  const legacyDirectory = join(parentDirectory, legacyName);
  return pathExists(currentDirectory) || !pathExists(legacyDirectory)
    ? currentDirectory
    : legacyDirectory;
}

function resolveEnvironmentPath(value: string): string {
  if (isAbsolute(value)) {
    return value;
  }

  return resolve(value);
}
