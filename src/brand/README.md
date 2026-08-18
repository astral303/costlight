# Costlight brand assets

All three files are crops of one render, so they share a horizon and a light direction
and can be laid out as a single continuous scene.

Source render: `2048x768`, the crystal-chiselled Costlight lockup on dark water.

## Cutting the assets

Each crop keeps the same vertical window (`y 40..718`) so the waterline lands on the
same row in every file. `-level 3%,100%` drops the render's near-black floor to true
black, which is what lets `mix-blend-mode: screen` erase the background in the header.

```sh
magick "$SRC" -crop 1040x678+26+40   +repage -level 3%,100% -quality 90 -define webp:method=6 costlight-wordmark.webp
magick "$SRC" -crop  528x678+1520+40 +repage -level 3%,100% -quality 90 -define webp:method=6 costlight-beacon.webp
magick "$SRC" -crop  320x340+2+40    +repage -background black -gravity center -extent 360x360 \
        -level 3%,100% -resize 256x256 -strip costlight-icon.png
```

## Numbers `dashboard.css` depends on

Re-cutting the crops means re-deriving these custom properties:

| Property | Value | Derivation |
| --- | --- | --- |
| `--costlight-scene-height` divisor | `0.46` | waterline at `y 312` of the 678px crop |
| `--costlight-wordmark-aspect` | `1.534` | `1040 / 678` |
| `--costlight-beacon-aspect` | `0.779` | `528 / 678` |
| `--costlight-heading-ratio` | `3.11` | mark runs to `x 969`, so `(969 / 678) / 0.46` |

`--costlight-heading-ratio` sizes the `h1` box to the lit mark alone, ignoring the
reflection below it, so the heading occupies only the space the artwork appears to fill.

## Resolution headroom

The crops are 678px tall and render into a box of `--costlight-scene-height`, which
peaks at 278px once `--costlight-mark-height` hits its `128px` clamp. That is **2.44x**
native, so the header stays sharp through 2x displays with room to spare.

It runs out at 3x: 278 CSS px would want 834 device px against the 678 available, about
0.81x. Nothing else is close to the limit, so a 3x-clean header needs a re-render of the
source at roughly `5120x1920` rather than an upscale of these files. Re-cut it with the
crop rectangles above scaled by the same factor and the CSS needs no change.
