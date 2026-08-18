import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Chromium is driven through its `--screenshot` flag rather than a automation library,
 * because Playwright's launch handshake does not complete under Bun on Windows.
 */
const BROWSER_CANDIDATES = [
  "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
  "C:/Program Files/Microsoft/Edge/Application/msedge.exe",
  "C:/Program Files/Google/Chrome/Application/chrome.exe",
  "C:/Program Files (x86)/Google/Chrome/Application/chrome.exe",
  "/usr/bin/google-chrome",
  "/usr/bin/chromium",
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
];

export function findBrowser(): string | null {
  return BROWSER_CANDIDATES.find((path) => existsSync(path)) ?? null;
}

export interface ScreenshotRequest {
  browserPath: string;
  height: number;
  html: string;
  width: number;
}

export function captureScreenshot({
  browserPath,
  height,
  html,
  width,
}: ScreenshotRequest): Buffer {
  const workingDirectory = mkdtempSync(join(tmpdir(), "costlight-visual-"));
  const pagePath = join(workingDirectory, "page.html");
  const imagePath = join(workingDirectory, "shot.png");
  writeFileSync(pagePath, html);

  try {
    const result = spawnSync(browserPath, [
      "--headless=new",
      "--disable-gpu",
      "--hide-scrollbars",
      "--force-device-scale-factor=1",
      "--force-color-profile=srgb",
      "--allow-file-access-from-files",
      // Lets layout, image decoding and web fonts settle on a virtual clock, so the
      // capture does not race real wall-clock loading.
      "--virtual-time-budget=8000",
      // Without this a loaded machine can capture a partially composited frame, which
      // shows up as an unrepeatable diff rather than an obvious failure.
      "--run-all-compositor-stages-before-draw",
      `--window-size=${width},${height}`,
      `--screenshot=${imagePath}`,
      `file:///${pagePath.replaceAll("\\", "/")}`,
    ], { encoding: "utf8", timeout: 60_000 });

    if (!existsSync(imagePath)) {
      throw new Error(
        `Chromium wrote no screenshot (status ${result.status}): ${result.stderr ?? ""}`,
      );
    }
    return readFileSync(imagePath);
  } finally {
    rmSync(workingDirectory, { force: true, recursive: true });
  }
}
