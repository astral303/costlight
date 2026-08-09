export interface TerminalInput {
  readonly isTTY?: boolean;
  readonly isRaw: boolean;
  setEncoding(encoding: "utf8"): void;
  setRawMode(isRaw: boolean): void;
  resume(): void;
  pause(): void;
  on(event: "data", listener: (input: string | Buffer) => void): void;
  off(event: "data", listener: (input: string | Buffer) => void): void;
}

interface TerminalOutput {
  write(message: string): unknown;
}

export function registerTerminalExitShortcut(
  requestExit: () => void,
  input: TerminalInput = process.stdin,
  output: TerminalOutput = process.stdout,
): () => void {
  if (!input.isTTY) {
    return () => {};
  }

  const wasRaw = input.isRaw;
  let isExitRequested = false;
  let isStopped = false;

  const handleInput = (terminalInput: string | Buffer): void => {
    if (!isExitRequested && containsExitKey(terminalInput)) {
      isExitRequested = true;
      requestExit();
    }
  };

  input.setEncoding("utf8");
  input.setRawMode(true);
  input.resume();
  input.on("data", handleInput);
  output.write("Press Q to exit.\n");

  return () => {
    if (isStopped) {
      return;
    }

    isStopped = true;
    input.off("data", handleInput);
    input.setRawMode(wasRaw);
    input.pause();
  };
}

function containsExitKey(input: string | Buffer): boolean {
  return [...input.toString()].some(
    (character) => character === "q" || character === "Q" || character === "\u0003",
  );
}
