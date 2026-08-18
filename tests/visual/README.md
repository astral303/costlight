# Visual regression captures

Guards the parts of the dashboard that unit tests cannot see: stacking order, bleed of
the header artwork onto the rows below it, and the layout rules that move the wordmark
and corner beacon between widths. Two shipped bugs — the artwork painting over the
metric row, and the wordmark's reflection stopping on a straight line at the filter
row — were both invisible to `tests/dashboard/Dashboard.test.tsx` and obvious here.

```sh
bun run test:visual           # compare against the committed baselines
bun run test:visual:update    # accept the current rendering as the new baseline
```

## How a capture is produced

1. `render-dashboard-markup.tsx` renders the real `Dashboard` in happy-dom against
   frozen API responses and returns the settled markup.
2. `build-page.ts` wraps that markup in a document linking the real stylesheets from
   `src/`, so the capture exercises the shipped cascade rather than a copy of it.
3. `capture-screenshot.ts` renders the page in headless Chromium and returns a PNG.
4. `compare-to-baseline.ts` diffs it against `__baselines__/` with pixelmatch.

Chromium is driven through its `--screenshot` flag rather than an automation library
because `chromium.launch()` times out under Bun on Windows: writes to extra stdio pipes
(fd 3+) are dropped there, and Playwright carries CDP over fd 3 via
`--remote-debugging-pipe`. See [oven-sh/bun#27977][bun-issue], fixed by
[oven-sh/bun#31829][bun-fix] but not yet in a release as of Bun 1.3.14. Worth re-testing
Playwright once that ships, since it would bring element clipping and font-ready waits.

`--virtual-time-budget` gives layout, image decoding and web fonts a virtual clock to
settle on, which is what makes repeat runs identical.

[bun-issue]: https://github.com/oven-sh/bun/issues/27977
[bun-fix]: https://github.com/oven-sh/bun/pull/31829

## Keeping captures deterministic

Anything that can differ between two runs has to be pinned:

- **Charts** are replaced with a fixed-height stand-in. echarts draws to a canvas that
  happy-dom cannot provide and that would not paint identically twice.
- **The event source** reports itself open, so captures guard the connected header
  rather than the "Reconnecting" state a stub would otherwise leave behind.
- **Pricing timestamps** are built inside the current year, because `formatPricingDate`
  appends a year only for dates outside it. A fixed date would change the header text
  every January.
- **Transitions, animations and carets** are disabled by injected CSS.

The fixtures here are deliberately separate from those in
`tests/dashboard/Dashboard.test.tsx`. A baseline wants values chosen to hold still; that
test wants values chosen to exercise edge cases, such as titles long enough to overflow.

## Limits worth knowing

Baselines carry the host's font rasterisation, so they are only portable between
machines that render text identically. Expect to regenerate them on a different OS, and
treat a diff confined to glyph edges as environmental rather than a real change. The
`0.002` changed-pixel budget absorbs anti-aliasing jitter; the z-order regression above
moved roughly 30 times that.

Only the 1280px capture caught that regression, because the reflection reaches the rows
below the header at that width and not at the narrower ones. Adding a width adds
coverage; it does not duplicate it.

Failure artifacts land in `__failures__/` as `.actual.png` and `.diff.png`, and are
ignored by git.
