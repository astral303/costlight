import { describe, expect, test } from "bun:test";
import {
  registerTerminalExitShortcut,
  type TerminalInput,
} from "../../src/app/terminal-exit";

describe("registerTerminalExitShortcut", () => {
  test("requests exit for Q and restores the terminal when stopped", () => {
    const input = new FakeTerminalInput();
    const messages: string[] = [];
    let exitRequestCount = 0;

    const stop = registerTerminalExitShortcut(
      () => {
        exitRequestCount += 1;
      },
      input,
      { write: (message) => messages.push(message) },
    );

    expect(input.isRaw).toBe(true);
    expect(input.isPaused()).toBe(false);
    expect(messages).toEqual(["Press Q to exit.\n"]);

    input.emit("x");
    input.emit("q");
    input.emit("Q");
    expect(exitRequestCount).toBe(1);

    stop();
    expect(input.isRaw).toBe(false);
    expect(input.isPaused()).toBe(true);

    input.emit("q");
    expect(exitRequestCount).toBe(1);
  });

  test("keeps Ctrl+C working while raw input is enabled", () => {
    const input = new FakeTerminalInput();
    let exitRequestCount = 0;

    registerTerminalExitShortcut(
      () => {
        exitRequestCount += 1;
      },
      input,
      { write: () => {} },
    );

    input.emit("\u0003");

    expect(exitRequestCount).toBe(1);
  });

  test("pauses stdin during cleanup even when it was already flowing", () => {
    const input = new FakeTerminalInput(true, false);

    const stop = registerTerminalExitShortcut(
      () => {},
      input,
      { write: () => {} },
    );
    stop();

    expect(input.isPaused()).toBe(true);
  });

  test("does not consume input when no interactive terminal is attached", () => {
    const input = new FakeTerminalInput(false);
    const messages: string[] = [];

    const stop = registerTerminalExitShortcut(
      () => {
        throw new Error("Exit should not be requested.");
      },
      input,
      { write: (message) => messages.push(message) },
    );

    input.emit("q");
    stop();

    expect(input.isRaw).toBe(false);
    expect(input.isPaused()).toBe(true);
    expect(messages).toEqual([]);
  });
});

class FakeTerminalInput implements TerminalInput {
  readonly isTTY: boolean;
  isRaw = false;
  #isPaused = true;
  #listeners = new Set<(input: string | Buffer) => void>();

  constructor(isTTY = true, isPaused = true) {
    this.isTTY = isTTY;
    this.#isPaused = isPaused;
  }

  isPaused(): boolean {
    return this.#isPaused;
  }

  setEncoding(_encoding: "utf8"): void {}

  setRawMode(isRaw: boolean): void {
    this.isRaw = isRaw;
  }

  resume(): void {
    this.#isPaused = false;
  }

  pause(): void {
    this.#isPaused = true;
  }

  on(_event: "data", listener: (input: string | Buffer) => void): void {
    this.#listeners.add(listener);
  }

  off(_event: "data", listener: (input: string | Buffer) => void): void {
    this.#listeners.delete(listener);
  }

  emit(input: string | Buffer): void {
    for (const listener of this.#listeners) {
      listener(input);
    }
  }
}
