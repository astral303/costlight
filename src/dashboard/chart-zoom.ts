import type { TimeseriesPoint } from "./contracts";

const RANGE_EDGE_TOLERANCE_PERCENT = 0.5;

export interface ChartZoomRange {
  endValue: number;
  startValue: number;
}

export interface ChartZoomWindow {
  endTimeMs: number;
  followsLatest: boolean;
  startTimeMs: number;
  visiblePointCount: number;
}

export function captureChartZoom(
  points: readonly TimeseriesPoint[],
  startPercent: number,
  endPercent: number,
): ChartZoomWindow | null {
  if (points.length === 0 || isFullRange(startPercent, endPercent)) {
    return null;
  }

  const startIndex = percentToPointIndex(startPercent, points.length);
  const endIndex = percentToPointIndex(endPercent, points.length);
  const firstIndex = Math.min(startIndex, endIndex);
  const lastIndex = Math.max(startIndex, endIndex);
  const firstPoint = points[firstIndex];
  const lastPoint = points[lastIndex];
  if (firstPoint === undefined || lastPoint === undefined) {
    return null;
  }

  return {
    endTimeMs: lastPoint.bucketStartMs,
    followsLatest: endPercent >= 100 - RANGE_EDGE_TOLERANCE_PERCENT,
    startTimeMs: firstPoint.bucketStartMs,
    visiblePointCount: lastIndex - firstIndex + 1,
  };
}

export function restoreChartZoom(
  points: readonly TimeseriesPoint[],
  window: ChartZoomWindow | null,
): ChartZoomRange | undefined {
  if (window === null || points.length === 0) {
    return undefined;
  }

  if (window.followsLatest) {
    const endValue = points.length - 1;
    return {
      endValue,
      startValue: Math.max(0, endValue - window.visiblePointCount + 1),
    };
  }

  const startValue = findFirstPointAtOrAfter(points, window.startTimeMs);
  const endValue = findLastPointAtOrBefore(points, window.endTimeMs);
  if (startValue <= endValue) {
    return { endValue, startValue };
  }

  const nearestValue = findNearestPoint(points, window.startTimeMs);
  return { endValue: nearestValue, startValue: nearestValue };
}

function isFullRange(startPercent: number, endPercent: number): boolean {
  return startPercent <= RANGE_EDGE_TOLERANCE_PERCENT
    && endPercent >= 100 - RANGE_EDGE_TOLERANCE_PERCENT;
}

function percentToPointIndex(percent: number, pointCount: number): number {
  const boundedPercent = Math.max(0, Math.min(100, percent));
  return Math.round((boundedPercent / 100) * (pointCount - 1));
}

function findFirstPointAtOrAfter(
  points: readonly TimeseriesPoint[],
  timestampMs: number,
): number {
  const index = points.findIndex((point) => point.bucketStartMs >= timestampMs);
  return index === -1 ? points.length : index;
}

function findLastPointAtOrBefore(
  points: readonly TimeseriesPoint[],
  timestampMs: number,
): number {
  for (let index = points.length - 1; index >= 0; index -= 1) {
    if ((points[index]?.bucketStartMs ?? Number.POSITIVE_INFINITY) <= timestampMs) {
      return index;
    }
  }
  return -1;
}

function findNearestPoint(
  points: readonly TimeseriesPoint[],
  timestampMs: number,
): number {
  let nearestIndex = 0;
  let nearestDistance = Number.POSITIVE_INFINITY;
  for (const [index, point] of points.entries()) {
    const distance = Math.abs(point.bucketStartMs - timestampMs);
    if (distance < nearestDistance) {
      nearestDistance = distance;
      nearestIndex = index;
    }
  }
  return nearestIndex;
}
