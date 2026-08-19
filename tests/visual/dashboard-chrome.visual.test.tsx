import { afterEach, beforeAll, describe, expect, test } from "bun:test";
import { cleanup } from "@testing-library/react";
import { buildPage } from "./support/build-page";
import { captureComputedStyles } from "./support/capture-computed-style";
import { captureScreenshot, findBrowser } from "./support/capture-screenshot";
import {
  compareToBaseline,
  compareToComputedStyleBaseline,
  shouldUpdateBaselines,
} from "./support/compare-to-baseline";
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

const STYLE_ASSERTED_SELECTORS = [
  ":root",
  "body",
  ".dashboard-shell",
  ".dashboard-header",
  ".dashboard-header__water",
  ".dashboard-header__scene",
  ".dashboard-header__scene::before",
  ".dashboard-header__scene::after",
  ".dashboard-header__water::before",
  ".dashboard-header__primary",
  ".dashboard-header__actions",
  ".rescan-button",
  ".dashboard-error",
  ".dashboard-warning",
  ".filter-bar",
  ".filter-field span",
  ".filter-field select",
  ".metric",
  ".chart-grid",
  ".chart-panel",
  ".chart-loading",
  ".panel-heading",
  ".table-panel",
  ".session-table",
  ".session-toggle",
  ".session-toggle__label",
  ".rate-badge",
  ".provider-status summary::after",
  ".provider-status__menu",
  ".provider-status__info",
  ".connection-status",
  ".connection-status strong",
  ".connection-status small",
  ".connection-status__dot",
  ".dashboard-footer",
];

/**
 * Launching Chromium and rendering usually takes about two seconds, but has been seen
 * to reach seven on a loaded machine. Bun's default per-test timeout of five seconds
 * would report that as a bare failure carrying no diff, which reads exactly like a
 * genuine pixel change until the elapsed time gives it away.
 */
const CAPTURE_TIMEOUT_MS = 60_000;

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

      const computedStyles = captureComputedStyles({
        browserPath: browserPath as string,
        height: viewport.height,
        html: buildPage(markup),
        selectors: STYLE_ASSERTED_SELECTORS,
        width: viewport.width,
      });
      const styleComparison = compareToComputedStyleBaseline(viewport.name, computedStyles);

      expect(
        styleComparison.isBaselineMissing,
        `Wrote a new computed-style baseline for ${viewport.name}. Review it, then re-run with `
        + "UPDATE_VISUAL_BASELINES=1.",
      ).toBe(false);
      expect(
        styleComparison.changedPixelRatio,
        `${styleComparison.changedProperties.length} computed style values changed: `
        + `${styleComparison.changedProperties.join(", ")}. `
        + `See ${styleComparison.failureArtifacts.join(", ")}. `
        + "Re-run with UPDATE_VISUAL_BASELINES=1 once intended.",
      ).toBe(0);
    }, CAPTURE_TIMEOUT_MS);
  }
});

test.if(browserPath === null)("visual baselines need a Chromium browser", () => {
  expect(shouldUpdateBaselines()).toBe(false);
  console.warn("Skipped visual regression: install Microsoft Edge or Google Chrome.");
});
