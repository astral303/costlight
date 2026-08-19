import { describe, expect, test } from "bun:test";
import { CHART_CHROME, CHART_SERIES_COLORS } from "../../src/dashboard/chart-palette";
import { resolvePalette, toSrgbHex } from "../palette/support/resolve-palette";

/**
 * echarts parses its own colours, so the chart cannot read these from the stylesheet at
 * runtime. These assertions stand in for that link: where a chart colour is the same
 * colour as part of the interface, changing one without the other should fail here.
 *
 * Compared as resolved colours rather than as source text, so a token that becomes a step
 * between anchors still reports a colour mismatch rather than a parse failure.
 */
describe("chart chrome tracks the interface palette", () => {
  const mirrored: Record<string, string> = {
    gridLine: "--color-border",
    tooltipText: "--color-text-1",
    zoomHandle: "--color-accent",
  };

  test("holds the same colour as the token each part mirrors", async () => {
    const palette = await resolvePalette();
    const drifted = Object.entries(mirrored)
      .map(([part, name]) => ({
        part,
        chart: toSrgbHex(CHART_CHROME[part as keyof typeof CHART_CHROME]),
        token: (palette.get(name) as { hex: string }).hex,
        name,
      }))
      .filter(({ chart, token }) => chart !== token)
      .map(({ part, chart, name, token }) => `${part} is ${chart}, but ${name} is ${token}`);

    expect(drifted).toEqual([]);
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
