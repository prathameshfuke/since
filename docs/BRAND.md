# Brand

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="assets/wordmark-dark.svg">
  <img src="assets/wordmark-light.svg" alt="since" height="64">
</picture>

## The mark

A ring, a line and a dot. The ring is **what you asked earlier**, the dot is **now**, and the line between them is the time that passed: *since*. It sits on the same saffron-to-periwinkle wash as the app, so the logo and the interface read as one thing. `public/mark.svg` is the single source; the favicon, sidebar, hero and status line all use it.

## Palette

| Token | Light | Dark | Use |
|---|---|---|---|
| Page | `#FAFAFC` | `#0E0F16` | Background |
| Ink | `#1A1A1F` | `#ECEDF4` | Text, primary controls |
| Soft ink | `#686A78` | `#9A9CAD` | Secondary text (4.6:1 or better on every surface) |
| Hairline | `#E6E7EE` | `#23242F` | Borders instead of shadows |
| Saffron | `#F97316` | same, softer | The wash and the logo only |
| Periwinkle | `#8BA0FA` | `#6366F1`, softer | The wash and the logo only |
| Tide | `#0A7566` | `#46D1BD` | *Still current* |
| Flare | `#B5194F` | `#FF7AA3` | *Changed* |
| Straw | `#8A6700` | `#F0C84A` | *Couldn't confirm* |

The three signal colours are reserved for claim status. Nothing else in the interface is tinted.

## Type

| Role | Font | Why |
|---|---|---|
| Display | Newsreader (light, high contrast) | A calm editorial serif for the headline and panel titles |
| Reading and UI | Instrument Sans | An open grotesque that stays legible at small sizes |
| Figures, dates, status | DM Mono | Numbers line up, and it marks "this is data" |

All three are free on Google Fonts. They stand in for a commercial display serif and grotesque that a reference design used; the fonts are two CSS variables (`--serif`, `--ui`) if you license others.

## Surface and motion

- **Flat.** Hairline borders, no shadows, no gloss. Soft grey bubbles for your messages.
- **Grain.** A fixed film-grain layer sits over the page (about 7% in light, 9% in dark) so the wash and the greys feel printed, not digital.
- **Motion with a reason.** One entrance on the empty screen, a shimmer while Since works, a reveal when the ledger fills, and small state changes in controls. Everything respects `prefers-reduced-motion`.

## Assets

| File | Use |
|---|---|
| `docs/assets/banner-light.svg`, `banner-dark.svg` | README banner (SVG with outlined text, PNG alongside) |
| `docs/assets/social-preview.png` | 1280×640. Upload under *Settings, Social preview* on GitHub |
| `docs/assets/architecture-*.svg`, `user-flow-*.svg` | Diagrams used in the README, DESIGN and docs |
| `docs/assets/wordmark-*.svg` | Logo with the "since" wordmark |

Regenerate everything with `node scripts/build-assets.mjs` after `npm i --no-save fontkit @fontsource/newsreader @fontsource/instrument-sans @fontsource/dm-mono @resvg/resvg-js`.
