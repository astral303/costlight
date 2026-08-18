import { join } from "node:path";

const SOURCE_DIRECTORY = join(import.meta.dir, "..", "..", "..", "src");

/**
 * Linked in load order rather than bundled, so a capture exercises the same cascade the
 * application produces. `application.css` carries the page defaults and must come first.
 */
const STYLESHEETS = [
  "app/application.css",
  "dashboard/dashboard.css",
  "dashboard/cost-chart.css",
  "live-sync/connection-status.css",
  "provider-status/provider-status.css",
];

/** Motion and blinking carets would make otherwise identical captures differ. */
const FREEZE_STYLES = `
  *, *::before, *::after {
    transition: none !important;
    animation: none !important;
  }
  * { caret-color: transparent !important; }
`;

export function buildPage(bodyMarkup: string): string {
  const links = STYLESHEETS
    .map((relativePath) => {
      const absolute = join(SOURCE_DIRECTORY, relativePath).replaceAll("\\", "/");
      return `<link rel="stylesheet" href="file:///${absolute}" />`;
    })
    .join("\n    ");

  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="color-scheme" content="dark" />
    ${links}
    <style>${FREEZE_STYLES}</style>
  </head>
  <body>${bodyMarkup}</body>
</html>
`;
}
