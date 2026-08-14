import { z } from "zod";

const CLAUDE_AUTH_STATUS_TIMEOUT_MS = 5_000;

const claudeAuthStatusSchema = z.object({
  apiProvider: z.string().min(1),
  authMethod: z.string().min(1),
  loggedIn: z.boolean(),
  subscriptionType: z.string().min(1).optional(),
}).passthrough();

export interface ClaudeAccountStatus {
  apiProvider: string;
  authMethod: string;
  subscriptionType: string;
}

export type ClaudeAccountDetector = () => Promise<ClaudeAccountStatus>;

interface ClaudeAuthStatusProcess {
  exited: Promise<number>;
  kill: () => void;
  stdout: ReadableStream<Uint8Array>;
}

interface ClaudeAccountDetectionOptions {
  spawn?: () => ClaudeAuthStatusProcess;
  timeoutMs?: number;
}

export async function detectClaudeAccount(
  options: ClaudeAccountDetectionOptions = {},
): Promise<ClaudeAccountStatus> {
  const spawn = options.spawn ?? spawnClaudeAuthStatus;
  const child = spawn();
  const timeoutMs = options.timeoutMs ?? CLAUDE_AUTH_STATUS_TIMEOUT_MS;
  let didTimeOut = false;
  const timeout = setTimeout(() => {
    didTimeOut = true;
    child.kill();
  }, timeoutMs);

  try {
    const [exitCode, stdout] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
    ]);
    if (didTimeOut) {
      throw new Error("Claude account detection timed out.");
    }
    if (exitCode !== 0) {
      throw new Error(`Claude account detection exited with status ${exitCode}.`);
    }

    return parseClaudeAccountStatus(stdout);
  } finally {
    clearTimeout(timeout);
  }
}

export function parseClaudeAccountStatus(stdout: string): ClaudeAccountStatus {
  try {
    const parsed = claudeAuthStatusSchema.parse(JSON.parse(stdout));
    if (!parsed.loggedIn || parsed.subscriptionType === undefined) {
      throw new Error("Claude is not logged in with a detectable subscription.");
    }
    return {
      apiProvider: parsed.apiProvider,
      authMethod: parsed.authMethod,
      subscriptionType: parsed.subscriptionType.toLowerCase(),
    };
  } catch (error) {
    if (error instanceof SyntaxError || error instanceof z.ZodError) {
      throw new Error("Claude account detection returned invalid JSON.", { cause: error });
    }
    throw error;
  }
}

function spawnClaudeAuthStatus(): ClaudeAuthStatusProcess {
  return Bun.spawn(["claude", "auth", "status"], {
    stderr: "pipe",
    stdin: "ignore",
    stdout: "pipe",
  });
}
