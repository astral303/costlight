import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { z } from "zod";

const DEFAULT_PORT = 4637;

const runtimeOptionsSchema = z.object({
  dataDirectory: z.string().min(1),
  databasePath: z.string().min(1),
  host: z.string().min(1),
  port: z.number().int().min(1).max(65_535),
  accessToken: z.string().min(16).optional(),
  kimiRoots: z.array(z.string().min(1)).min(1),
  privacyMode: z.boolean(),
  watchFiles: z.boolean(),
});

export type RuntimeOptions = z.infer<typeof runtimeOptionsSchema>;

interface MutableRuntimeOptions {
  accessToken: string | undefined;
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
    accessToken: environment.KIMI_COST_DASHBOARD_TOKEN,
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
    kimiRoots: options.kimiRoots.map((root) => resolve(root)),
  });

  if (!isLoopbackHost(parsedOptions.host) && parsedOptions.accessToken === undefined) {
    throw new Error("Non-loopback binding requires --access-token or KIMI_COST_DASHBOARD_TOKEN.");
  }

  return parsedOptions;
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

function resolveDefaultDataDirectory(
  environment: Readonly<Record<string, string | undefined>>,
): string {
  if (process.platform === "win32") {
    return join(environment.LOCALAPPDATA ?? join(homedir(), "AppData", "Local"), "KimiCostDashboard");
  }

  if (process.platform === "darwin") {
    return join(homedir(), "Library", "Application Support", "KimiCostDashboard");
  }

  return join(environment.XDG_DATA_HOME ?? join(homedir(), ".local", "share"), "kimi-cost-dashboard");
}

function resolveEnvironmentPath(value: string): string {
  if (isAbsolute(value)) {
    return value;
  }

  return resolve(value);
}
