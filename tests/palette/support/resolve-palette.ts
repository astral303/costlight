import {
  contrast_ratio_wcag_2_1,
  sRGB_to_XYZ_D50,
  XYZ_D50_to_Lab,
  type Color,
} from "@csstools/color-helpers";
import { color as parseColor, serializeRGB } from "@csstools/css-color-parser";
import { parseComponentValue } from "@csstools/css-parser-algorithms";
import { tokenize } from "@csstools/css-tokenizer";
import { join } from "node:path";

const SOURCE_ROOT = join(import.meta.dir, "..", "..", "..", "src");

/** Where a literal colour may be written. Everywhere else states its colours against these. */
export const PALETTE_STYLESHEET = "palette/palette.css";

export interface Declaration {
  /** Stylesheet path relative to `src`, so a failure can say which file to open. */
  file: string;
  property: string;
  /** The value as written, so a failure can name the transform rather than its result. */
  value: string;
}

export interface ResolvedToken extends Declaration {
  /** `#rrggbb`, or `#rrggbbaa` when the colour is not fully opaque. */
  hex: string;
}

/** True when the token is stated relative to another rather than being a source of truth. */
export function isDerived(token: ResolvedToken): boolean {
  return /var\(|color-mix\(|\bfrom\b/.test(token.value);
}

/** Reads every declaration in every stylesheet under `src`, in no particular order. */
export async function readDeclarations(): Promise<Declaration[]> {
  const declarations: Declaration[] = [];
  for await (const file of new Bun.Glob("**/*.css").scan({ cwd: SOURCE_ROOT })) {
    const stylesheet = (await Bun.file(join(SOURCE_ROOT, file)).text()).replace(/\/\*[\s\S]*?\*\//g, "");
    // Values cannot contain a semicolon or a closing brace, so splitting on them is safe
    // for the hand-written CSS in this repository. It would not survive minified input.
    for (const [, property, value] of stylesheet.matchAll(/([\w-]+)\s*:\s*([^;{}]+)[;}]/g)) {
      declarations.push({ file: file.replaceAll("\\", "/"), property: property as string, value: (value as string).trim() });
    }
  }
  return declarations;
}

/**
 * Evaluates every `--color-*` declaration under `src` to a concrete colour.
 *
 * Resolution happens here rather than in a browser because the tokens carry `color-mix()`
 * and relative colour syntax, which only a CSS colour engine can evaluate.
 * `@csstools/css-color-parser` matches Chrome to four decimal places; colorjs.io and culori
 * both reject `color-mix()` outright.
 *
 * Throws when a name is declared twice, since the winner would then depend on stylesheet
 * load order rather than on anything either file says.
 */
export async function resolvePalette(): Promise<Map<string, ResolvedToken>> {
  const tokens = (await readDeclarations()).filter(({ property }) => property.startsWith("--color-"));

  const sources = new Map<string, Declaration>();
  for (const declaration of tokens) {
    const existing = sources.get(declaration.property);
    if (existing !== undefined) {
      throw new Error(`${declaration.property} is declared in both ${existing.file} and ${declaration.file}`);
    }
    sources.set(declaration.property, declaration);
  }

  const values = new Map([...sources].map(([name, { value }]) => [name, value]));
  const resolved = new Map<string, ResolvedToken>();
  for (const [name, declaration] of sources) {
    const literal = substitute(declaration.value, values, name);
    resolved.set(name, { ...declaration, hex: toSrgbHex(literal, name) });
  }
  return resolved;
}

/** Replaces `var()` references with the referenced declaration, depth-first. */
function substitute(value: string, values: Map<string, string>, origin: string, seen: readonly string[] = []): string {
  return value.replace(/var\((--color-[a-z0-9-]+)\)/g, (whole, name: string) => {
    if (seen.includes(name)) {
      throw new Error(`${origin} reaches itself through var(${name})`);
    }
    const target = values.get(name);
    if (target === undefined) {
      throw new Error(`${origin} references ${name}, which is not declared`);
    }
    return substitute(target, values, origin, [...seen, name]);
  });
}

/** sRGB channels in the 0–1 range the colour helpers expect, plus the alpha channel. */
function toSrgb(css: string, context = css): { channels: Color; alpha: number } {
  const parsed = parseComponentValue(tokenize({ css }));
  if (parsed === undefined) {
    throw new Error(`${context} is not a parsable colour: ${css}`);
  }
  const value = parseColor(parsed);
  if (value === false) {
    throw new Error(`${context} does not resolve to a colour: ${css}`);
  }
  const parts = [...serializeRGB(value).toString().matchAll(/-?[\d.]+/g)].map((match) => Number(match[0]));
  const [red, green, blue, alpha = 1] = parts as [number, number, number, number?];
  return { channels: [red / 255, green / 255, blue / 255], alpha };
}

/**
 * Evaluates any CSS colour to `#rrggbb`, or `#rrggbbaa` when it is not fully opaque.
 * Accepts what a browser serialises as well as what a stylesheet declares, so the two can
 * be compared on the same footing.
 */
export function toSrgbHex(css: string, context = css): string {
  const { channels, alpha } = toSrgb(css, context);
  const byte = (part: number) => Math.round(Math.max(0, Math.min(255, part * 255))).toString(16).padStart(2, "0");
  const opaque = `#${channels.map(byte).join("")}`;
  return alpha >= 1 ? opaque : `${opaque}${byte(alpha)}`;
}

/** CIE Lab, the space the ramps are spaced in. */
export function toLab(css: string): Color {
  return XYZ_D50_to_Lab(sRGB_to_XYZ_D50(toSrgb(css).channels));
}

/** Perceptual distance between two colours, in the units the ramp percentages are stated in. */
export function perceptualDistance(a: string, b: string): number {
  const [first, second] = [toLab(a), toLab(b)];
  return Math.hypot(first[0] - second[0], first[1] - second[1], first[2] - second[2]);
}

/** WCAG 2.1 contrast ratio, between 1 and 21. Both colours must be opaque. */
export function contrastRatio(foreground: string, background: string): number {
  return contrast_ratio_wcag_2_1(toSrgb(foreground).channels, toSrgb(background).channels);
}
