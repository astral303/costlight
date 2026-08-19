# Palette

`palette.css` holds the colours the interface is built from. Each declaration carries its
own rationale; this file covers the parts a declaration cannot.

## Changing a colour

Retune an anchor and its ramp follows.

```sh
bun test tests/palette   # resolve every token offline and check the palette still holds
bun run test:visual      # compare the rendered result against the committed baselines
```

The first resolves every `var()` and `color-mix()` chain to a concrete colour, then checks
that:

- every token is reachable from a stylesheet
- no colour literal appears outside `palette.css`
- no name is declared in two files
- declared aliases point where they say they point, and nothing else collides
- the literals stay perceptually apart
- neither ramp has a member pasted back as a hex literal
- every text colour clears 4.5:1 on the background it is used against
- `index.html`'s `theme-color` still matches `--color-page-bg`

Resolution uses `@csstools/css-color-parser` rather than a browser, so the checks are fast
and exact. `palette-resolver.test.ts` is what earns that trust: it evaluates every token
both offline and in headless Chromium and compares. Without it the offline evaluator is an
unvalidated model of CSS colour maths, and `color-mix(in lab, …)` support is an assumption.

`tests/visual` covers the rendered result, but its captures only reach the header, filter
bar and metric row. A change that lands below that fold needs checking by eye.

## Where a colour lives

A feature stylesheet is the right place for a colour only that feature uses. What it may
not do is write a literal: it states the colour against a palette token, with `color-mix()`
or `rgb(from …)` if it needs a variant. The dashboard's filter-bar scrim and beam haze are
both examples.

A colour moves into `palette.css` when it becomes a decision in its own right, or when a
second module needs it. `--text-shadow-over-artwork` is here for the second reason: two
modules place text on the header artwork, and neither can see the other.

## A colour is a source of truth or a step from one

Most tokens are not literals. They are stated positions between two anchors, so retuning an
anchor moves a whole ramp rather than one token, and the palette has only as many degrees of
freedom as it has genuine decisions.

A palette of independent literals has no way to make drift visible. Two colours converge on
one value and nothing says whether that was meant; a token loses its last consumer and
nothing notices; a near-duplicate gets added because finding the existing name was harder
than picking a hex.

Steps mix in **CIE Lab**, the space the ramps are spaced in, so a percentage reads as the
perceptual distance it travels. `50%` sits visually halfway, which is not true of an sRGB
mix.

## Ramps are ordinal, so they are numbered

Relative dimness is the only property a consumer picks a text colour on, and adjectives do
not sort. Nothing about "strong", "main" and "subtle" says which is brighter, so the order
has to be carried in someone's head and is wrong as soon as a name is added.

A ramp keeps a step with no consumer rather than closing the gap, so that step N stays
(N - 1) × 10% down the ramp. The checks allow that exception by name, so a *second* unused
token fails rather than setting a precedent.

## Contrast sets the dim end

`--color-text-11` is the darkest value on its hue that clears 4.5:1 on `--color-page-bg`,
and every brighter step follows from it. `palette.test.ts` states which background each text
colour is used against and checks the ratio there.

That table is written by hand, which is its limitation: it knows what the stylesheets do
today, not what they will do. Moving text onto a lighter surface means updating it. Reading
the pairings out of the rendered page instead would need the cascade resolved and would
still not cope with the gradients and artwork behind the header.

## A duplicate has to be declared

Two tokens may resolve to the same colour only when the test names the pair and says which
token the alias follows. Without that, the cheapest way to give something a name is to add a
token holding a colour that already has one, and the palette grows a synonym every time
someone needs a word rather than a value.

The distance check applies to the literals rather than every token. Those are the real
degrees of freedom, and two of them landing on one colour is always a mistake; derived
tokens are *deliberately* close to what they derive from.

## The chart cannot share this palette

echarts parses colours itself, and zrender rejects everything a stylesheet hands back once
tokens carry transforms — `color-mix()`, `rgb(from …)` and `lab()` all parse as `undefined`.
Reading tokens from the DOM is not an option, so the chart keeps its own constants in
`src/dashboard/chart-palette.ts`.

Its series scale shares no meaning with the interface; a series matching the brand colour is
a coincidence of value, and tying them would move the chart whenever a status colour was
retuned. Only the chart's chrome mirrors the UI, and `chart-palette.test.ts` resolves the
tokens and asserts the specific pairs that have to move together.

## Why the tokens are not registered

`@property` would make `getPropertyValue` return a resolved colour instead of source text.
Nothing needs that: the chart holds its own constants and the checks resolve offline, so
registration would add a block per token and buy nothing. It becomes worthwhile if a token
needs to animate, or if degrading gracefully without `color-mix(in lab, …)` turns into a
requirement.
