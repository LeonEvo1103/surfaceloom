# SurfaceLoom mark

Two broad interface surfaces interlace around an open center. **Surface** is the
pair of interface planes; **Loom** is their alternating over-under crossing,
which brings independent traces into one readable structure. Rounded outer ends
keep the mark calm while the two deliberate cuts make the weave legible.

The geometry began as an image-model concept selected for its woven-surface
idea, then was rebuilt and hand-refined as vector paths. The checked-in SVGs use
consistent curve tension, band width and crossing space; they contain no bitmap,
font, gradient, filter or external dependency.

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

The symbol uses deep petrol `#123640` on light surfaces and pale silver
`#e6eef0` on dark surfaces. Its weave is defined by negative space rather than
color changes. The favicon uses a darker petrol field, `#0b232b`, to keep the
silhouette distinct at small sizes. The monochrome asset inherits `currentColor`.

When the image stands alone, give its containing `<img>` the alt text
`SurfaceLoom`. When the same link already contains the visible wordmark, use
`alt=""` on the image so assistive technology reads the name only once.
An external `<img>` does not inherit CSS `color`; inline the monochrome SVG
or set its fill explicitly when a non-black monochrome asset is needed.

The resulting vector artwork is original to this project and does not depend on
an icon library or runtime image service.
