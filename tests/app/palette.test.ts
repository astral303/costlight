import { describe, expect, test } from "bun:test";
import { join } from "node:path";

const APPLICATION_CSS = join(import.meta.dir, "..", "..", "src", "app", "application.css");

/**
 * Tokens that are meant to resolve to a colour another token already has. Each one exists
 * to name a second meaning, so that retuning one meaning does not silently move the other.
 * A duplicate has to be declared here, which is what would have stopped `--color-secondary`
 * from being invented purely to feed a chart token.
 */
const INTENTIONAL_ALIASES = new Set(["--color-badge-neutral", "--color-status-connected"]);

/**
 * Below this two colours are indistinguishable on screen, so the pair is a naming bug.
 *
 * Chosen from the palette's own structure rather than as a round number: the surface ramp
 * steps deliberately and its closest neighbours sit at dE 1.58, while the pairs that are
 * genuinely one colour under two names sit at 0.48 and 0.52. One 8-bit channel step is
 * itself worth about dE 0.5, so a tighter floor than this would barely outperform the
 * exact-duplicate check above.
 */
const MINIMUM_PERCEPTUAL_DISTANCE = 1;

/**
 * Surfaces that sit closer than the eye can resolve but name genuinely different roles.
 * Phase 3 of the palette refactor expresses the surface ramp as transforms off
 * `--color-page-bg`, at which point each gap becomes a stated step rather than two
 * literals that happen to agree, and these entries go away.
 */
const PENDING_SURFACE_TRANSFORM = new Set(["--color-surface-overlay", "--color-app-bg"]);

async function readPalette(): Promise<Map<string, string>> {
  const stylesheet = await Bun.file(APPLICATION_CSS).text();
  const tokens = new Map<string, string>();
  for (const [, name, value] of stylesheet.matchAll(/^\s*(--color-[a-z0-9-]+):\s*([^;]+);/gm)) {
    tokens.set(name as string, (value as string).trim());
  }
  return tokens;
}

/** Resolves `var()` chains so aliases compare as the colour they actually render. */
function resolve(value: string, tokens: Map<string, string>, depth = 0): string {
  if (depth > 10) {
    throw new Error(`var() chain does not terminate: ${value}`);
  }
  return value.replace(/var\((--color-[a-z0-9-]+)\)/g, (whole, name: string) => {
    const target = tokens.get(name);
    return target === undefined ? whole : resolve(target, tokens, depth + 1);
  });
}

function toLab(hex: string): [number, number, number] {
  const channel = (offset: number) => {
    const value = parseInt(hex.slice(offset, offset + 2), 16) / 255;
    return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  };
  const [red, green, blue] = [channel(1), channel(3), channel(5)];
  const x = (0.4124 * red + 0.3576 * green + 0.1805 * blue) / 0.95047;
  const y = 0.2126 * red + 0.7152 * green + 0.0722 * blue;
  const z = (0.0193 * red + 0.1192 * green + 0.9505 * blue) / 1.08883;
  const f = (t: number) => (t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116);
  return [116 * f(y) - 16, 500 * (f(x) - f(y)), 200 * (f(y) - f(z))];
}

const distance = (a: [number, number, number], b: [number, number, number]) =>
  Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);

/** Opaque six-digit tokens only; alpha values are compared as text, not perceptually. */
async function readOpaqueColors(): Promise<[string, string][]> {
  const tokens = await readPalette();
  return [...tokens]
    .map(([name, value]) => [name, resolve(value, tokens)] as [string, string])
    .filter(([, value]) => /^#[0-9a-f]{6}$/.test(value));
}

describe("the palette", () => {
  test("gives every token a consumer, or a reason to have none", async () => {
    const sources = new Bun.Glob("src/**/*.{css,ts,tsx}");
    let usage = "";
    for await (const path of sources.scan({ cwd: join(import.meta.dir, "..", "..") })) {
      usage += await Bun.file(join(import.meta.dir, "..", "..", path)).text();
    }
    const unused = [...(await readPalette()).keys()]
      .filter((name) => !usage.includes(`var(${name})`));

    // Step 4 of the text ramp keeps the spacing arithmetic so each step can become a
    // transform of step 1. Every other token has to be reachable from a stylesheet.
    expect(unused).toEqual(["--color-text-4"]);
  });

  test("has no two tokens resolving to the same colour undeclared", async () => {
    const byColor = new Map<string, string[]>();
    for (const [name, color] of await readOpaqueColors()) {
      byColor.set(color, [...(byColor.get(color) ?? []), name]);
    }
    const collisions = [...byColor.values()]
      .filter((names) => names.length > 1)
      .map((names) => names.filter((name) => !INTENTIONAL_ALIASES.has(name)))
      .filter((names) => names.length > 1);

    expect(collisions).toEqual([]);
  });

  test("keeps distinct tokens perceptually apart", async () => {
    const colors = (await readOpaqueColors()).filter(
      ([name]) => !INTENTIONAL_ALIASES.has(name) && !PENDING_SURFACE_TRANSFORM.has(name),
    );
    const tooClose: string[] = [];
    for (let i = 0; i < colors.length; i++) {
      for (let j = i + 1; j < colors.length; j++) {
        const [nameA, hexA] = colors[i] as [string, string];
        const [nameB, hexB] = colors[j] as [string, string];
        const apart = distance(toLab(hexA), toLab(hexB));
        if (apart < MINIMUM_PERCEPTUAL_DISTANCE) {
          tooClose.push(`${nameA} and ${nameB} are dE ${apart.toFixed(2)} apart`);
        }
      }
    }

    expect(tooClose).toEqual([]);
  });
});
