# Costlight brand assets

The wordmark, beacon and icon are crops of one render, so they share a horizon and a
light direction and can be laid out as a single continuous scene.

Source render: `2048x768`, the crystal-chiselled Costlight lockup on dark water.

`costlight-water.webp` comes from a second render: an empty sea, `1672x941`, used to
carry the waterline across the full header. The dashboard header is roughly aspect 8
while these crops are roughly aspect 1.5, so laying the lockup and the beacon out at
their own proportions covers about a third of the width and strands each of them as a
rectangle in open space. No amount of edge feathering fixes that; the gap has to be
filled. Conveniently the empty-sea render falls off blue on the left and gold on the
right, which is the same direction the lockup and beacon are placed in.

## Cutting the assets

Each crop keeps the same vertical window (`y 40..718`) so the waterline lands on the
same row in every file. `-level 3%,100%` drops the render's near-black floor to true
black, which is what lets `mix-blend-mode: screen` erase the background in the header.

The wordmark and beacon crops **overlap** on `x 1010..1066`, and that is deliberate. Cut
at a single vertical line, either the water still trailing right of the final `t` or the
left reach of the beam has to be severed, because the two run past each other. Since both
are screened over black, an overlap costs nothing: the darker crop contributes no light,
so the pieces interlock instead of butting together. Averaging column brightness over the
render puts the wordmark's trailing glow and the start of the beam haze both near
`x 1024`, which is why each crop extends to roughly there.

```sh
magick "$SRC" -crop 1040x678+26+40   +repage -level 3%,100% -quality 90 -define webp:method=6 costlight-wordmark.webp
magick "$SRC" -crop 1038x678+1010+40 +repage -level 3%,100% -quality 90 -define webp:method=6 costlight-beacon.webp
magick "$SRC" -crop  220x301+80+65 +repage -level 3%,100% \
        \( -size 301x40 gradient:none-black -rotate -90 \) -geometry +180+0 -composite \
        -background black -alpha remove -alpha off -gravity center -extent 330x330 icon-square.png
magick icon-square.png -filter Lanczos -resize 256x256 -strip costlight-icon.png
```

The water fill is cut from the second render so its horizon lands at the same 46% the
scene uses, which is what makes it line up with the reflections in the other two. Its
horizon sits at `y 495`, so the crop takes 212px of sky above and 248px of water below:

```sh
magick "$SEA" -crop 1672x460+0+283 +repage -level 3%,100% -quality 88 -define webp:method=6 costlight-water.webp
```

A short crop is deliberate. The horizon's position fixes the ratio of sky to water inside
it, so the only way to reduce how far the fill has to stretch across a wide header is to
take a shallower band. At 460px tall it stretches about 2x, which ripples already
elongated by perspective absorb without looking wrong.

The icon crop is the lit content's exact bounding box, so the mark lands centred in the
square rather than drifting to one side. It stops at `x 300` because the crescent's tip
ends around `x 281` and the `o` of `ostlight` starts around `x 306`; cutting any wider
leaves a stray blue sliver that reads as a glitch once the icon is scaled down.

The transparent-to-black gradient fades the beam out before the frame edge. Without it
the beam ends on a straight vertical cut, because it is still at full brightness where
the `o` forces the crop to stop. Compositing that gradient over the art keeps colour;
multiplying by a greyscale mask instead collapses the whole image to grey.

`costlight-favicon.ico` packs 16, 32 and 48px. Each is resized and sharpened from
`icon-square.png` at its own scale rather than downsampled from one bitmap, because the
lighthouse tower is thin enough to disappear otherwise:

```sh
for S in 16 32 48; do
  magick icon-square.png -filter Lanczos -resize ${S}x${S} -unsharp 0x0.6+0.7+0.02 ico-$S.png
done
magick ico-16.png ico-32.png ico-48.png costlight-favicon.ico
```

## Numbers `dashboard.css` depends on

Re-cutting the crops means re-deriving these custom properties:

| Property | Value | Derivation |
| --- | --- | --- |
| `--costlight-scene-height` divisor | `0.46` | waterline at `y 312` of the 678px crop |
| `--costlight-wordmark-aspect` | `1.534` | `1040 / 678` |
| `--costlight-beacon-aspect` | `1.531` | `1038 / 678` |
| `--costlight-heading-ratio` | `3.11` | mark runs to `x 969`, so `(969 / 678) / 0.46` |

`--costlight-heading-ratio` sizes the `h1` box to the lit mark alone, ignoring the
reflection below it, so the heading occupies only the space the artwork appears to fill.

## Resolution headroom

The crops are 678px tall and render into a box of `--costlight-scene-height`, which
peaks at 180px once `--costlight-mark-height` hits its `83px` clamp. That is **3.77x**
native, so the header stays sharp through 3x displays.

It only runs short at 4x, where 180 CSS px would want 720 device px against the 678
available. Should the mark ever be scaled back up, the headroom falls with it: at a
`128px` clamp the scene is 278px and the margin drops to 2.44x, which is still fine at
2x but soft at 3x.

Either way the fix is a re-render of the source rather than an upscale of these files.
Re-cut it with the crop rectangles above scaled by the same factor and the CSS needs no
change.
