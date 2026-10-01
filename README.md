# GoFish

Orca's browser **Target** tool, extracted into a Chrome/Brave side panel. Cast into the page on
your centre monitor, hook an element, and the context lands on the clipboard ready for an Orca
chat on the right.

The extractors are a direct port of `src/main/browser/grab-guest-*.ts`, and the clipboard formats
match `formatGrabPayloadAsText` and `formatBrowserAnnotationsAsMarkdown` exactly — so what you
paste is byte-identical to what Orca's own browser produces.

## Load it

1. `chrome://extensions` (or `brave://extensions`) → enable **Developer mode**
2. **Load unpacked** → select this folder
3. Pin the icon; clicking it opens the side panel

## Use it

- **Cast** — arms the picker on the active tab. Hover outlines, click hooks it, and the picker
  reels itself in after one catch. Tick **Keep casting** to stay armed for a run.
- Each catch copies the element's context as text (toggle with **Copy on catch**) and lands in
  the list. **Esc** in the page, or **Reel in**, disarms.
- Open a catch for its screenshot, an intent (fix / change / question / approve), a note, and
  `Text` (Orca's grab format), `Markdown` (one Design Feedback block), `Image` (cropped PNG).
- **Copy all** — every catch as one `## Design Feedback` markdown block, the same thing Orca's
  annotation tray sends to a chat.

## What's captured

Selector, readable + full DOM path, stable classes, React component stack and source file
(`_debugSource`, dev builds), accessibility name/role, text snippet, nearby text and siblings,
curated computed styles, bounds, and a script-stripped HTML snippet — under Orca's same budgets,
with its same secret redaction and URL sanitizing.

## Design

Context lives in `PRODUCT.md` and `DESIGN.md`. Light by default and dark with the browser, warm
paper neutrals, one vermilion accent. The in-page highlight is an outline with **no fill**, so an
element's real colours still read true while you're judging them.

## Credit

The extractors and clipboard formats are ported from [Orca](https://github.com/stablyai/orca)
(`src/main/browser/grab-guest-*.ts`, `browser-annotation-output.ts`), MIT licensed. See LICENSE.

## Notes

- Works on `http`, `https`, and `file://` pages. Chrome's own pages (`chrome://`, the Web Store)
  cannot be injected — that's a browser restriction.
- The picker runs in the page's MAIN world so React fiber expandos are visible; an isolated-world
  bridge relays messages to the panel.
- Screenshots come from `captureVisibleTab`, cropped to the element rect, so only the visible part
  of an element is captured.
