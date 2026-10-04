# GoFish

Orca's browser **Target** tool, extracted into a Chrome/Brave side panel. Cast into the page on
your centre monitor, hook an element, and the context lands in the panel. Copy it yourself when
you want it on the clipboard for an Orca chat on the right.

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
- Each catch lands in the list. It does not touch the clipboard unless **Copy on catch** is on.
  **Esc** in the page, or **Reel in**, disarms.
- Open a catch for its screenshot, an intent (fix / change / question / approve), a note, and
  `Text` (Orca's grab format), `Markdown` (one Design Feedback block), `Image` (cropped PNG).
- **Copy all** — every catch as one `## Design Feedback` markdown block, the same thing Orca's
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

**Run as** picks the agent launcher the worker starts with. It follows the destination's own
agent until you choose one, then your choice sticks. It is separate from the destination because
inheriting that terminal's identity dispatches launchers Orca may not have enabled, and Orca
refuses those: `Agent launcher opencode is disabled or unavailable`. Which launchers are enabled
lives in Orca's settings and the CLI does not report it, so this is a pick, not a detection.

Use the refresh control on the destination row to re-resolve after you open or close an Orca
conversation. A dispatch Orca refuses is reported on the catch itself, with Orca's own wording.

When that worker finishes, the catch closes itself: a green **completed** pill, and the note,
intent, and action buttons lock. A failed worker gets a **failed** pill instead. The bridge
learns this from the task's status and does not read or acknowledge the conversation's mail.
`grok` is one of the **Run as** launchers.

### Installing the bridge

A browser extension cannot open Orca's unix runtime socket or spawn the CLI, so Send goes through
a native messaging host:

```sh
bash native/install.sh
```

It copies the host into `~/Library/Application Support/GoFish/`, writes a wrapper with absolute
paths to `node` and `orca` (Chrome gives native hosts a minimal PATH), and registers it with every
Chrome, Chromium and Brave profile on the machine. Because the host is **copied**, re-run
`install.sh` after every `git pull` that touches `native/`: the panel detects the mismatch and
says so rather than failing strangely. The host deliberately does not run from this repo: macOS gates `~/Documents`, `~/Desktop` and `~/Downloads` per application, and a browser
without that grant cannot launch a host living there. It reports this as `Native host has exited`
with the process never starting. Until it is installed, Send reports `Bridge not installed` and the copy
buttons work as before.

## Design

Context lives in `PRODUCT.md` and `DESIGN.md`. Light by default and dark with the browser, warm
paper neutrals, one vermilion accent. The in-page highlight is an outline with **no fill**, so an
element's real colours still read true while you're judging them.

## Working on it

See [HANDOFF.md](./HANDOFF.md) for the architecture, the platform traps, and what is still open.

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
