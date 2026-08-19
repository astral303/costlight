# Costlight palette

`application.css` holds every colour in the interface, most of them as stated steps
between a few anchors rather than as independent values. Each declaration carries its own
rationale; the sections below cover why the palette is shaped this way.

## Changing a colour

Retune an anchor and its ramp follows.

```sh
bun test tests/app     # resolve every token offline and check the palette still holds
bun run test:visual    # compare the rendered result against the committed baselines
```

The first resolves every `var()` and `color-mix()` chain to a concrete colour, then checks
that:

- every token is reachable from a stylesheet
- no two resolve to the same colour without being declared as aliases
- the literals stay perceptually apart
- neither ramp has a member pasted back as a hex literal

Resolution uses `@csstools/css-color-parser` rather than a browser, so the guards are fast
and exact. `palette-resolver.test.ts` is what earns that trust: it evaluates every token
both offline and in headless Chromium and compares. Without it the offline evaluator is an
unvalidated model of CSS colour maths, and `color-mix(in lab, …)` support is an assumption.

`tests/visual` covers the rendered result, but its captures only reach the header, filter
bar and metric row. A change that lands below that fold needs checking by eye.

## A colour is a source of truth or a step from one

Most tokens are not literals. They are stated positions between two anchors, so retuning
an anchor moves a whole ramp rather than one token, and the palette has only as many
degrees of freedom as it has genuine decisions.

A palette of independent literals has no way to make drift visible. Two colours converge
on the same value and nothing says whether that was meant; a token loses its last consumer
and nothing notices; a near-duplicate gets added because finding the existing name was
harder than picking a hex. Anchors and steps remove the room for all three.

Steps are mixed in **CIE Lab**, the space the ramps were spaced in, so a percentage reads
as the perceptual distance it travels. `50%` sits visually halfway, which is not true of
an sRGB mix.

## Ramps are ordinal, so they are numbered

Relative dimness is the only property a consumer picks a text colour on, and adjectives do
not sort. Nothing about "strong", "main" and "subtle" says which of them is brighter, so
the ordering has to be carried in someone's head and is wrong as soon as a name is added.
Numbering makes the one property that matters the one you read.

A ramp keeps a step with no consumer rather than closing the gap, because even spacing is
what lets the middle steps be stated instead of picked. The guards allow that exception
by name, so a *second* unused token is a failure rather than a precedent.

## A duplicate has to be declared

Two tokens may resolve to the same colour only when a test names the pair and says why.
The allowlist is the load-bearing part. Without it the cheapest way to give something a
name is to add a token holding a colour that already has one, and the palette grows a
synonym every time someone needs a word rather than a value.

The distance guard applies to the literals rather than every token. Those are the real
degrees of freedom, and two of them landing on one colour is always a mistake; derived
tokens are *deliberately* close to what they derive from, and their spacing is reviewable
in one place.

## The chart cannot share this palette

echarts parses colours itself, and zrender rejects everything a stylesheet hands back once
tokens carry transforms — `color-mix()`, `rgb(from …)` and `lab()` all parse as `undefined`.
Reading tokens from the DOM is not an option, so the chart keeps its own constants in
`src/dashboard/chart-palette.ts`.

Its series scale shares no meaning with the interface; a series matching the brand colour
is a coincidence of value, and tying them would move the chart whenever a status colour was
retuned. Only the chart's chrome genuinely mirrors the UI, and a test asserts the specific
pairs that have to move together.

## Why the tokens are not registered

`@property` would make `getPropertyValue` return a resolved colour instead of source text.
Nothing needs that: the chart holds its own constants and the guards resolve offline, so
registration would add a block per token and buy nothing. It becomes worthwhile if a token
needs to animate, or if degrading gracefully without `color-mix(in lab, …)` turns into a
requirement.
