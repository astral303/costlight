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

That retry can be a straight one: the fix's known limitations are confined to `cluster`,
IPC handle passing and dgram, none of which touch the raw fd 3/4 pipe writes
`--remote-debugging-pipe` relies on. Note that element clipping is not automatically the
better instrument here — the artwork painting over the metric row was a bleed across
region boundaries, which a capture clipped to the header would have missed.

`--virtual-time-budget` gives layout, image decoding and web fonts a virtual clock to
settle on, which is what makes repeat runs identical.

[bun-issue]: https://github.com/oven-sh/bun/issues/27977
[bun-fix]: https://github.com/oven-sh/bun/pull/31829

## Keeping captures deterministic

Anything that can differ between two runs has to be pinned:

- **Charts** are replaced with a fixed-height stand-in. echarts draws to a canvas that
  happy-dom cannot provide and that would not paint identically twice. Every suite that
  mocks `CostChart` must share the one `CostChartDouble`: Bun applies `mock.module`
  registrations globally, so two doubles for the same path means the winner depends on
  file order. When they disagreed on height the chart panels collapsed and pulled the
  session table into frame, which reads as a palette regression rather than a mock
  problem, and it only appeared when the whole suite ran.
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

Two separate tolerances decide whether a capture fails, and both matter. `PIXEL_TOLERANCE`
sets how different one pixel has to be before it counts at all; the `0.002` changed-pixel
budget then sets how many may count. A loose per-pixel tolerance silently disables the
budget: at the 0.12 this once used, recolouring every text element on the page registered
as zero changed pixels. Repeat captures on one machine are bit-identical, so that
tolerance only has to absorb cross-machine font rendering, and it is kept low enough to
still see a colour change of a few dE.

Baselines carry the host's font rasterisation, so they are only portable between
machines that render text identically. Expect to regenerate them on a different OS, and
treat a diff confined to glyph edges as environmental rather than a real change. The
z-order regression above moved roughly 30 times the budget.

Captures reach only a few hundred pixels down the page — enough for the header, filter
bar and metric row. The session table, badges, rate cells and footer are below every
capture and are not covered at all, so a change confined to them passes here and needs
checking by eye.

Only the 1280px capture caught that regression, because the reflection reaches the rows
below the header at that width and not at the narrower ones. Adding a width adds
coverage; it does not duplicate it.

Captures usually take about two seconds but have been seen to reach seven on a loaded
machine, which overran Bun's default five-second per-test timeout. That surfaced as a
bare failure with no diff attached, easily mistaken for a real pixel change until the
elapsed time in the report gives it away. Each capture now carries an explicit 60s
timeout.

If a failure ever reports no changed-pixel count, read the elapsed time before assuming
anything rendered differently.

Failure artifacts land in `__failures__/` as `.actual.png` and `.diff.png`, and are
ignored by git.
