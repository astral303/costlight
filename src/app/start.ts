import { resolveApplicationVersion } from "../app-version/resolve-version";

process.env.COSTLIGHT_VERSION = resolveApplicationVersion();

const buildProcess = Bun.spawn(["bun", "run", "build"], {
  stderr: "inherit",
  stdout: "inherit",
});
const buildExitCode = await buildProcess.exited;
if (buildExitCode !== 0) {
  throw new Error(`The production dashboard build failed with exit code ${buildExitCode}.`);
}

await import("./server");
