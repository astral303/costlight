import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";

const BROWSER_ARGS = [
  "--headless=new",
  "--disable-gpu",
  "--hide-scrollbars",
  "--force-device-scale-factor=1",
  "--force-color-profile=srgb",
  "--allow-file-access-from-files",
  "--virtual-time-budget=8000",
  "--run-all-compositor-stages-before-draw",
];

interface ComputedStyleSnapshotValueMap {
  found: boolean;
  "color": string;
  "background-color": string;
  "border-color": string;
  "outline-color": string;
  "text-shadow": string;
}

export interface ComputedStyleSnapshot {
  rootColorVariables: Record<string, string>;
  selectors: Record<string, ComputedStyleSnapshotValueMap>;
}

interface SnapshotRequest {
  browserPath: string;
  height: number;
  html: string;
  selectors: string[];
  width: number;
}

export function captureComputedStyles({
  browserPath,
  height,
  html,
  selectors,
  width,
}: SnapshotRequest): ComputedStyleSnapshot {
  const workingDirectory = mkdtempSync(join(tmpdir(), "costlight-computed-style-"));
  const pagePath = join(workingDirectory, "page.html");
  writeFileSync(pagePath, injectStyleSnapshotScript(html, selectors));

  try {
    const result = spawnSync(
      browserPath,
      [
        ...BROWSER_ARGS,
        `--window-size=${width},${height}`,
        "--dump-dom",
        `file:///${pagePath.replaceAll("\\", "/")}`,
      ],
      { encoding: "utf8", timeout: 60_000 },
    );
    if (result.status !== 0 || result.error !== undefined) {
      throw new Error(`Chromium exited with ${result.status}: ${result.stderr ?? result.error ?? ""}`);
    }

    const dom = result.stdout ?? "";
    const snapshotMatch = dom.match(
      /<script id=\"computed-style-snapshot\" type=\"application\/json\">([\s\S]*?)<\/script>/,
    );
    if (snapshotMatch === null || snapshotMatch[1] === undefined) {
      throw new Error(
        `Chromium did not emit a computed-style snapshot. stderr: ${result.stderr ?? "none"}. `
          + `stdout tail: ${dom.slice(-600)}`,
      );
    }

    return JSON.parse(snapshotMatch[1] as string) as ComputedStyleSnapshot;
  } finally {
    rmSync(workingDirectory, { force: true, recursive: true });
  }
}

function injectStyleSnapshotScript(pageMarkup: string, selectors: string[]): string {
  const encodedSelectors = JSON.stringify(selectors);
  const captureScript = `
    <script id="computed-style-selectors" type="application/json">${encodedSelectors}</script>
    <script>
      (function () {
        const pickProperties = (style) => ({
          "color": style.color,
          "background-color": style.backgroundColor,
          "border-color": style.borderColor,
          "outline-color": style.outlineColor,
          "text-shadow": style.textShadow,
        });
        const capture = () => {
          try {
            const configText = document.getElementById("computed-style-selectors")?.textContent ?? "[]";
            const selectors = JSON.parse(configText);
            const rootStyles = getComputedStyle(document.documentElement);
            const rootStyleProperties = rootStyles.getPropertyNames
              ? rootStyles.getPropertyNames()
              : Array.from({ length: rootStyles.length }, (_, index) => rootStyles[index])
                .filter(
                  (propertyName) => typeof propertyName === "string" && propertyName !== "",
                );
            const fallbackRootStyleProperties = getFallbackRootStyleProperties(document.styleSheets, document.documentElement);
            if (rootStyleProperties.length === 0 && fallbackRootStyleProperties.length > 0) {
              rootStyleProperties.push(...fallbackRootStyleProperties);
            }
            const rootColorVariables = {};
            for (const propertyName of rootStyleProperties) {
              if (propertyName.startsWith("--color-")) {
                rootColorVariables[propertyName] = rootStyles.getPropertyValue(propertyName).trim();
              }
            }

            const snapshot = {
              rootColorVariables,
              selectors: {},
            };

            for (const selector of selectors) {
              const [targetSelector, pseudoSuffix] = selector.split("::");
              const element = document.querySelector(targetSelector);
              if (element === null) {
                snapshot.selectors[selector] = {
                  found: false,
                  ...pickProperties(getComputedStyle(document.documentElement)),
                };
                continue;
              }

              const pseudoElement = pseudoSuffix === undefined ? undefined : ":" + pseudoSuffix;
              snapshot.selectors[selector] = {
                found: true,
                ...pickProperties(getComputedStyle(element, pseudoElement)),
              };
            }

            const marker = document.createElement("script");
            marker.id = "computed-style-snapshot";
            marker.type = "application/json";
            marker.textContent = JSON.stringify(snapshot);
            document.documentElement.appendChild(marker);
        } catch (error) {
            const marker = document.createElement("script");
            marker.id = "computed-style-snapshot";
            marker.type = "application/json";
            marker.textContent = JSON.stringify({
              rootColorVariables: { "__error__": String(error) },
              selectors: {},
            });
            document.documentElement.appendChild(marker);
          }
        };

        if (document.readyState === "complete") {
          setTimeout(capture, 0);
        } else {
          window.addEventListener("load", () => {
            setTimeout(capture, 0);
          });
        }

        function getFallbackRootStyleProperties(styleSheets, element) {
          const propertyNames = new Set();
          const computedStyles = getComputedStyle(element);
          for (let i = 0; i < styleSheets.length; i++) {
            const styleSheet = styleSheets[i];
            if (styleSheet === null) {
              continue;
            }
            let rules;
            try {
              rules = styleSheet.cssRules;
            } catch {
              continue;
            }
            for (let j = 0; j < rules.length; j++) {
              const rule = rules[j];
              if (rule.type !== 1) {
                continue;
              }
              const styleRule = rule;
              const selectors = (styleRule.selectorText ?? "").toLowerCase().split(",");
              const hasRootSelector = selectors.some((selector) => selector.trim() === ":root");
              if (!hasRootSelector) {
                continue;
              }
              for (let index = 0; index < styleRule.style.length; index++) {
                const propertyName = styleRule.style[index];
                if (typeof propertyName === "string" && propertyName.startsWith("--")) {
                  const value = computedStyles.getPropertyValue(propertyName).trim();
                  if (value !== "") {
                    propertyNames.add(propertyName);
                  }
                }
              }
            }
          }
          return [...propertyNames];
        }
      })();
    </script>
  `;
  return pageMarkup.replace("</body>", `${captureScript}</body>`);
}
