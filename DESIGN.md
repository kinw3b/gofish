# GoFish — design

## Theme

Follows the browser: light by default, dark via `prefers-color-scheme`. No in-app toggle; the
panel is part of the browser's chrome and should agree with it.

## Colour

Strategy: **restrained** — warm paper neutrals, one accent under 10% of the surface.

Neutrals are tinted warm (hue 70) in light, cool-deep (hue 240) in dark. No `#000`, no `#fff`.
Accent is lure vermilion `oklch(62% 0.19 41)`, which also carries the armed/recording semantic.
Ink is wet-ink dark, biased blue-green, never pure graphite.

| Role | Light | Dark |
|---|---|---|
| `--bg` | `oklch(98.6% 0.004 70)` | `oklch(19% 0.012 240)` |
| `--surface` | `oklch(96.4% 0.006 70)` | `oklch(23% 0.014 240)` |
| `--line` | `oklch(89% 0.008 70)` | `oklch(31% 0.016 240)` |
| `--ink` | `oklch(24% 0.012 230)` | `oklch(92% 0.008 80)` |
| `--ink-soft` | `oklch(52% 0.012 230)` | `oklch(68% 0.012 240)` |
| `--accent` | `oklch(62% 0.19 41)` | `oklch(70% 0.17 45)` |
| `--accent-ink` | `oklch(98% 0.012 60)` | `oklch(18% 0.03 40)` |
| `--accent-wash` | `oklch(94.5% 0.03 50)` | `oklch(28% 0.05 45)` |

## Type

System UI stack, with `ui-monospace` for selectors, paths and indices — monospace is semantic
here, not decoration. Scale: 11 / 12.5 / 17. Hierarchy carried by weight (400 / 550 / 680),
colour and case, since a 320px panel has no room for a tall scale.

## Elevation

None. Hairlines and background shifts only. No shadows except the in-page highlight, which needs
them to survive any page background.

## Motion

120ms ease-out-quart on interactive state. One looping motion only: a line travelling across the
foot of the Cast button while armed, transform-only. Fresh catches flash the accent wash and
fade. All of it off under `prefers-reduced-motion`.

## Components

Rows, not cards. The catch list is hairline-separated rows with a monospace index; a row expands
in place to reveal intent, note and actions. Nothing is boxed inside anything else.

## In-page highlight

1.5px accent outline, **no fill** — the element's real colours must read true during review —
with white hairlines inside and out so it survives both light and dark pages.
