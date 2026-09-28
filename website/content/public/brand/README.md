# SurfaceLoom mark

Two folded surfaces form an open **S**. Their offset center suggests threads
crossing on a loom: independent traces brought into one readable structure.
The shape is built from two flat paths; it needs no glow, shadow or animation.

## Assets

| Asset | Use |
| --- | --- |
| `../mark.svg` | Self-contained dark badge for the favicon, avatars and mixed backgrounds |
| `surfaceloom-symbol.svg` | Transparent symbol for light surfaces |
| `surfaceloom-symbol-dark.svg` | Transparent symbol for dark surfaces |
| `surfaceloom-symbol-mono.svg` | Single-color reproduction; inline SVG inherits `currentColor` |

Use the badge at 16 px or larger. Use the transparent symbol at 24 px or larger;
32 px works well beside a navigation wordmark. Preserve the square viewBox and
its built-in clear space. Do not add a stroke to the symbol or close its gaps.

The main palette is graphite `#0d1b27`, pale silver `#e5edf1`, and cool cyan
`#65bdbb`. On light surfaces, the cyan shifts to `#287b80` for stronger contrast.
The monochrome version remains recognizable without relying on color.

When the image stands alone, give its containing `<img>` the alt text
`SurfaceLoom`. When the same link already contains the visible wordmark, use
`alt=""` on the image so assistive technology reads the name only once.
An external `<img>` does not inherit CSS `color`; inline the monochrome SVG
or set its fill explicitly when a non-black monochrome asset is needed.

The symbol is original vector artwork created for this project. It does not
depend on an icon library, a font, or an external image service.
