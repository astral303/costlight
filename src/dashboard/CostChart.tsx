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
  MarkLineComponent,
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
import type { TimeseriesPoint, TimeseriesResolution } from "./contracts";
import { formatTrailingWindow, TRAILING_WINDOW } from "./formatting";
import "./cost-chart.css";

const CHART_GROUP = "costlight";
let areChartsConnected = false;

/** Idle time between observations, beyond the bucket spacing, worth marking. */
const IDLE_GAP_MINIMUM_MS = 60 * 60 * 1_000;
/**
 * A main-agent call is a context rebuild when at least this share of its prompt missed
 * the cache. Both a compaction and a cold start after cache expiry look like this: the
 * context is re-written rather than read back. Subagent calls never qualify — a subagent
 * always starts on a fresh prompt.
 */
const CONTEXT_REBUILD_FRESH_SHARE = 0.5;
/** Below this prompt size a cache miss is a routine small call, not a rebuilt context. */
const CONTEXT_REBUILD_MINIMUM_PROMPT_TOKENS = 20_000;

const TOTAL_SERIES_ID = "total";

export type CostChartKind = "bucket" | "cumulative" | "context" | "cacheHitRatio";

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
  MarkLineComponent,
  ToolboxComponent,
  TooltipComponent,
]);

export interface CostChartView {
  /** Let the y axis start at the visible data instead of zero. */
  anchorYAxisToData?: boolean | undefined;
  resolution?: TimeseriesResolution | undefined;
}

interface CostChartProps extends CostChartView {
  kind: CostChartKind;
  points: readonly TimeseriesPoint[];
  zoomContext: string;
}

/** A type alias rather than an interface: echarts' dataset source needs the implicit index signature. */
type ChartRow = {
  cacheCreation: number;
  cacheRead: number;
  /** Null when the observation holds no call of that agent kind, so the line skips it. */
  contextMain: number | null;
  contextSubagent: number | null;
  hitRatio: number;
  idleGapMs: number;
  /** 1 when the call re-wrote its context instead of reading it back; a dataset row cannot hold a boolean. */
  contextRebuild: 0 | 1;
  noCacheTotal: number;
  observation: number;
  output: number;
  pointHitRatio: number;
  time: number;
  total: number;
  trailingAverage: number;
  uncachedInput: number;
};

const CHART_ARIA_LABELS: Record<CostChartKind, string> = {
  bucket: "API cost by active observation",
  cacheHitRatio: "Cache hit ratio by active observation",
  context: "Context size by active observation",
  cumulative: "Cumulative API cost by active observation",
};

/**
 * One colour per series name, so a series keeps its colour wherever it appears and in
 * whatever stack position. The trailing average wears the Total colour because it is the
 * total smoothed; the hit ratio wears the cache-read colour because it is the cache-read
 * share.
 */
const SERIES_COLOR_BY_NAME: Record<string, string> = {
  "Cache creation": CHART_SERIES_COLORS.cacheCreation,
  "Cache hit ratio": CHART_SERIES_COLORS.cacheRead,
  "Cache read": CHART_SERIES_COLORS.cacheRead,
  "Main agent": CHART_SERIES_COLORS.contextSize,
  "Output": CHART_SERIES_COLORS.output,
  "Subagents": CHART_SERIES_COLORS.subagentContext,
  "Total": CHART_SERIES_COLORS.total,
  "Trailing avg": CHART_SERIES_COLORS.total,
  "Uncached input": CHART_SERIES_COLORS.uncachedInput,
  "Without caching": CHART_SERIES_COLORS.withoutCaching,
};

export function CostChart({
  anchorYAxisToData = false,
  kind,
  points,
  resolution,
  zoomContext,
}: CostChartProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<ECharts | null>(null);
  const pointsRef = useRef(points);
  const zoomContextRef = useRef(zoomContext);
  const zoomWindowRef = useRef<ChartZoomWindow | null>(null);
  const hasRenderedRef = useRef(false);
  const deltaLineIndexRef = useRef<number | null>(null);
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
    const detachDeltaLine = kind === "cumulative"
      ? attachDeltaToEndLine(chart, pointsRef, zoomWindowRef, deltaLineIndexRef)
      : null;
    const resizeObserver = new ResizeObserver(() => chart.resize());
    resizeObserver.observe(container);
    return () => {
      resizeObserver.disconnect();
      detachDeltaLine?.();
      chart.off("datazoom", rememberZoom);
      chart.dispose();
      chartRef.current = null;
    };
  }, [kind]);

  useEffect(() => {
    const shouldResetChart = zoomContextRef.current !== zoomContext;
    if (shouldResetChart) {
      zoomContextRef.current = zoomContext;
      zoomWindowRef.current = null;
    }
    const zoomRange = restoreChartZoom(points, zoomWindowRef.current);
    const option = createChartOption(points, kind, zoomRange, { anchorYAxisToData, resolution });
    // Passing `legend.selected` on a merge update would undo the reader's own legend
    // clicks on every live refresh; it belongs only to a fresh chart.
    if (hasRenderedRef.current && !shouldResetChart && option.legend !== undefined) {
      delete (option.legend as { selected?: unknown }).selected;
    }
    chartRef.current?.setOption(option, { notMerge: shouldResetChart });
    hasRenderedRef.current = true;
  }, [anchorYAxisToData, kind, points, resolution, zoomContext]);

  return (
    <div
      ref={containerRef}
      className="cost-chart"
      role="img"
      aria-label={CHART_ARIA_LABELS[kind]}
    />
  );
}

export function createChartOption(
  points: readonly TimeseriesPoint[],
  kind: CostChartKind,
  zoomRange?: ChartZoomRange,
  view: CostChartView = {},
): CostChartOption {
  const rows = buildChartRows(points, kind, view.resolution);
  const series = createSeries(kind, rows, view.resolution);
  const seriesNames = series.map((entry) => entry.name as string);
  const isSingleSeries = series.length === 1;

  return {
    animationDurationUpdate: 260,
    aria: { enabled: true },
    backgroundColor: "transparent",
    color: seriesNames.map((name) => SERIES_COLOR_BY_NAME[name] ?? CHART_CHROME.axisLabel),
    dataset: {
      dimensions: [
        "observation",
        "time",
        "uncachedInput",
        "cacheCreation",
        "cacheRead",
        "output",
        "total",
        "trailingAverage",
        "noCacheTotal",
        "contextMain",
        "contextSubagent",
        "hitRatio",
      ],
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
      // The counterfactual rescales the axis several-fold, so it starts deselected and
      // is opted into from the legend.
      ...(kind === "cumulative" ? { selected: { "Without caching": false } } : {}),
      show: !isSingleSeries,
      textStyle: { color: CHART_CHROME.legendText, fontSize: 10 },
      top: 4,
      type: "scroll",
    },
    series,
    tooltip: {
      axisPointer: { type: kind === "bucket" ? "shadow" : "line" },
      backgroundColor: CHART_CHROME.tooltipBackground,
      borderColor: CHART_CHROME.tooltipBorder,
      formatter: (parameters: unknown) => formatChartTooltip(parameters, rows, kind, view.resolution),
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
      axisLabel: {
        color: CHART_CHROME.axisLabel,
        formatter: (value: number) => formatYAxisValue(value, kind),
      },
      // The hit ratio lives within a few points of 100%, so it always follows the data;
      // the cumulative chart does so only when asked. A share axis never exceeds 100%.
      ...(kind === "cacheHitRatio" ? { max: 1 } : {}),
      scale: kind === "cacheHitRatio" || (kind === "cumulative" && view.anchorYAxisToData === true),
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

export function buildChartRows(
  points: readonly TimeseriesPoint[],
  kind: CostChartKind,
  resolution: TimeseriesResolution | undefined,
): ChartRow[] {
  const useCumulativeCosts = kind === "cumulative";
  const spacingMs = expectedSpacingMs(resolution);
  let windowTotalNano = 0;
  let windowCacheReadTokens = 0;
  let windowPromptTokens = 0;

  return points.map((point, observation) => {
    windowTotalNano += point.totalCostNano;
    windowCacheReadTokens += point.cacheReadTokens;
    windowPromptTokens += point.promptTokens;
    const leavingPoint = points[observation - TRAILING_WINDOW];
    if (leavingPoint !== undefined) {
      windowTotalNano -= leavingPoint.totalCostNano;
      windowCacheReadTokens -= leavingPoint.cacheReadTokens;
      windowPromptTokens -= leavingPoint.promptTokens;
    }
    const windowSize = Math.min(observation + 1, TRAILING_WINDOW);

    const previousPoint = points[observation - 1];
    const idleMs = previousPoint === undefined
      ? 0
      : Math.max(0, point.bucketStartMs - previousPoint.bucketStartMs - spacingMs);
    const freshPromptTokens = point.promptTokens - point.cacheReadTokens;

    return {
      cacheCreation: nanoToUsd(useCumulativeCosts ? point.cumulativeCacheCreationCostNano : point.cacheCreationCostNano),
      cacheRead: nanoToUsd(useCumulativeCosts ? point.cumulativeCacheReadCostNano : point.cacheReadCostNano),
      contextMain: point.peakMainPromptTokens > 0 ? point.peakMainPromptTokens : null,
      contextRebuild: resolution === "call"
          && point.peakMainPromptTokens > 0
          && point.promptTokens >= CONTEXT_REBUILD_MINIMUM_PROMPT_TOKENS
          && freshPromptTokens / point.promptTokens >= CONTEXT_REBUILD_FRESH_SHARE
        ? 1
        : 0,
      contextSubagent: point.peakSubagentPromptTokens > 0 ? point.peakSubagentPromptTokens : null,
      hitRatio: windowPromptTokens === 0 ? 0 : windowCacheReadTokens / windowPromptTokens,
      idleGapMs: idleMs >= IDLE_GAP_MINIMUM_MS ? idleMs : 0,
      noCacheTotal: nanoToUsd(point.cumulativeNoCacheCostNano),
      observation,
      output: nanoToUsd(useCumulativeCosts ? point.cumulativeOutputCostNano : point.outputCostNano),
      pointHitRatio: point.promptTokens === 0 ? 0 : point.cacheReadTokens / point.promptTokens,
      time: point.bucketStartMs,
      total: nanoToUsd(useCumulativeCosts ? point.cumulativeTotalCostNano : point.totalCostNano),
      trailingAverage: nanoToUsd(windowTotalNano / windowSize),
      uncachedInput: nanoToUsd(useCumulativeCosts ? point.cumulativeInputCostNano : point.inputCostNano),
    };
  });
}

function createSeries(
  kind: CostChartKind,
  rows: readonly ChartRow[],
  resolution: TimeseriesResolution | undefined,
): (BarSeriesOption | LineSeriesOption)[] {
  // Between-turn timeouts are a per-call story; at bucket resolution the many routine
  // gaps between active buckets would paper every chart with markers.
  const showIdleGaps = resolution === "call";
  if (kind === "bucket") {
    return [
      {
        ...createBarSeries("Cache read", "cacheRead"),
        markLine: createEventMarkers(rows, "gaps-and-rebuilds", showIdleGaps),
      },
      createBarSeries("Cache creation", "cacheCreation"),
      createBarSeries("Uncached input", "uncachedInput"),
      createBarSeries("Output", "output"),
      createOverlayLineSeries("Trailing avg", "trailingAverage"),
    ];
  }
  if (kind === "cumulative") {
    return [
      {
        ...createCumulativeAreaSeries("Cache read", "cacheRead"),
        markLine: createEventMarkers(rows, "gaps-and-rebuilds", showIdleGaps),
      },
      createCumulativeAreaSeries("Cache creation", "cacheCreation"),
      createCumulativeAreaSeries("Uncached input", "uncachedInput"),
      createCumulativeAreaSeries("Output", "output"),
      {
        ...createOverlayLineSeries("Total", "total"),
        id: TOTAL_SERIES_ID,
        // Cleared on every rebuild so a hover line never outlives its data; the
        // delta-to-end hover repopulates it.
        markLine: { animation: false, data: [], silent: true, symbol: "none" },
        step: "start",
      },
      {
        ...createOverlayLineSeries("Without caching", "noCacheTotal"),
        lineStyle: { type: "dashed", width: 1.5 },
        step: "start",
      },
    ];
  }
  if (kind === "context") {
    // Each line connects only its own calls, so the main context stays a readable
    // sawtooth across subagent bursts instead of zigzagging down to their small prompts.
    return [
      {
        areaStyle: { opacity: 0.18 },
        connectNulls: true,
        datasetIndex: 0,
        encode: { x: "observation", y: "contextMain" },
        lineStyle: { width: 1.5 },
        markLine: createEventMarkers(rows, "gaps-and-rebuilds", showIdleGaps),
        name: "Main agent",
        showSymbol: false,
        type: "line",
      },
      {
        connectNulls: true,
        datasetIndex: 0,
        encode: { x: "observation", y: "contextSubagent" },
        lineStyle: { width: 1.5 },
        name: "Subagents",
        showSymbol: false,
        type: "line",
      },
    ];
  }
  return [{
    datasetIndex: 0,
    encode: { x: "observation", y: "hitRatio" },
    lineStyle: { width: 1.5 },
    markLine: createEventMarkers(rows, "gaps", showIdleGaps),
    name: "Cache hit ratio",
    showSymbol: false,
    type: "line",
  }];
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

function createOverlayLineSeries(name: string, dimension: string): LineSeriesOption {
  return {
    datasetIndex: 0,
    encode: { x: "observation", y: dimension },
    emphasis: { focus: "series" as const },
    lineStyle: { width: 1.5 },
    name,
    showSymbol: false,
    type: "line" as const,
    z: 8,
  };
}

type EventMarkerSelection = "gaps" | "gaps-and-rebuilds";

function createEventMarkers(
  rows: readonly ChartRow[],
  selection: EventMarkerSelection,
  showIdleGaps: boolean,
): NonNullable<LineSeriesOption["markLine"]> {
  const data: object[] = [];
  for (const row of rows) {
    if (showIdleGaps && row.idleGapMs > 0) {
      data.push({
        label: {
          color: CHART_CHROME.axisLabel,
          fontSize: 9,
          formatter: `${formatIdleDuration(row.idleGapMs)} idle`,
          position: "end" as const,
          show: true,
        },
        lineStyle: { color: CHART_CHROME.axisLabel, type: "dashed" as const, width: 1 },
        xAxis: row.observation,
      });
    } else if (selection === "gaps-and-rebuilds" && row.contextRebuild === 1) {
      data.push({
        label: { show: false },
        lineStyle: {
          color: CHART_SERIES_COLORS.contextSize,
          opacity: 0.7,
          type: "dashed" as const,
          width: 1,
        },
        xAxis: row.observation,
      });
    }
  }
  return { animation: false, data: data as never, silent: true, symbol: "none" };
}

/**
 * On hover, draws a dotted line from the hovered cumulative total to the end of the
 * visible range, labelled with the cost still to come. Listens on this chart but fires
 * for hovers on any connected chart, since the group shares its axis pointer.
 */
function attachDeltaToEndLine(
  chart: ECharts,
  pointsRef: { current: readonly TimeseriesPoint[] },
  zoomWindowRef: { current: ChartZoomWindow | null },
  lastIndexRef: { current: number | null },
): () => void {
  const applyDeltaLine = (hoverIndex: number | null) => {
    if (hoverIndex === lastIndexRef.current) {
      return;
    }
    lastIndexRef.current = hoverIndex;
    chart.setOption({
      series: [{
        id: TOTAL_SERIES_ID,
        markLine: createDeltaToEndMarkLine(pointsRef.current, zoomWindowRef.current, hoverIndex),
      }],
    }, { silent: true });
  };
  const handleAxisPointer = (event: unknown) => {
    applyDeltaLine(readAxisPointerIndex(event, pointsRef.current.length));
  };
  const handleGlobalOut = () => applyDeltaLine(null);
  chart.on("updateAxisPointer", handleAxisPointer);
  chart.on("globalout", handleGlobalOut);
  return () => {
    chart.off("updateAxisPointer", handleAxisPointer);
    chart.off("globalout", handleGlobalOut);
  };
}

export function createDeltaToEndMarkLine(
  points: readonly TimeseriesPoint[],
  zoomWindow: ChartZoomWindow | null,
  hoverIndex: number | null,
): NonNullable<LineSeriesOption["markLine"]> {
  const empty = { animation: false, data: [], silent: true, symbol: "none" } as const;
  if (hoverIndex === null) {
    return { ...empty, data: [] };
  }
  const endIndex = restoreChartZoom(points, zoomWindow)?.endValue ?? points.length - 1;
  const hoverPoint = points[hoverIndex];
  const endPoint = points[endIndex];
  if (hoverPoint === undefined || endPoint === undefined || hoverIndex >= endIndex) {
    return { ...empty, data: [] };
  }
  const hoverTotalUsd = nanoToUsd(hoverPoint.cumulativeTotalCostNano);
  const remainingUsd = nanoToUsd(endPoint.cumulativeTotalCostNano) - hoverTotalUsd;
  if (remainingUsd <= 0) {
    return { ...empty, data: [] };
  }
  return {
    ...empty,
    data: [[
      { coord: [hoverIndex, hoverTotalUsd] },
      {
        coord: [endIndex, hoverTotalUsd],
        label: {
          color: CHART_SERIES_COLORS.total,
          distance: 4,
          fontSize: 10,
          formatter: `+${formatChartUsd(remainingUsd)} to end`,
          position: "insideEndTop" as const,
          show: true,
        },
        lineStyle: { color: CHART_SERIES_COLORS.total, type: "dotted" as const, width: 1 },
      },
    ]] as never,
  };
}

function readAxisPointerIndex(event: unknown, pointCount: number): number | null {
  if (!isRecord(event) || !Array.isArray(event.axesInfo)) {
    return null;
  }
  const axisInfo = event.axesInfo.find((info: unknown) => isRecord(info) && info.axisDim === "x");
  if (!isRecord(axisInfo) || typeof axisInfo.value !== "number") {
    return null;
  }
  const index = Math.round(axisInfo.value);
  return index >= 0 && index < pointCount ? index : null;
}

function expectedSpacingMs(resolution: TimeseriesResolution | undefined): number {
  if (resolution === "minute") return 60_000;
  if (resolution === "hour") return 3_600_000;
  if (resolution === "day") return 86_400_000;
  if (resolution === "week") return 7 * 86_400_000;
  return 0;
}

function formatChartTooltip(
  parameters: unknown,
  rows: readonly ChartRow[],
  kind: CostChartKind,
  resolution: TimeseriesResolution | undefined,
): string {
  const firstParameter = Array.isArray(parameters) ? parameters[0] : parameters;
  if (!isRecord(firstParameter) || typeof firstParameter.dataIndex !== "number") {
    return "";
  }
  const row = rows[firstParameter.dataIndex];
  if (row === undefined) {
    return "";
  }

  const lines = [`<strong>${formatChartTime(row.time, "tooltip")}</strong>`];
  if (row.idleGapMs > 0) {
    lines.push(`After ${formatIdleDuration(row.idleGapMs)} idle`);
  }
  const windowLabel = `trailing ${formatTrailingWindow(resolution)}`;

  if (kind === "context") {
    if (row.contextMain !== null) {
      lines.push(`Main agent: ${formatTokenCount(row.contextMain)} tokens`);
    }
    if (row.contextSubagent !== null) {
      lines.push(`Subagents: ${formatTokenCount(row.contextSubagent)} tokens`);
    }
    lines.push(`Read from cache: ${formatShare(row.pointHitRatio)}`);
    if (row.contextRebuild === 1) {
      lines.push("Context rebuilt here (compaction or cold start)");
    }
    return lines.join("<br>");
  }
  if (kind === "cacheHitRatio") {
    lines.push(`Cache hit ratio: ${formatShare(row.hitRatio)} (${windowLabel})`);
    lines.push(`This observation: ${formatShare(row.pointHitRatio)}`);
    return lines.join("<br>");
  }

  lines.push(
    `Uncached input: ${formatChartUsd(row.uncachedInput)}`,
    `Cache creation: ${formatChartUsd(row.cacheCreation)}`,
    `Cache read: ${formatChartUsd(row.cacheRead)}`,
    `Output: ${formatChartUsd(row.output)}`,
    `Total: ${formatChartUsd(row.total)}`,
  );
  if (kind === "bucket") {
    lines.push(`Trailing avg: ${formatChartUsd(row.trailingAverage)} (${windowLabel})`);
  }
  if (kind === "cumulative") {
    lines.push(`Without caching: ${formatChartUsd(row.noCacheTotal)}`);
    const lastRow = rows.at(-1);
    if (lastRow !== undefined && lastRow.total > row.total) {
      const remaining = lastRow.total - row.total;
      lines.push(`Remaining to end: ${formatChartUsd(remaining)} (${formatShare(remaining / lastRow.total)})`);
    }
  }
  return lines.join("<br>");
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

function formatYAxisValue(value: number, kind: CostChartKind): string {
  if (kind === "context") {
    return formatTokenCount(value);
  }
  if (kind === "cacheHitRatio") {
    return formatShare(value);
  }
  return formatChartUsd(value);
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

function nanoToUsd(costNano: number): number {
  return costNano / 1_000_000_000;
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

function formatTokenCount(value: number): string {
  return new Intl.NumberFormat(undefined, {
    maximumFractionDigits: 1,
    notation: "compact",
  }).format(value);
}

function formatShare(ratio: number): string {
  return new Intl.NumberFormat(undefined, {
    maximumFractionDigits: 1,
    style: "percent",
  }).format(ratio);
}

function formatIdleDuration(durationMs: number): string {
  const hours = durationMs / 3_600_000;
  if (hours >= 48) {
    return `${Math.round(hours / 24)}d`;
  }
  if (hours >= 10) {
    return `${Math.round(hours)}h`;
  }
  return `${Number(hours.toFixed(1))}h`;
}
