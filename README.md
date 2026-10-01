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
- **Copy all** — every catch as one `## Send to Orca

**Send** dispatches the catch as a supervised Orca worker in the worktree of the conversation you
pick, instead of pasting text at you. It binds an orchestration Run to that conversation's
terminal as coordinator and starts a worker with `worker-start`. The worker's `worker_done`
report lands back in that same conversation, so the agent you are talking to sees the result.

The destination row lists every live agent terminal, most recently active first, and remembers
your choice. It is a picker rather than a guess on purpose: Orca's `active` worktree selector
means "the worktree containing the current directory", and this bridge runs with no meaningful
working directory, so there is no focused conversation for it to detect.

The task spec follows Orca's task-spec contract (Target, Change, Constraints, Ownership,
Observable acceptance) and carries the Design Feedback markdown underneath as evidence. An
`approve` catch dispatches nothing; there is no work in it.

The header row shows exactly where a Send will go: worktree, conversation, agent. Click it to
re-resolve. It follows your active Orca tab, so check it before sending a stack.

### Installing the bridge

A browser extension cannot open Orca's unix runtime socket or spawn the CLI, so Send goes through
a native messaging host:

```sh
bash native/install.sh
```

It copies the host into `~/Library/Application Support/GoFish/`, writes a wrapper with absolute
paths to `node` and `orca` (Chrome gives native hosts a minimal PATH), and registers it with every
Chrome, Chromium and Brave profile on the machine. The host deliberately does not run from this
repo: macOS gates `~/Documents`, `~/Desktop` and `~/Downloads` per application, and a browser
without that grant cannot launch a host living there. It reports this as `Native host has exited`
with the process never starting. Until it is installed, Send reports `Bridge not installed` and the copy
buttons work as before.

## Design Feedback` markdown block, the same thing Orca's
  annotation tray sends to a chat.

## What's captured

Selector, readable + full DOM path, stable classes, React component stack and source file
(`_debugSource`, dev builds), accessibility name/role, text snippet, nearby text and siblings,
curated computed styles, bounds, and a script-stripped HTML snippet — under Orca's same budgets,
with its same secret redaction and URL sanitizing.

## Send to Orca

**Send** dispatches the catch as a supervised Orca worker in the worktree of the conversation you
pick, instead of pasting text at you. It binds an orchestration Run to that conversation's
terminal as coordinator and starts a worker with `worker-start`. The worker's `worker_done`
report lands back in that same conversation, so the agent you are talking to sees the result.

The destination row lists every live agent terminal, most recently active first, and remembers
your choice. It is a picker rather than a guess on purpose: Orca's `active` worktree selector
means "the worktree containing the current directory", and this bridge runs with no meaningful
working directory, so there is no focused conversation for it to detect.

The task spec follows Orca's task-spec contract (Target, Change, Constraints, Ownership,
Observable acceptance) and carries the Design Feedback markdown underneath as evidence. An
`approve` catch dispatches nothing; there is no work in it.

The header row shows exactly where a Send will go: worktree, conversation, agent. Click it to
re-resolve. It follows your active Orca tab, so check it before sending a stack.

### Installing the bridge

A browser extension cannot open Orca's unix runtime socket or spawn the CLI, so Send goes through
a native messaging host:

```sh
bash native/install.sh
```

It copies the host into `~/Library/Application Support/GoFish/`, writes a wrapper with absolute
paths to `node` and `orca` (Chrome gives native hosts a minimal PATH), and registers it with every
Chrome, Chromium and Brave profile on the machine. The host deliberately does not run from this
repo: macOS gates `~/Documents`, `~/Desktop` and `~/Downloads` per application, and a browser
without that grant cannot launch a host living there. It reports this as `Native host has exited`
with the process never starting. Until it is installed, Send reports `Bridge not installed` and the copy
buttons work as before.

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
