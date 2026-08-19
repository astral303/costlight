import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import {
  contrastRatio,
  isDerived,
  PALETTE_STYLESHEET,
  perceptualDistance,
  readDeclarations,
  resolvePalette,
  toSrgbHex,
} from "./support/resolve-palette";

/**
 * Tokens meant to resolve to a colour another token already has, and the token each one
 * follows. Naming the target is the point: without it an alias could be repointed at an
 * unrelated colour and still pass, since it would only ever be excused from the collision
 * check. Requiring the entry is what stops the palette growing a synonym whenever someone
 * needs a name rather than a value.
 */
const ALIASES: Record<string, string> = {
  "--color-badge-neutral": "--color-text-5",
  "--color-status-connected": "--color-accent",
};

/**
 * The background each text colour is used against, taken from the stylesheets. Where a
 * colour appears on several, this names the lightest, which is the worst case.
 *
 * Written by hand, and that is its limitation: it records what the stylesheets do today.
 * Moving text onto a lighter surface means updating it. The check below fails when a text
 * colour has no entry, so a new one cannot be added without the pairing being stated.
 */
const TEXT_BACKGROUNDS: Record<string, string> = {
  "--color-accent": "--color-surface-control",
  "--color-badge-derived": "--color-surface-elevated",
  "--color-badge-neutral": "--color-surface-elevated",
  "--color-badge-primary": "--color-surface-elevated",
  "--color-error-text": "--color-surface-error",
  "--color-text-1": "--color-surface-raised",
  "--color-text-10": "--color-surface-raised",
  "--color-text-11": "--color-page-bg",
  "--color-text-2": "--color-surface-control",
  "--color-text-3": "--color-surface-elevated",
  "--color-text-5": "--color-surface-overlay",
  "--color-text-6": "--color-surface-control",
  "--color-text-7": "--color-surface-control",
  "--color-text-8": "--color-surface-overlay",
  "--color-text-9": "--color-surface-raised",
  "--color-text-on-accent": "--color-accent",
  "--color-warning": "--color-page-bg",
  "--color-warning-text": "--color-surface-warning",
};

/** WCAG 2.1 AA for text below 18pt, which every text colour here is used at. */
const MINIMUM_CONTRAST_RATIO = 4.5;

/**
 * Below this two colours are indistinguishable on screen. Applied to the literals only:
 * those are the palette's degrees of freedom, and two of them landing on one colour is
 * always a mistake. Derived tokens are deliberately close to what they derive from, and
 * their spacing is reviewable as percentages in one place.
 */
const MINIMUM_PERCEPTUAL_DISTANCE = 1;

/**
 * `mask-image` reads only the alpha channel of what it is given, so `#000` there means
 * "opaque here" rather than a colour choice. `--costlight-spill` is one of these, held in
 * a variable because three masks share it.
 */
const STENCIL_DECLARATIONS = /^(?:-webkit-)?mask-image$|^--costlight-spill$/;

/** A colour written out rather than stated against a token. Excludes relative colour syntax. */
const COLOUR_LITERAL = /#[0-9a-f]{3,8}\b|\b(?:rgba?|hsla?|hwb|lab|lch|oklab|oklch|color)\((?!\s*from\b)/i;

/** Every token a stylesheet paints text with, which is what the contrast check has to cover. */
async function readTextTokens(): Promise<Set<string>> {
  const painted = (await readDeclarations()).filter(({ property }) => property === "color");
  return new Set(
    painted.flatMap(({ value }) =>
      [...value.matchAll(/var\((--color-[a-z0-9-]+)\)/g)].map((reference) => reference[1] as string),
    ),
  );
}

describe("the palette", () => {
  test("gives every token a consumer, or a reason to have none", async () => {
    const sources = new Bun.Glob("src/**/*.{css,ts,tsx}");
    const root = join(import.meta.dir, "..", "..");
    let usage = "";
    for await (const path of sources.scan({ cwd: root })) {
      usage += await Bun.file(join(root, path)).text();
    }
    const declared = (await readDeclarations())
      .filter(({ file, property }) => file === PALETTE_STYLESHEET && property.startsWith("--"))
      .map(({ property }) => property);
    const unused = declared.filter((name) => !usage.includes(`var(${name})`));

    // Step 4 of the text ramp has no consumer. It is kept so that step N stays (N - 1) x 10%
    // of the way down the ramp; closing the gap would either leave a hole in the numbering
    // or move every step below it. Every other token has to be reachable from a stylesheet.
    expect(unused).toEqual(["--color-text-4"]);
  });

  test("keeps colour literals out of the feature stylesheets", async () => {
    const written = (await readDeclarations())
      .filter(({ file }) => file !== PALETTE_STYLESHEET)
      .filter(({ property }) => !STENCIL_DECLARATIONS.test(property))
      .filter(({ value }) => COLOUR_LITERAL.test(value))
      .map(({ file, property, value }) => `${file} sets ${property} to ${value}`);

    expect(written).toEqual([]);
  });

  test("resolves each alias to the token it follows", async () => {
    const palette = await resolvePalette();
    // Reported rather than compared directly, so that a name misspelt on both sides of an
    // entry fails here instead of matching undefined against undefined.
    const colorOf = (name: string) => palette.get(name)?.hex ?? `no such token: ${name}`;
    const misdirected = Object.entries(ALIASES)
      .filter(([alias, target]) => colorOf(alias) !== colorOf(target))
      .map(([alias, target]) => `${alias} is ${colorOf(alias)}, but ${target} is ${colorOf(target)}`);

    expect(misdirected).toEqual([]);
  });

  test("has no two tokens resolving to the same colour undeclared", async () => {
    const byColor = new Map<string, string[]>();
    for (const [name, { hex }] of await resolvePalette()) {
      byColor.set(hex, [...(byColor.get(hex) ?? []), name]);
    }
    const collisions = [...byColor.values()]
      .map((names) => names.filter((name) => !(name in ALIASES)))
      .filter((names) => names.length > 1);

    expect(collisions).toEqual([]);
  });

  test("keeps the literal colours perceptually apart", async () => {
    const literals = [...(await resolvePalette())].filter(([, token]) => !isDerived(token));

    const tooClose: string[] = [];
    for (let index = 0; index < literals.length; index++) {
      for (let other = index + 1; other < literals.length; other++) {
        const [name, token] = literals[index] as [string, { hex: string }];
        const [otherName, otherToken] = literals[other] as [string, { hex: string }];
        const apart = perceptualDistance(token.hex, otherToken.hex);
        if (apart < MINIMUM_PERCEPTUAL_DISTANCE) {
          tooClose.push(`${name} and ${otherName} are dE ${apart.toFixed(2)} apart`);
        }
      }
    }

    expect(tooClose).toEqual([]);
  });

  test("states both ramps as steps between their own ends", async () => {
    const palette = await resolvePalette();
    const anchors = ["--color-text-1", "--color-text-11", "--color-app-bg", "--color-border"];

    // The point of the refactor: within a ramp a colour is either an end or a stated step
    // between the ends, so retuning an end moves the whole ramp rather than one token.
    // Naming the ramps rather than counting literals, because a bare count stays green
    // when a single step is pasted back as a hex, which is the regression worth catching.
    const undeclared = [...palette]
      .filter(([name]) => /^--color-(text-\d+|surface-(subtle|raised|elevated|control|overlay)|page-bg)$/.test(name))
      .filter(([name, token]) => !anchors.includes(name) && !isDerived(token))
      .map(([name]) => name);

    expect(undeclared).toEqual([]);
  });
});

describe("text contrast", () => {
  test("names a background for every colour a stylesheet paints text with", async () => {
    const unstated = [...(await readTextTokens())].filter((name) => !(name in TEXT_BACKGROUNDS)).sort();

    expect(unstated).toEqual([]);
  });

  test("clears WCAG AA on the background each colour is used against", async () => {
    const palette = await resolvePalette();
    const failures: string[] = [];
    for (const [name, background] of Object.entries(TEXT_BACKGROUNDS)) {
      const foreground = palette.get(name);
      const behind = palette.get(background);
      if (foreground === undefined || behind === undefined) {
        failures.push(`${name} on ${background}: one of the pair is not declared`);
        continue;
      }
      const ratio = contrastRatio(foreground.hex, behind.hex);
      if (ratio < MINIMUM_CONTRAST_RATIO) {
        failures.push(`${name} on ${background} is ${ratio.toFixed(2)}:1`);
      }
    }

    expect(failures).toEqual([]);
  });
});

test("index.html repeats the page background browser chrome cannot read", async () => {
  const document = await Bun.file(join(import.meta.dir, "..", "..", "index.html")).text();
  const themeColor = /<meta name="theme-color" content="([^"]+)"/.exec(document);

  expect(themeColor?.[1]).toBeDefined();
  expect(toSrgbHex(themeColor?.[1] as string)).toBe(
    ((await resolvePalette()).get("--color-page-bg") as { hex: string }).hex,
  );
});
