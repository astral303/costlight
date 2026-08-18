import { afterEach, beforeAll, describe, expect, test } from "bun:test";
import { cleanup } from "@testing-library/react";
import { buildPage } from "./support/build-page";
import { captureScreenshot, findBrowser } from "./support/capture-screenshot";
import { compareToBaseline, shouldUpdateBaselines } from "./support/compare-to-baseline";
import { renderDashboardMarkup } from "./support/render-dashboard-markup";

/**
 * Captures cover the header artwork and everything it can bleed onto. Each width sits on
 * a different side of the layout rules: 1280 is a full desktop that a 1920px display
 * reports at 150% scaling, 1000 drops the corner beacon, 760 stacks the header.
 */
const VIEWPORTS = [
  { height: 460, name: "dashboard-chrome-1280", width: 1280 },
  { height: 460, name: "dashboard-chrome-1000", width: 1000 },
  { height: 560, name: "dashboard-chrome-760", width: 760 },
];

/** Text anti-aliasing drifts by a few pixels; a real layout change moves far more. */
const MAXIMUM_CHANGED_PIXEL_RATIO = 0.002;

const browserPath = findBrowser();
let markup = "";

beforeAll(async () => {
  markup = await renderDashboardMarkup();
});

afterEach(() => {
  cleanup();
});

describe.if(browserPath !== null)("dashboard chrome", () => {
  for (const viewport of VIEWPORTS) {
    test(`matches the baseline at ${viewport.width}px`, () => {
      const screenshot = captureScreenshot({
        browserPath: browserPath as string,
        height: viewport.height,
        html: buildPage(markup),
        width: viewport.width,
      });

      const comparison = compareToBaseline(viewport.name, screenshot);

      expect(
        comparison.isBaselineMissing,
        `Wrote a new baseline for ${viewport.name}. Review it, then re-run.`,
      ).toBe(false);
      expect(
        comparison.changedPixelRatio,
        `${comparison.changedPixels} pixels changed. See ${comparison.failureArtifacts.join(", ")}. `
        + "Re-run with UPDATE_VISUAL_BASELINES=1 once the change is intended.",
      ).toBeLessThanOrEqual(MAXIMUM_CHANGED_PIXEL_RATIO);
    });
  }
});

test.if(browserPath === null)("visual baselines need a Chromium browser", () => {
  expect(shouldUpdateBaselines()).toBe(false);
  console.warn("Skipped visual regression: install Microsoft Edge or Google Chrome.");
});
