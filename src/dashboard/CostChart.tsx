import { BarChart, LineChart } from "echarts/charts";
import {
  AriaComponent,
  DataZoomComponent,
  DatasetComponent,
  GridComponent,
  LegendComponent,
  ToolboxComponent,
  TooltipComponent,
} from "echarts/components";
import * as echarts from "echarts/core";
import type { EChartsCoreOption as EChartsOption, EChartsType as ECharts } from "echarts/core";
import { CanvasRenderer } from "echarts/renderers";
import { useEffect, useRef } from "react";
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
      aria-label={kind === "bucket" ? "Spend by active observation" : "Cumulative spend by active observation"}
    />
  );
}

export function createChartOption(
  points: readonly TimeseriesPoint[],
  kind: CostChartProps["kind"],
  zoomRange?: ChartZoomRange,
): EChartsOption {
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
    color: ["#65d6ad", "#42a5c6", "#8b7cf6", "#f0a04b", "#f5f7fa"],
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
        backgroundColor: "#0d131b",
        fillerColor: "#65d6ad20",
        handleStyle: { color: "#65d6ad" },
        showDetail: false,
        textStyle: { color: "#738092", fontSize: 9 },
        ...zoomRange,
      },
    ],
    grid: { bottom: 54, containLabel: true, left: 8, right: 18, top: 46 },
    legend: {
      icon: "roundRect",
      itemHeight: 7,
      itemWidth: 16,
      left: 0,
      pageIconColor: "#9aa7b6",
      pageIconInactiveColor: "#4c5866",
      pageTextStyle: { color: "#738092", fontSize: 9 },
      right: 60,
      textStyle: { color: "#9aa7b6", fontSize: 10 },
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
      backgroundColor: "#111821f2",
      borderColor: "#354253",
      formatter: (parameters: unknown) => formatChartTooltip(parameters, rows),
      textStyle: { color: "#e6edf3" },
      trigger: "axis",
    },
    toolbox: {
      emphasis: { iconStyle: { borderColor: "#f5f7fa" } },
      feature: {
        dataZoom: {
          brushStyle: { borderColor: "#65d6ad", color: "#65d6ad20" },
          title: { back: "Undo zoom", zoom: "Drag to zoom" },
          xAxisIndex: 0,
          yAxisIndex: "none",
        },
      },
      iconStyle: { borderColor: "#9aa7b6" },
      itemGap: 8,
      itemSize: 14,
      right: 12,
      top: 4,
    },
    xAxis: {
      axisLabel: {
        color: "#738092",
        formatter: (value: string) => formatObservationTime(rows, value, "axis"),
        hideOverlap: true,
      },
      axisLine: { lineStyle: { color: "#2a3544" } },
      axisPointer: {
        label: {
          backgroundColor: "#273444",
          formatter: (parameters: { value: string | number }) => (
            formatObservationTime(rows, parameters.value, "tooltip")
          ),
        },
      },
      boundaryGap: kind === "bucket",
      splitLine: { show: false },
      type: "category",
    },
    yAxis: {
      axisLabel: { color: "#738092", formatter: (value: number) => formatChartUsd(value) },
      splitLine: { lineStyle: { color: "#19232e" } },
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

function createBarSeries(name: string, dimension: string) {
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

function createCumulativeAreaSeries(name: string, dimension: string) {
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
