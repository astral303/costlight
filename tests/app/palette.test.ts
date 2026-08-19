import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { isDerived, resolvePalette } from "./support/resolve-palette";

/**
 * Tokens meant to resolve to a colour another token already has. Each names a second
 * meaning, so that retuning one meaning does not silently move the other. Requiring the
 * declaration here is what stops the palette growing a synonym whenever someone needs a
 * name rather than a value.
 */
const INTENTIONAL_ALIASES = new Set(["--color-badge-neutral", "--color-status-connected"]);

/**
 * Below this two colours are indistinguishable on screen. Applied to the literals only:
 * those are the palette's degrees of freedom, and two of them landing on one colour is
 * always a mistake. Derived tokens are deliberately close to what they derive from, and
 * their spacing is reviewable as percentages in one place.
 */
const MINIMUM_PERCEPTUAL_DISTANCE = 1;

/** Perceptual distance in CIE Lab, the space the ramps are spaced in. */
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

describe("the palette", () => {
  test("gives every token a consumer, or a reason to have none", async () => {
    const sources = new Bun.Glob("src/**/*.{css,ts,tsx}");
    const root = join(import.meta.dir, "..", "..");
    let usage = "";
    for await (const path of sources.scan({ cwd: root })) {
      usage += await Bun.file(join(root, path)).text();
    }
    const unused = [...(await resolvePalette()).keys()]
      .filter((name) => !usage.includes(`var(${name})`));

    // Step 4 of the text ramp has no consumer. It is kept so the ramp's percentages stay
    // an even 10% apart, which is what lets the nine middle steps be stated rather than
    // picked. Every other token has to be reachable from a stylesheet.
    expect(unused).toEqual(["--color-text-4"]);
  });

  test("has no two tokens resolving to the same colour undeclared", async () => {
    const byColor = new Map<string, string[]>();
    for (const [name, { hex }] of await resolvePalette()) {
      byColor.set(hex, [...(byColor.get(hex) ?? []), name]);
    }
    const collisions = [...byColor.values()]
      .map((names) => names.filter((name) => !INTENTIONAL_ALIASES.has(name)))
      .filter((names) => names.length > 1);

    expect(collisions).toEqual([]);
  });

  test("keeps the literal colours perceptually apart", async () => {
    const literals = [...await resolvePalette()]
      .filter(([, token]) => !isDerived(token) && token.hex.length === 7);

    const tooClose: string[] = [];
    for (let i = 0; i < literals.length; i++) {
      for (let j = i + 1; j < literals.length; j++) {
        const [nameA, tokenA] = literals[i] as [string, { hex: string }];
        const [nameB, tokenB] = literals[j] as [string, { hex: string }];
        const apart = distance(toLab(tokenA.hex), toLab(tokenB.hex));
        if (apart < MINIMUM_PERCEPTUAL_DISTANCE) {
          tooClose.push(`${nameA} and ${nameB} are dE ${apart.toFixed(2)} apart`);
        }
      }
    }

    expect(tooClose).toEqual([]);
  });

  test("states both ramps as steps between their own ends", async () => {
    const palette = await resolvePalette();
    const isAnchor = (name: string) =>
      ["--color-text-1", "--color-text-11", "--color-app-bg", "--color-border"].includes(name);

    // The point of the refactor: within a ramp a colour is either an end or a stated step
    // between the ends, so retuning an end moves the whole ramp rather than one token.
    // Naming the ramps rather than counting literals, because a bare count stays green
    // when a single step is pasted back as a hex, which is the regression worth catching.
    const undeclared = [...palette]
      .filter(([name]) => /^--color-(text-\d+|surface-(subtle|raised|elevated|control|overlay)|page-bg)$/.test(name))
      .filter(([name, token]) => !isAnchor(name) && !isDerived(token))
      .map(([name]) => name);

    expect(undeclared).toEqual([]);
  });
});
