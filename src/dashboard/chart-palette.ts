/**
 * Chart colours, kept out of `CostChart` so that asserting them does not pull echarts in.
 * The visual capture replaces the `CostChart` module wholesale; a test importing the real
 * one defeats that mock and changes the captured layout.
 *
 * These are literals rather than CSS custom properties because echarts parses its own
 * colours, and zrender rejects everything a stylesheet would hand back once tokens carry
 * transforms — `color-mix()`, `rgb(from …)` and the `oklab()` that registered properties
 * resolve to all parse as undefined.
 */

/**
 * A categorical scale: adjacent series only have to stay apart from one another. These
 * deliberately do not track the UI palette — series 1 sharing the brand green is a
 * coincidence of value, not a shared meaning, and tying them would move the chart
 * whenever a status colour was retuned.
 */
export const CHART_SERIES_COLORS = ["#65d6ad", "#42a5c6", "#8b7cf6", "#f0a04b", "#f5f7fa"];

/**
 * Chart chrome, which does mirror the interface: the gridline is the table's row rule and
 * the zoom handle is the same accent as a focus ring. `chart-palette.test.ts` asserts the
 * pairs that have to move together.
 */
export const CHART_CHROME = {
  axisLabel: "#738092",
  axisLine: "#2a3544",
  axisPointerLabel: "#273444",
  gridLine: "#19232e",
  legendText: "#9aa7b6",
  legendTextInactive: "#4c5866",
  toolboxIcon: "#9aa7b6",
  toolboxIconEmphasis: "#f5f7fa",
  tooltipBackground: "#111821f2",
  tooltipBorder: "#354253",
  tooltipText: "#e6edf3",
  zoomBackground: "#0d131b",
  zoomFill: "#65d6ad20",
  zoomHandle: "#65d6ad",
};
