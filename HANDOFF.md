# Handoff

Working state as of 2026-10-01. README covers what GoFish *is* and how to use it; this covers
what you need to know to keep building it.

## Where things are

| File | Does |
| --- | --- |
| `content/target-picker.js` | The picker. Runs in the page's **MAIN world**. Ported from Orca's `src/main/browser/grab-guest-*.ts`. |
| `content/target-bridge.js` | Isolated-world relay. Passes runtime messages to the picker over `window.postMessage`. |
| `content/target-format.js` | `formatGrabPayloadAsText` / `formatAnnotationsAsMarkdown`, byte-identical to Orca's. |
| `orca-task-spec.js` | Builds the orchestration Task spec from a catch. IIFE-wrapped; exports `globalThis.OrcaTaskSpec`. |
| `sidepanel.{html,css,js}` | The panel. |
| `native/gofish-orca-host.mjs` | Native messaging host. Shells out to the `orca` CLI. `ping` / `resolve` / `dispatch`. |
| `native/install.sh` | Copies the host out of this repo and registers it with every Chrome/Chromium/Brave profile. |

## Non-obvious things that will bite you

**The picker must run in MAIN.** React fiber expandos (`__reactFiber$…`) are invisible from an
isolated world, so the component stack and `_debugSource` would come back empty. That is the whole
reason for the two-script bridge.

**The panel's `<script>`s are classic scripts sharing one global scope.** `orca-task-spec.js` and
`sidepanel.js` both once declared `describeTarget`, and the panel's version silently won, which
corrupted the Target line of every dispatched spec. Wrap any new panel module in an IIFE.

**The host cannot live under `~/Documents`.** macOS TCC gates `~/Documents`, `~/Desktop` and
`~/Downloads` per application. A browser without that grant cannot execute a host there, and
Chrome reports it as `Native host has exited` with the process never starting. `install.sh` copies
the host to `~/Library/Application Support/GoFish/` for this reason. Consequence: **re-run
`install.sh` after any pull touching `native/`.** `PROTOCOL` in the host and the panel must match;
on a mismatch the panel says the bridge is out of date.

**`sendNativeMessage` closes stdin immediately.** The host must not exit on stdin `end` while a
reply is in flight — it awaits `pending` first.

**Chrome spawns the host with cwd `/` and a minimal PATH.** So `--worktree active` is useless
(`active` == `current` == `path:<cwd>`, see `src/cli/selectors.ts:normalizeWorktreeSelector` in
Orca — it is *not* UI focus), and `node`/`orca` must be absolute. Both are handled: the panel picks
the destination explicitly and `install.sh` bakes absolute paths into the wrapper.

**A Run binds to exactly one coordinator terminal.** `ensureRun` in the host reuses a Run only when
its `coordinator_handle` matches the resolved destination; otherwise it creates one. Changing the
destination mid-stack creates a second Run, which is correct.

**Which agent launchers are enabled is not discoverable from the CLI.** It lives in Orca's settings.
`AGENTS` in `sidepanel.js` is the static list from `worker-start --help`; the user picks.

**Nothing drains the coordinator inbox.** After a batch, the agent in the destination conversation
should run `orca orchestration check --ack` and `worker-release`. Workers otherwise pile up as
reclaimable.

## Testing the layout without the browser

Playwright needs `channel: 'chromium'`; the bundled headless build does not load extensions. For
pure layout checks it is easier to render a static copy of `sidepanel.html` with the scripts
stripped and the `<select>`s pre-populated, then assert `scrollWidth === clientWidth` at 420 / 320 /
260 / 220px. That is how the narrow-panel overflow was caught: the destination `<select>` sizes
itself to its widest option, and the header's auto-sized grid column could not shrink below it, so
the refresh button fell outside the panel. Fixed with `grid-template-columns: minmax(0, 1fr)`.

## Open / possible next

- `chrome.tabs.onActivated` in `sidepanel.js` re-runs the whole init block (including a
  `resolve` round trip) on every tab switch. It works, but it is a duplicated block with broken
  indentation and it spawns a host process per tab switch. Worth collapsing into one `init()`.
- An inert empty Run `run_496c35efe758` was left behind by an early failed attempt. Harmless.
- `install.sh` is macOS only. Linux native-messaging manifest dirs differ
  (`~/.config/google-chrome/NativeMessagingHosts`); Windows needs a registry key.
- The host's `listTargets` filters to `agentIdentity && connected && writable && !orphaned`, which
  hides plain shell terminals. That is deliberate, but it also means a worktree with no agent
  running cannot be a destination.
- Screenshots come from `captureVisibleTab`, so only the on-screen part of a tall element is
  captured. Scroll-and-stitch would fix it.
