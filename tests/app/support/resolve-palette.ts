import { color as parseColor, serializeRGB } from "@csstools/css-color-parser";
import { parseComponentValue } from "@csstools/css-parser-algorithms";
import { tokenize } from "@csstools/css-tokenizer";
import { join } from "node:path";

const APPLICATION_CSS = join(import.meta.dir, "..", "..", "..", "src", "app", "application.css");

export interface ResolvedToken {
  /** `#rrggbb`, or `#rrggbbaa` when the colour is not fully opaque. */
  hex: string;
  /** The declaration as written, so failures can name the transform rather than its result. */
  source: string;
}

/** True when the token is stated relative to another rather than being a source of truth. */
export function isDerived(token: ResolvedToken): boolean {
  return /var\(|color-mix\(|\bfrom\b/.test(token.source);
}

/**
 * Reads `application.css` and evaluates every `--color-*` declaration to a concrete colour.
 *
 * Resolution happens here rather than in a browser because the tokens carry `color-mix()`
 * and relative colour syntax, which only a CSS colour engine can evaluate.
 * `@csstools/css-color-parser` matches Chrome to four decimal places; colorjs.io and culori
 * both reject `color-mix()` outright.
 */
export async function resolvePalette(): Promise<Map<string, ResolvedToken>> {
  const stylesheet = await Bun.file(APPLICATION_CSS).text();
  const declarations = new Map<string, string>();
  for (const [, name, value] of stylesheet.matchAll(/^\s*(--color-[a-z0-9-]+):\s*([^;]+);/gm)) {
    declarations.set(name as string, (value as string).trim());
  }

  const resolved = new Map<string, ResolvedToken>();
  for (const [name, source] of declarations) {
    resolved.set(name, { hex: toSrgbHex(substitute(source, declarations, name), name), source });
  }
  return resolved;
}

/** Replaces `var()` references with the referenced declaration, depth-first. */
function substitute(value: string, declarations: Map<string, string>, origin: string, seen: readonly string[] = []): string {
  return value.replace(/var\((--color-[a-z0-9-]+)\)/g, (whole, name: string) => {
    if (seen.includes(name)) {
      throw new Error(`${origin} reaches itself through var(${name})`);
    }
    const target = declarations.get(name);
    if (target === undefined) {
      throw new Error(`${origin} references ${name}, which is not declared`);
    }
    return substitute(target, declarations, origin, [...seen, name]);
  });
}

/**
 * Evaluates any CSS colour to `#rrggbb`, or `#rrggbbaa` when it is not fully opaque.
 * Accepts what a browser serialises as well as what a stylesheet declares, so the two can
 * be compared on the same footing.
 */
export function toSrgbHex(css: string, context = css): string {
  const parsed = parseComponentValue(tokenize({ css }));
  if (parsed === undefined) {
    throw new Error(`${context} is not a parsable colour: ${css}`);
  }
  const value = parseColor(parsed);
  if (value === false) {
    throw new Error(`${context} does not resolve to a colour: ${css}`);
  }
  const channels = [...serializeRGB(value).toString().matchAll(/-?[\d.]+/g)].map((match) => Number(match[0]));
  const [red, green, blue, alpha = 1] = channels as [number, number, number, number?];
  const byte = (part: number) => Math.round(Math.max(0, Math.min(255, part))).toString(16).padStart(2, "0");
  const opaque = `#${byte(red)}${byte(green)}${byte(blue)}`;
  return alpha >= 1 ? opaque : `${opaque}${byte(alpha * 255)}`;
}
