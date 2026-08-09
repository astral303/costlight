import { describe, expect, test } from "bun:test";
import type { DataZoomComponentOption, ToolboxComponentOption } from "echarts/components";
import { createChartOption } from "../../src/dashboard/CostChart";
import type { TimeseriesPoint } from "../../src/dashboard/contracts";

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

  test("compresses idle time into discrete stacked bars", () => {
    const points = [createPoint(1_000), createPoint(86_400_000)];
    const option = createChartOption(points, "bucket");
    const dataset = option.dataset as { source: Array<{ observation: number; time: number }> };
    const series = option.series as Array<{ name: string; type: string }>;
    const xAxis = option.xAxis as { type: string };

    expect(xAxis.type).toBe("category");
    expect(dataset.source.map(({ observation, time }) => ({ observation, time }))).toEqual([
      { observation: 0, time: 1_000 },
      { observation: 1, time: 86_400_000 },
    ]);
    expect(series.map(({ name, type }) => ({ name, type }))).toEqual([
      { name: "Uncached input", type: "bar" },
      { name: "Cache creation", type: "bar" },
      { name: "Cache read", type: "bar" },
      { name: "Output", type: "bar" },
    ]);
  });

  test("uses steps for cumulative observations and labels tooltip costs", () => {
    const option = createChartOption([createPoint(1_000)], "cumulative");
    const series = option.series as Array<{ step: string; type: string }>;
    const tooltip = option.tooltip as {
      formatter: (parameters: unknown) => string;
    };

    expect(series.every(({ step, type }) => step === "start" && type === "line")).toBe(true);
    expect(tooltip.formatter([{ dataIndex: 0 }])).toContain("Uncached input: $1.25");
    expect(tooltip.formatter([{ dataIndex: 0 }])).toContain("Total: $1.75");
  });
});

function createPoint(bucketStartMs: number): TimeseriesPoint {
  return {
    bucketStartMs,
    cacheCreationCostNano: 0,
    cacheReadCostNano: 250_000_000,
    callCount: 1,
    cumulativeCacheCreationCostNano: 0,
    cumulativeCacheReadCostNano: 250_000_000,
    cumulativeInputCostNano: 1_250_000_000,
    cumulativeOutputCostNano: 250_000_000,
    cumulativeTotalCostNano: 1_750_000_000,
    inputCostNano: 1_250_000_000,
    outputCostNano: 250_000_000,
    totalCostNano: 1_750_000_000,
    unpricedCallCount: 0,
  };
}
