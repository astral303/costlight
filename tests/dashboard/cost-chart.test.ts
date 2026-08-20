import { describe, expect, test } from "bun:test";
import type { DataZoomComponentOption, ToolboxComponentOption } from "echarts/components";
import { CHART_SERIES_COLORS } from "../../src/dashboard/chart-palette";
import { captureChartZoom, restoreChartZoom } from "../../src/dashboard/chart-zoom";
import {
  createChartOption,
  createDeltaToEndMarkLine,
  readDataZoomRange,
} from "../../src/dashboard/CostChart";
import type { TimeseriesPoint } from "../../src/dashboard/contracts";

interface SeriesShape {
  encode?: { y: string };
  lineStyle?: { type?: string };
  markLine?: { data: { xAxis?: number }[] };
  name: string;
  step?: string;
  type: string;
}

describe("cost chart interactions", () => {
  test("leaves page scrolling alone and provides drag-selection zoom", () => {
    const option = createChartOption([], "bucket");
    const dataZoom = option.dataZoom as DataZoomComponentOption[];
    const toolbox = option.toolbox as ToolboxComponentOption;

    expect(dataZoom).toHaveLength(1);
    expect(dataZoom[0]?.type).toBe("slider");
    expect(toolbox.feature?.dataZoom).toMatchObject({
      title: { back: "Undo zoom", zoom: "Drag to zoom" },
      xAxisIndex: 0,
      yAxisIndex: "none",
    });
  });

  test("compresses idle time into discrete stacked bars, largest series lowest", () => {
    const points = [createPoint(1_000), createPoint(86_400_000)];
    const option = createChartOption(points, "bucket");
    const dataset = option.dataset as { source: Array<{ observation: number; time: number }> };
    const series = option.series as SeriesShape[];
    const xAxis = option.xAxis as { type: string };

    expect(xAxis.type).toBe("category");
    expect(dataset.source.map(({ observation, time }) => ({ observation, time }))).toEqual([
      { observation: 0, time: 1_000 },
      { observation: 1, time: 86_400_000 },
    ]);
    expect(series.map(({ name, type }) => ({ name, type }))).toEqual([
      { name: "Cache read", type: "bar" },
      { name: "Cache creation", type: "bar" },
      { name: "Uncached input", type: "bar" },
      { name: "Output", type: "bar" },
      { name: "Trailing avg", type: "line" },
    ]);
  });

  test("keeps each series colour with its entity across both cost charts", () => {
    const bucketOption = createChartOption([createPoint(1_000)], "bucket");
    const cumulativeOption = createChartOption([createPoint(1_000)], "cumulative");

    expect(bucketOption.color).toEqual([
      CHART_SERIES_COLORS.cacheRead,
      CHART_SERIES_COLORS.cacheCreation,
      CHART_SERIES_COLORS.uncachedInput,
      CHART_SERIES_COLORS.output,
      CHART_SERIES_COLORS.total,
    ]);
    expect(cumulativeOption.color).toEqual([
      CHART_SERIES_COLORS.cacheRead,
      CHART_SERIES_COLORS.cacheCreation,
      CHART_SERIES_COLORS.uncachedInput,
      CHART_SERIES_COLORS.output,
      CHART_SERIES_COLORS.total,
      CHART_SERIES_COLORS.withoutCaching,
    ]);
    expect(createChartOption([createPoint(1_000)], "context").color).toEqual([
      CHART_SERIES_COLORS.contextSize,
      CHART_SERIES_COLORS.subagentContext,
    ]);
  });

  test("uses steps for cumulative observations and labels tooltip costs", () => {
    const option = createChartOption([createPoint(1_000)], "cumulative");
    const series = option.series as SeriesShape[];
    const tooltip = option.tooltip as {
      formatter: (parameters: unknown) => string;
    };

    expect(series.every(({ step, type }) => step === "start" && type === "line")).toBe(true);
    expect(tooltip.formatter([{ dataIndex: 0 }])).toContain("Uncached input: $1.25");
    expect(tooltip.formatter([{ dataIndex: 0 }])).toContain("Total: $1.75");
    expect(tooltip.formatter([{ dataIndex: 0 }])).toContain("Without caching: $2.15");
  });

  test("tells the hovered point how much cost is still to come", () => {
    const points = [
      createPoint(1_000, { cumulativeTotalCostNano: 1_000_000_000 }),
      createPoint(2_000, { cumulativeTotalCostNano: 3_000_000_000 }),
      createPoint(3_000, { cumulativeTotalCostNano: 4_000_000_000 }),
    ];
    const option = createChartOption(points, "cumulative");
    const tooltip = option.tooltip as { formatter: (parameters: unknown) => string };

    expect(tooltip.formatter([{ dataIndex: 0 }])).toContain("Remaining to end: $3.00 (75%)");
    expect(tooltip.formatter([{ dataIndex: 2 }])).not.toContain("Remaining to end");
  });

  test("draws the hover delta line to the end of the visible range", () => {
    const points = [
      createPoint(1_000, { cumulativeTotalCostNano: 1_000_000_000 }),
      createPoint(2_000, { cumulativeTotalCostNano: 3_000_000_000 }),
      createPoint(3_000, { cumulativeTotalCostNano: 4_000_000_000 }),
    ];

    const markLine = createDeltaToEndMarkLine(points, null, 0);
    const [firstPair] = markLine.data as [
      [{ coord: number[] }, { coord: number[]; label: { formatter: string } }],
    ];

    expect(firstPair[0].coord).toEqual([0, 1]);
    expect(firstPair[1].coord).toEqual([2, 1]);
    expect(firstPair[1].label.formatter).toBe("+$3.00 to end");
    expect(createDeltaToEndMarkLine(points, null, 2).data).toEqual([]);
    expect(createDeltaToEndMarkLine(points, null, null).data).toEqual([]);
  });

  test("starts the no-cache counterfactual deselected", () => {
    const option = createChartOption([createPoint(1_000)], "cumulative");
    const legend = option.legend as { selected?: Record<string, boolean> };

    expect(legend.selected).toEqual({ "Without caching": false });
    const bucketLegend = createChartOption([createPoint(1_000)], "bucket").legend as {
      selected?: Record<string, boolean>;
    };
    expect(bucketLegend.selected).toBeUndefined();
  });

  test("anchors the cumulative y axis to the data only when asked", () => {
    const points = [createPoint(1_000)];
    const anchored = createChartOption(points, "cumulative", undefined, { anchorYAxisToData: true });
    const zeroBased = createChartOption(points, "cumulative");

    expect((anchored.yAxis as { scale?: boolean }).scale).toBe(true);
    expect((zeroBased.yAxis as { scale?: boolean }).scale).toBe(false);
  });

  test("averages the trailing window for the burn-rate line", () => {
    const points = [
      createPoint(1_000, { totalCostNano: 1_000_000_000 }),
      createPoint(2_000, { totalCostNano: 3_000_000_000 }),
    ];
    const option = createChartOption(points, "bucket");
    const rows = (option.dataset as { source: { trailingAverage: number }[] }).source;

    expect(rows.map(({ trailingAverage }) => trailingAverage)).toEqual([1, 2]);
  });

  test("marks idle gaps of an hour or more between observations", () => {
    const points = [
      createPoint(0),
      createPoint(2 * 60 * 60 * 1_000),
      createPoint(2 * 60 * 60 * 1_000 + 1_000),
    ];
    const option = createChartOption(points, "bucket", undefined, { resolution: "call" });
    const series = option.series as SeriesShape[];
    const markLineData = series[0]?.markLine?.data as {
      label?: { formatter?: string };
      xAxis?: number;
    }[];

    expect(markLineData.map(({ xAxis }) => xAxis)).toEqual([1]);
    expect(markLineData[0]?.label?.formatter).toBe("2h idle");
    const tooltip = option.tooltip as { formatter: (parameters: unknown) => string };
    expect(tooltip.formatter([{ dataIndex: 1 }])).toContain("After 2h idle");

    // Bucketed views skip the markers: routine gaps between active buckets would
    // paper the chart, and the tooltip still names the idle time.
    const bucketed = createChartOption(points, "bucket", undefined, { resolution: "hour" });
    expect((bucketed.series as SeriesShape[])[0]?.markLine?.data).toEqual([]);
  });

  test("names the trailing window in time units for bucketed series", () => {
    const points = [createPoint(1_000)];
    const hourly = createChartOption(points, "bucket", undefined, { resolution: "hour" });
    const perCall = createChartOption(points, "bucket", undefined, { resolution: "call" });

    const hourlyTooltip = hourly.tooltip as { formatter: (parameters: unknown) => string };
    const perCallTooltip = perCall.tooltip as { formatter: (parameters: unknown) => string };
    expect(hourlyTooltip.formatter([{ dataIndex: 0 }])).toContain("(trailing 20 active hours)");
    expect(perCallTooltip.formatter([{ dataIndex: 0 }])).toContain("(trailing 20 calls)");
  });

  test("plots main and subagent context as separate lines with rebuild markers", () => {
    const points = [
      createPoint(1_000, { cacheReadTokens: 90_000, peakMainPromptTokens: 100_000, promptTokens: 100_000 }),
      createPoint(2_000, { cacheReadTokens: 2_000, peakMainPromptTokens: 40_000, promptTokens: 40_000 }),
      createPoint(3_000, {
        cacheReadTokens: 0,
        peakMainPromptTokens: 0,
        peakSubagentPromptTokens: 30_000,
        promptTokens: 30_000,
      }),
    ];
    const option = createChartOption(points, "context", undefined, { resolution: "call" });
    const series = option.series as SeriesShape[];
    const legend = option.legend as { show?: boolean };
    const rows = (option.dataset as {
      source: { contextMain: number | null; contextSubagent: number | null }[];
    }).source;

    expect(series.map(({ name, type }) => ({ name, type }))).toEqual([
      { name: "Main agent", type: "line" },
      { name: "Subagents", type: "line" },
    ]);
    expect(series.map((entry) => entry.encode?.y)).toEqual(["contextMain", "contextSubagent"]);
    expect(legend.show).toBe(true);
    expect(rows.map(({ contextMain }) => contextMain)).toEqual([100_000, 40_000, null]);
    expect(rows.map(({ contextSubagent }) => contextSubagent)).toEqual([null, null, 30_000]);
    // The fresh main call at index 1 is a rebuild; the fresh subagent call at index 2
    // is not, because a subagent always starts on a fresh prompt.
    expect(series[0]?.markLine?.data.map(({ xAxis }) => xAxis)).toEqual([1]);

    const bucketResolution = createChartOption(points, "context", undefined, { resolution: "hour" });
    expect((bucketResolution.series as SeriesShape[])[0]?.markLine?.data).toEqual([]);
  });

  test("marks context rebuilds on the cost charts at call resolution", () => {
    const points = [
      createPoint(1_000),
      createPoint(2_000, { cacheReadTokens: 2_000, peakMainPromptTokens: 40_000, promptTokens: 40_000 }),
    ];
    const option = createChartOption(points, "bucket", undefined, { resolution: "call" });
    const markLineData = (option.series as SeriesShape[])[0]?.markLine?.data;

    expect(markLineData?.map(({ xAxis }) => xAxis)).toEqual([1]);
  });

  test("plots the trailing cache hit ratio on a data-anchored axis", () => {
    const points = [
      createPoint(1_000, { cacheReadTokens: 900, promptTokens: 1_000 }),
      createPoint(2_000, { cacheReadTokens: 500, promptTokens: 1_000 }),
    ];
    const option = createChartOption(points, "cacheHitRatio");
    const series = option.series as SeriesShape[];
    const rows = (option.dataset as { source: { hitRatio: number }[] }).source;

    expect(series).toHaveLength(1);
    expect(series[0]).toMatchObject({ name: "Cache hit ratio", type: "line" });
    expect((option.yAxis as { scale?: boolean }).scale).toBe(true);
    expect((option.yAxis as { max?: number }).max).toBe(1);
    expect(rows.map(({ hitRatio }) => hitRatio)).toEqual([0.9, 0.7]);
  });

  test("keeps a newest-edge zoom pinned as data arrives", () => {
    const initialPoints = [1_000, 2_000, 3_000, 4_000].map((timestamp) => createPoint(timestamp));
    const window = captureChartZoom(initialPoints, 50, 100);
    const refreshedPoints = [...initialPoints, createPoint(5_000)];

    expect(restoreChartZoom(refreshedPoints, window)).toEqual({
      endValue: 4,
      startValue: 3,
    });
  });

  test("reads slider and drag-selection zoom ranges", () => {
    expect(readDataZoomRange({ start: 25, end: 75 }, 5)).toEqual({ start: 25, end: 75 });
    expect(readDataZoomRange({
      batch: [{ startValue: 1, endValue: 3 }],
    }, 5)).toEqual({ start: 25, end: 75 });
  });

  test("keeps a historical zoom on the same observations", () => {
    const initialPoints = [1_000, 2_000, 3_000, 4_000].map((timestamp) => createPoint(timestamp));
    const window = captureChartZoom(initialPoints, 25, 75);
    const refreshedPoints = [...initialPoints, createPoint(5_000)];

    expect(restoreChartZoom(refreshedPoints, window)).toEqual({
      endValue: 2,
      startValue: 1,
    });
  });

  test("lets a full-range chart continue showing all new data", () => {
    const points = [1_000, 2_000, 3_000].map((timestamp) => createPoint(timestamp));

    expect(captureChartZoom(points, 0, 100)).toBeNull();
    expect(restoreChartZoom(points, null)).toBeUndefined();
  });
});

function createPoint(
  bucketStartMs: number,
  overrides: Partial<TimeseriesPoint> = {},
): TimeseriesPoint {
  return {
    bucketStartMs,
    cacheCreationCostNano: 0,
    cacheReadCostNano: 250_000_000,
    cacheReadTokens: 750,
    callCount: 1,
    cumulativeCacheCreationCostNano: 0,
    cumulativeCacheReadCostNano: 250_000_000,
    cumulativeInputCostNano: 1_250_000_000,
    cumulativeNoCacheCostNano: 2_150_000_000,
    cumulativeOutputCostNano: 250_000_000,
    cumulativeTotalCostNano: 1_750_000_000,
    inputCostNano: 1_250_000_000,
    noCacheExtraCostNano: 400_000_000,
    outputCostNano: 250_000_000,
    peakMainPromptTokens: 1_000,
    peakSubagentPromptTokens: 0,
    promptTokens: 1_000,
    totalCostNano: 1_750_000_000,
    unpricedCallCount: 0,
    ...overrides,
  };
}
