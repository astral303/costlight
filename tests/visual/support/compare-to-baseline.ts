import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import pixelmatch from "pixelmatch";
import { PNG } from "pngjs";

const BASELINE_DIRECTORY = join(import.meta.dir, "..", "__baselines__");
const FAILURE_DIRECTORY = join(import.meta.dir, "..", "__failures__");

/** Anti-aliasing of text differs slightly between runs; below this a pixel is unchanged. */
const PIXEL_TOLERANCE = 0.12;

export interface BaselineComparison {
  changedPixelRatio: number;
  changedPixels: number;
  failureArtifacts: string[];
  isBaselineMissing: boolean;
}

export interface ComputedStyleComparison extends BaselineComparison {
  changedProperties: string[];
}

export function compareToBaseline(name: string, actualPng: Buffer): BaselineComparison {
  const baselinePath = join(BASELINE_DIRECTORY, `${name}.png`);

  if (shouldUpdateBaselines() || !existsSync(baselinePath)) {
    writeFile(baselinePath, actualPng);
    return {
      changedPixelRatio: 0,
      changedPixels: 0,
      failureArtifacts: [],
      isBaselineMissing: !shouldUpdateBaselines(),
    };
  }

  const baseline = PNG.sync.read(readFileSync(baselinePath));
  const actual = PNG.sync.read(actualPng);

  if (baseline.width !== actual.width || baseline.height !== actual.height) {
    return {
      changedPixelRatio: 1,
      changedPixels: actual.width * actual.height,
      failureArtifacts: writeFailureArtifacts(name, actualPng, null),
      isBaselineMissing: false,
    };
  }

  const diff = new PNG({ height: baseline.height, width: baseline.width });
  const changedPixels = pixelmatch(
    baseline.data,
    actual.data,
    diff.data,
    baseline.width,
    baseline.height,
    { threshold: PIXEL_TOLERANCE },
  );
  const changedPixelRatio = changedPixels / (baseline.width * baseline.height);

  return {
    changedPixelRatio,
    changedPixels,
    failureArtifacts: changedPixels === 0
      ? []
      : writeFailureArtifacts(name, actualPng, PNG.sync.write(diff)),
    isBaselineMissing: false,
  };
}

export function compareToComputedStyleBaseline(
  name: string,
  actualSnapshot: unknown,
): ComputedStyleComparison {
  const baselinePath = join(BASELINE_DIRECTORY, `${name}.styles.json`);
  const normalized = canonicalizeForComparison(actualSnapshot);
  const actualText = JSON.stringify(normalized, null, 2) + "\n";

  if (shouldUpdateBaselines() || !existsSync(baselinePath)) {
    writeFile(baselinePath, Buffer.from(actualText, "utf8"));
    return {
      changedPixelRatio: 0,
      changedPixels: 0,
      changedProperties: [],
      failureArtifacts: [],
      isBaselineMissing: !shouldUpdateBaselines(),
    };
  }

  const baselineText = readFileSync(baselinePath, "utf8");
  const baselineSnapshot = JSON.parse(baselineText) as unknown;
  const baselineCanonical = canonicalizeForComparison(baselineSnapshot);
  const baselineCanonicalText = JSON.stringify(baselineCanonical, null, 2) + "\n";
  if (baselineCanonicalText === actualText) {
    return {
      changedPixelRatio: 0,
      changedPixels: 0,
      changedProperties: [],
      failureArtifacts: [],
      isBaselineMissing: false,
    };
  }

  const changedProperties = compareObjectTree(baselineCanonical, normalized);
  const failureArtifacts = writeFailureArtifacts(
    `${name}.styles`,
    Buffer.from(actualText, "utf8"),
    null,
  );
  return {
    changedPixelRatio: changedProperties.length / Math.max(1, countLeaves(baselineCanonical)),
    changedPixels: changedProperties.length,
    changedProperties,
    failureArtifacts,
    isBaselineMissing: false,
  };
}

export function shouldUpdateBaselines(): boolean {
  return process.env.UPDATE_VISUAL_BASELINES === "1";
}

function writeFailureArtifacts(name: string, actual: Buffer, diff: Buffer | null): string[] {
  const extension = name.endsWith(".styles") ? "json" : "png";
  const actualPath = join(FAILURE_DIRECTORY, `${name}.actual.${extension}`);
  writeFile(actualPath, actual);
  if (diff === null) {
    return [actualPath];
  }
  const diffPath = join(
    FAILURE_DIRECTORY,
    `${name}.diff.${extension}`,
  );
  writeFile(diffPath, diff);
  return [actualPath, diffPath];
}

function writeFile(path: string, contents: Buffer): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, contents);
}

function canonicalizeForComparison(value: unknown): unknown {
  if (value === null || value === undefined) {
    return {};
  }
  if (Array.isArray(value)) {
    return value.map((item) => canonicalizeForComparison(item));
  }
  if (typeof value !== "object") {
  return value;
}
  const record = value as Record<string, unknown>;
  const sortedEntries = Object.keys(record)
    .sort()
    .map((key) => [key, canonicalizeForComparison(record[key])]);
  return Object.fromEntries(sortedEntries) as object;
}

function compareObjectTree(
  expected: unknown,
  actual: unknown,
  path = "",
): string[] {
  if (expected === null || actual === null) {
    return expected === actual ? [] : [path || "root"];
  }
  if (typeof expected !== "object" || typeof actual !== "object") {
    return expected === actual ? [] : [path || "root"];
  }
  if (Array.isArray(expected) !== Array.isArray(actual)) {
    return [path || "root"];
  }
  if (Array.isArray(expected) && Array.isArray(actual)) {
    if (expected.length !== actual.length) {
      return [path || "root"];
    }
    return expected.flatMap((item, index) => compareObjectTree(
      item as object,
      actual[index] as object,
      `${path}[${index}]`,
    ));
  }
  const expectedRecord = expected as Record<string, unknown>;
  const actualRecord = actual as Record<string, unknown>;
  const keys = new Set([...Object.keys(expectedRecord), ...Object.keys(actualRecord)]);
  const differences: string[] = [];

  for (const key of [...keys].sort()) {
    const nextPath = path.length === 0 ? key : `${path}.${key}`;
    differences.push(...compareObjectTree(
      expectedRecord[key] as object,
      actualRecord[key] as object,
      nextPath,
    ));
  }
  return differences;
}

function countLeaves(snapshot: object): number {
  if (snapshot === null || snapshot === undefined) {
    return 0;
  }
  if (typeof snapshot !== "object") {
    return 1;
  }
  if (Array.isArray(snapshot)) {
    return snapshot.reduce((sum, entry) => sum + countLeaves(entry as unknown), 0);
  }
  return Object.values(snapshot as Record<string, unknown>).reduce(
    (sum, value) => sum + countLeaves(value as unknown),
    0,
  );
}
