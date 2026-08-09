const serverProcess = Bun.spawn(["bun", "--watch", "src/app/server.ts"], {
  stderr: "inherit",
  stdout: "inherit",
});
const viteProcess = Bun.spawn(["bunx", "--bun", "vite"], {
  stderr: "inherit",
  stdout: "inherit",
});

let isStopping = false;

function stopChildren(): void {
  if (isStopping) {
    return;
  }

  isStopping = true;
  serverProcess.kill();
  viteProcess.kill();
}

process.once("SIGINT", stopChildren);
process.once("SIGTERM", stopChildren);

const exitCode = await Promise.race([serverProcess.exited, viteProcess.exited]);
stopChildren();
await Promise.allSettled([serverProcess.exited, viteProcess.exited]);
process.exitCode = exitCode;
