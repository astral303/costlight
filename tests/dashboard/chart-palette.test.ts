import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { CHART_CHROME, CHART_SERIES_COLORS } from "../../src/dashboard/CostChart";

const APPLICATION_CSS = join(import.meta.dir, "..", "..", "src", "app", "application.css");

async function readToken(name: string): Promise<string> {
  const stylesheet = await Bun.file(APPLICATION_CSS).text();
  const declaration = stylesheet.match(new RegExp(`${name}:\\s*([^;]+);`));
  if (declaration?.[1] === undefined) {
    throw new Error(`${name} is not defined in application.css`);
  }
  return declaration[1].trim();
}

/**
 * echarts parses its own colours, so the chart cannot read these from the stylesheet at
 * runtime. These assertions stand in for that link: where a chart colour is the same
 * colour as part of the interface, changing one without the other should fail here.
 */
describe("chart chrome tracks the interface palette", () => {
  test("the gridline is the table's row rule", async () => {
    expect(CHART_CHROME.gridLine).toBe(await readToken("--color-border"));
  });

  test("tooltip text is body text", async () => {
    expect(CHART_CHROME.tooltipText).toBe(await readToken("--color-text"));
  });

  test("the zoom handle is the interactive accent", async () => {
    expect(CHART_CHROME.zoomHandle).toBe(await readToken("--color-accent"));
  });
});

/**
 * The series scale shares no meaning with the interface palette, so it is deliberately
 * not asserted against any token. This guards the count and distinctness instead, which
 * are the properties a categorical scale actually has to hold.
 */
describe("the series scale", () => {
  test("covers every series the chart draws", () => {
    expect(CHART_SERIES_COLORS).toHaveLength(5);
  });

  test("has no repeated colour", () => {
    expect(new Set(CHART_SERIES_COLORS).size).toBe(CHART_SERIES_COLORS.length);
  });
});
