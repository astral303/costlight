import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { findBrowser } from "../visual/support/capture-screenshot";
import { resolvePalette, toSrgbHex } from "./support/resolve-palette";

const browserPath = findBrowser();

/**
 * The offline resolver stands in for a browser everywhere else in the suite, which is only
 * safe while the two agree. This is the check that earns that trust: it evaluates every
 * token both ways and compares. Without it the resolver is an unvalidated model of CSS
 * colour maths, and `color-mix(in lab, …)` support is an assumption rather than a fact.
 */
test.if(browserPath !== null)("browser agrees with the offline resolver", async () => {
  const palette = await resolvePalette();
  const names = [...palette.keys()];
  const cssPath = join(import.meta.dir, "..", "..", "src", "app", "application.css").replaceAll("\\", "/");
  const html = `<!doctype html><html><head>
<link rel="stylesheet" href="file:///${cssPath}">
</head><body><pre id="out"></pre><script>
const probe = document.createElement("div");
document.body.appendChild(probe);
document.getElementById("out").textContent = ${JSON.stringify(names)}.map(function (n) {
  probe.style.color = "var(" + n + ")";
  return n + "=" + getComputedStyle(probe).color;
}).join("\\n");
</script></body></html>`;

  const page = join(mkdtempSync(join(tmpdir(), "palette-")), "p.html");
  writeFileSync(page, html);
  const result = spawnSync(browserPath as string, [
    "--headless=new", "--disable-gpu", "--allow-file-access-from-files",
    "--force-color-profile=srgb", "--virtual-time-budget=5000", "--dump-dom",
    `file:///${page.replaceAll("\\", "/")}`,
  ], { encoding: "utf8", timeout: 60_000 });
  const dom = result.stdout ?? "";
  expect(dom.length).toBeGreaterThan(0);

  const mismatches: string[] = [];
  let compared = 0;
  for (const name of names) {
    const reported = new RegExp(`${name}=([^\\n<]+)`).exec(dom);
    if (reported === null) {
      mismatches.push(`${name}: browser reported nothing`);
      continue;
    }
    compared++;
    const browser = toSrgbHex(reported[1]!.trim(), name);
    const offline = (palette.get(name) as { hex: string }).hex;
    if (browser.toLowerCase() !== offline.toLowerCase()) {
      mismatches.push(`${name}: browser ${browser} vs offline ${offline}`);
    }
  }
  console.log(`compared ${compared} of ${names.length} tokens; ${mismatches.length} mismatched`);
  for (const line of mismatches) console.log("  " + line);
  expect(mismatches).toEqual([]);
}, 120_000);
