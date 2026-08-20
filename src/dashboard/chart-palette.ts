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
 * One colour per charted entity, so a series keeps its colour when the stack is
 * reordered or it appears on another chart. These deliberately do not track the UI
 * palette — series sharing the brand green is a coincidence of value, not a shared
 * meaning, and tying them would move the chart whenever a status colour was retuned.
 *
 * Derived views reuse the colour of what they derive from: the trailing-average line
 * wears `total`, and the cache-hit-ratio line wears `cacheRead`.
 *
 * Checked against the dark panel surface (#11171e) with the data-viz palette validator:
 * adjacent-pair CVD separation, normal-vision separation, and 3:1 contrast all pass.
 * The scale runs lighter than the validator's dark-mode lightness band; that is the
 * shipped style on this near-black surface, not an accident of the two newest entries.
 *
 * The validation unit is the chart, not the whole map: hues that never share a chart
 * (subagentContext blue vs cacheCreation teal, withoutCaching pink vs cacheCreation teal)
 * sit closer than the in-chart floor, and each panel's legend names its series.
 */
export const CHART_SERIES_COLORS = {
  cacheCreation: "#42a5c6",
  cacheRead: "#8b7cf6",
  contextSize: "#e3c06b",
  output: "#f0a04b",
  subagentContext: "#6aa9f7",
  total: "#f5f7fa",
  uncachedInput: "#65d6ad",
  withoutCaching: "#e88bb8",
} as const;

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
