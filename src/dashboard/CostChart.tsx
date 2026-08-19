import { BarChart, LineChart, type BarSeriesOption, type LineSeriesOption } from "echarts/charts";
import {
  AriaComponent,
  type AriaComponentOption,
  DataZoomComponent,
  type DataZoomComponentOption,
  DatasetComponent,
  type DatasetComponentOption,
  GridComponent,
  type GridComponentOption,
  LegendComponent,
  type LegendComponentOption,
  ToolboxComponent,
  TooltipComponent,
  type ToolboxComponentOption,
  type TooltipComponentOption,
} from "echarts/components";
import * as echarts from "echarts/core";
import type { ComposeOption, EChartsType as ECharts } from "echarts/core";
import { CanvasRenderer } from "echarts/renderers";
import { useEffect, useRef } from "react";
import { CHART_CHROME, CHART_SERIES_COLORS } from "./chart-palette";
import {
  captureChartZoom,
  type ChartZoomRange,
  type ChartZoomWindow,
  restoreChartZoom,
} from "./chart-zoom";
import type { TimeseriesPoint } from "./contracts";
import "./cost-chart.css";

const CHART_GROUP = "costlight";
let areChartsConnected = false;

type CostChartOption = ComposeOption<
  | AriaComponentOption
  | BarSeriesOption
  | DataZoomComponentOption
  | DatasetComponentOption
  | GridComponentOption
  | LegendComponentOption
  | LineSeriesOption
  | TooltipComponentOption
  | ToolboxComponentOption
>;

echarts.use([
  AriaComponent,
  BarChart,
  CanvasRenderer,
  DataZoomComponent,
  DatasetComponent,
  GridComponent,
  LegendComponent,
  LineChart,
  ToolboxComponent,
  TooltipComponent,
]);

interface CostChartProps {
  kind: "bucket" | "cumulative";
  points: readonly TimeseriesPoint[];
  zoomContext: string;
}

interface ChartRow {
  cacheCreation: number;
  cacheRead: number;
  observation: number;
  output: number;
  time: number;
  total: number;
  uncachedInput: number;
}

export function CostChart({ kind, points, zoomContext }: CostChartProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<ECharts | null>(null);
  const pointsRef = useRef(points);
  const zoomContextRef = useRef(zoomContext);
  const zoomWindowRef = useRef<ChartZoomWindow | null>(null);
  pointsRef.current = points;

  useEffect(() => {
    const container = containerRef.current;
    if (container === null) {
      return;
    }
    const chart = echarts.init(container, undefined, { renderer: "canvas" });
    chart.group = CHART_GROUP;
    chartRef.current = chart;
    if (!areChartsConnected) {
      echarts.connect(CHART_GROUP);
      areChartsConnected = true;
    }
    const rememberZoom = (event: unknown) => {
      const range = readDataZoomRange(event, pointsRef.current.length);
      if (range !== null) {
        zoomWindowRef.current = captureChartZoom(pointsRef.current, range.start, range.end);
      }
    };
    chart.on("datazoom", rememberZoom);
    const resizeObserver = new ResizeObserver(() => chart.resize());
    resizeObserver.observe(container);
    return () => {
      resizeObserver.disconnect();
      chart.off("datazoom", rememberZoom);
      chart.dispose();
      chartRef.current = null;
    };
  }, []);

  useEffect(() => {
    const shouldResetChart = zoomContextRef.current !== zoomContext;
    if (shouldResetChart) {
      zoomContextRef.current = zoomContext;
      zoomWindowRef.current = null;
    }
    const zoomRange = restoreChartZoom(points, zoomWindowRef.current);
    chartRef.current?.setOption(createChartOption(points, kind, zoomRange), {
      notMerge: shouldResetChart,
    });
  }, [kind, points, zoomContext]);

  return (
    <div
      ref={containerRef}
      className="cost-chart"
      role="img"
      aria-label={kind === "bucket"
        ? "API cost by active observation"
        : "Cumulative API cost by active observation"}
    />
  );
}

export function createChartOption(
  points: readonly TimeseriesPoint[],
  kind: CostChartProps["kind"],
  zoomRange?: ChartZoomRange,
): CostChartOption {
  const prefix = kind === "cumulative" ? "cumulative" : "";
  const dimension = (component: "CacheCreation" | "CacheRead" | "Input" | "Output" | "Total") => {
    if (prefix === "") {
      const bucketNames = {
        CacheCreation: "cacheCreationCostNano",
        CacheRead: "cacheReadCostNano",
        Input: "inputCostNano",
        Output: "outputCostNano",
        Total: "totalCostNano",
      } as const;
      return bucketNames[component];
    }
    return `${prefix}${component}CostNano` as keyof TimeseriesPoint;
  };
  const rows = points.map((point, observation) => ({
    observation,
    time: point.bucketStartMs,
    uncachedInput: Number(point[dimension("Input")]) / 1_000_000_000,
    cacheCreation: Number(point[dimension("CacheCreation")]) / 1_000_000_000,
    cacheRead: Number(point[dimension("CacheRead")]) / 1_000_000_000,
    output: Number(point[dimension("Output")]) / 1_000_000_000,
    total: Number(point[dimension("Total")]) / 1_000_000_000,
  }));

  return {
    animationDurationUpdate: 260,
    aria: { enabled: true },
    backgroundColor: "transparent",
    color: CHART_SERIES_COLORS,
    dataset: {
      dimensions: ["observation", "time", "uncachedInput", "cacheCreation", "cacheRead", "output", "total"],
      source: rows,
    },
    dataZoom: [
      {
        type: "slider",
        xAxisIndex: 0,
        bottom: 4,
        height: 18,
        borderColor: "transparent",
        backgroundColor: CHART_CHROME.zoomBackground,
        fillerColor: CHART_CHROME.zoomFill,
        handleStyle: { color: CHART_CHROME.zoomHandle },
        showDetail: false,
        textStyle: { color: CHART_CHROME.axisLabel, fontSize: 9 },
        ...zoomRange,
      },
    ],
    grid: { bottom: 54, containLabel: true, left: 8, right: 18, top: 46 },
    legend: {
      icon: "roundRect",
      itemHeight: 7,
      itemWidth: 16,
      left: 0,
      pageIconColor: CHART_CHROME.legendText,
      pageIconInactiveColor: CHART_CHROME.legendTextInactive,
      pageTextStyle: { color: CHART_CHROME.axisLabel, fontSize: 9 },
      right: 60,
      textStyle: { color: CHART_CHROME.legendText, fontSize: 10 },
      top: 4,
      type: "scroll",
    },
    series: kind === "bucket"
      ? [
        createBarSeries("Uncached input", "uncachedInput"),
        createBarSeries("Cache creation", "cacheCreation"),
        createBarSeries("Cache read", "cacheRead"),
        createBarSeries("Output", "output"),
      ]
      : [
        createCumulativeAreaSeries("Uncached input", "uncachedInput"),
        createCumulativeAreaSeries("Cache creation", "cacheCreation"),
        createCumulativeAreaSeries("Cache read", "cacheRead"),
        createCumulativeAreaSeries("Output", "output"),
        {
          datasetIndex: 0,
          encode: { x: "observation", y: "total" },
          emphasis: { focus: "series" },
          name: "Total",
          showSymbol: false,
          step: "start",
          type: "line",
          z: 8,
        },
      ],
    tooltip: {
      axisPointer: { type: kind === "bucket" ? "shadow" : "line" },
      backgroundColor: CHART_CHROME.tooltipBackground,
      borderColor: CHART_CHROME.tooltipBorder,
      formatter: (parameters: unknown) => formatChartTooltip(parameters, rows),
      textStyle: { color: CHART_CHROME.tooltipText },
      trigger: "axis",
    },
    toolbox: {
      emphasis: { iconStyle: { borderColor: CHART_CHROME.toolboxIconEmphasis } },
      feature: {
        dataZoom: {
          brushStyle: { borderColor: CHART_CHROME.zoomHandle, color: CHART_CHROME.zoomFill },
          title: { back: "Undo zoom", zoom: "Drag to zoom" },
          xAxisIndex: 0,
          yAxisIndex: "none",
        },
      },
      iconStyle: { borderColor: CHART_CHROME.toolboxIcon },
      itemGap: 8,
      itemSize: 14,
      right: 12,
      top: 4,
    },
    xAxis: {
      axisLabel: {
        color: CHART_CHROME.axisLabel,
        formatter: (value) => formatAxisValue(rows, value, "axis"),
        hideOverlap: true,
      },
      axisLine: { lineStyle: { color: CHART_CHROME.axisLine } },
      axisPointer: {
        label: {
          backgroundColor: CHART_CHROME.axisPointerLabel,
          formatter: (parameters) => formatAxisValue(rows, parameters.value, "tooltip"),
        },
      },
      boundaryGap: kind === "bucket",
      splitLine: { show: false },
      type: "category",
    },
    yAxis: {
      axisLabel: { color: CHART_CHROME.axisLabel, formatter: (value: number) => formatChartUsd(value) },
      splitLine: { lineStyle: { color: CHART_CHROME.gridLine } },
      type: "value",
    },
  };
}

export function readDataZoomRange(
  event: unknown,
  pointCount: number,
): { end: number; start: number } | null {
  if (!isRecord(event)) {
    return null;
  }
  const candidate = Array.isArray(event.batch) ? event.batch[0] : event;
  if (!isRecord(candidate)) {
    return null;
  }
  if (typeof candidate.start === "number" && typeof candidate.end === "number") {
    return { end: candidate.end, start: candidate.start };
  }
  if (typeof candidate.startValue !== "number" || typeof candidate.endValue !== "number") {
    return null;
  }
  if (pointCount <= 1) {
    return { end: 100, start: 0 };
  }
  const lastPointIndex = pointCount - 1;
  return {
    end: (candidate.endValue / lastPointIndex) * 100,
    start: (candidate.startValue / lastPointIndex) * 100,
  };
}

function createBarSeries(name: string, dimension: string): BarSeriesOption {
  return {
    barMaxWidth: 24,
    datasetIndex: 0,
    encode: { x: "observation", y: dimension },
    emphasis: { focus: "series" as const },
    name,
    stack: "components",
    type: "bar" as const,
  };
}

function createCumulativeAreaSeries(name: string, dimension: string): LineSeriesOption {
  return {
    areaStyle: { opacity: 0.38 },
    datasetIndex: 0,
    encode: { x: "observation", y: dimension },
    emphasis: { focus: "series" as const },
    lineStyle: { width: 1 },
    name,
    showSymbol: false,
    stack: "components",
    step: "start" as const,
    type: "line" as const,
  };
}

function formatChartTooltip(parameters: unknown, rows: readonly ChartRow[]): string {
  const firstParameter = Array.isArray(parameters) ? parameters[0] : parameters;
  if (!isRecord(firstParameter) || typeof firstParameter.dataIndex !== "number") {
    return "";
  }
  const row = rows[firstParameter.dataIndex];
  if (row === undefined) {
    return "";
  }

  return [
    `<strong>${formatChartTime(row.time, "tooltip")}</strong>`,
    `Uncached input: ${formatChartUsd(row.uncachedInput)}`,
    `Cache creation: ${formatChartUsd(row.cacheCreation)}`,
    `Cache read: ${formatChartUsd(row.cacheRead)}`,
    `Output: ${formatChartUsd(row.output)}`,
    `Total: ${formatChartUsd(row.total)}`,
  ].join("<br>");
}

function formatObservationTime(
  rows: readonly ChartRow[],
  observation: string | number,
  detail: "axis" | "tooltip",
): string {
  const row = rows[Number(observation)];
  return row === undefined ? "" : formatChartTime(row.time, detail);
}

function formatAxisValue(rows: readonly ChartRow[], rawValue: unknown, detail: "axis" | "tooltip"): string {
  const axisValue = rawValue instanceof Date
    ? rawValue.getTime()
    : typeof rawValue === "number"
      ? rawValue
      : Number(rawValue);
  if (!Number.isFinite(axisValue)) {
    return "";
  }
  return formatObservationTime(rows, axisValue, detail);
}

function formatChartTime(timestampMs: number, detail: "axis" | "tooltip"): string {
  return detail === "tooltip"
    ? new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "medium" }).format(timestampMs)
    : new Intl.DateTimeFormat(undefined, {
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
      month: "short",
    }).format(timestampMs);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function formatChartUsd(value: number): string {
  if (Math.abs(value) < 0.01 && value !== 0) {
    return `$${value.toFixed(4)}`;
  }
  return new Intl.NumberFormat(undefined, {
    currency: "USD",
    maximumFractionDigits: value < 1 ? 3 : 2,
    notation: value >= 10_000 ? "compact" : "standard",
    style: "currency",
  }).format(value);
}
