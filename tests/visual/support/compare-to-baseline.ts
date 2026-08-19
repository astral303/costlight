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

export function shouldUpdateBaselines(): boolean {
  return process.env.UPDATE_VISUAL_BASELINES === "1";
}

function writeFailureArtifacts(name: string, actual: Buffer, diff: Buffer | null): string[] {
  const actualPath = join(FAILURE_DIRECTORY, `${name}.actual.png`);
  writeFile(actualPath, actual);
  if (diff === null) {
    return [actualPath];
  }
  const diffPath = join(FAILURE_DIRECTORY, `${name}.diff.png`);
  writeFile(diffPath, diff);
  return [actualPath, diffPath];
}

function writeFile(path: string, contents: Buffer): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, contents);
}
