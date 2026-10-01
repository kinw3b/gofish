// GoFish native messaging host: the only thing that can reach Orca.
// Chrome extensions cannot open Orca's unix runtime socket or spawn processes,
// so this short-lived helper shells out to the `orca` CLI on their behalf.
import { execFile } from 'node:child_process'
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs'
import { randomBytes } from 'node:crypto'
import { homedir } from 'node:os'
import { join } from 'node:path'

const HOST_VERSION = '1.3.0'
// Bumped whenever a reply shape changes. install.sh copies this file out of the
// repo, so a pulled repo and an installed bridge drift apart silently otherwise.
// `watch` / `settled` are additive on protocol 2: an older host answers
// `unknown command watch` and Send keeps working.
const PROTOCOL = 2
const SETTLE_MS = Number(process.env.GOFISH_SETTLE_MS) || 5000
const ORCA = process.env.GOFISH_ORCA_BIN || 'orca'
const LOG = join(homedir(), 'Library', 'Logs', 'gofish-orca-host.log')
// Outside ~/Documents: TCC would block a browser-launched host from writing there.
const PASTES = join(homedir(), 'Library', 'Application Support', 'GoFish', 'pastes')
const IMAGE_EXT = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp' }

function log(line) {
  try {
    appendFileSync(LOG, `${new Date().toISOString()} ${line}\n`)
  } catch (error) {
    // Logging is best effort; never fail a dispatch over it.
  }
}

log(`BOOT argv=${JSON.stringify(process.argv.slice(1))} node=${process.version}`)

function orca(args, timeoutMs = 120000) {
  return new Promise((resolve) => {
    execFile(ORCA, args, { timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024 }, (error, stdout, stderr) => {
      const text = String(stdout || '')
      let parsed = null
      try {
        parsed = JSON.parse(text)
      } catch (parseError) {
        parsed = null
      }
      if (parsed && parsed.ok === true) {
        resolve({ ok: true, result: parsed.result })
        return
      }
      const reason =
        (parsed && (parsed.error?.message || parsed.error || parsed.message)) ||
        String(stderr || '').trim().split('\n').slice(-3).join(' ') ||
        (error ? error.message : 'orca returned no parsable result')
      log(`FAIL ${args[0]} ${args[1] ?? ''}: ${reason}`)
      resolve({ ok: false, reason: String(reason).slice(0, 600), raw: parsed })
    })
  })
}

// There is no "the conversation Orca is focused on" to ask for: the CLI's
// `active` worktree selector is literally path:<cwd>, and this host runs with
// cwd "/". So list every live agent terminal and let the panel choose; a guess
// here would dispatch work into whichever agent happened to print last.
function paneIsActive(layouts, handle) {
  for (const layout of layouts ?? []) {
    const root = layout.root
    const tab = (root?.tabs ?? []).find((entry) => entry.tabId === root.activeTabId)
    if (!tab) continue
    const leaves = []
    const walk = (node) => {
      if (!node) return
      if (node.type === 'terminal') leaves.push(node)
      for (const child of node.children ?? node.panes ?? []) walk(child)
    }
    walk(tab.panes)
    if (leaves.some((leaf) => leaf.handle === handle && (leaf.active || leaf.leafId === tab.activeLeafId))) {
      return true
    }
  }
  return false
}

async function listTargets() {
  const listing = await orca(['terminal', 'list', '--include-visual-layouts', '--json'], 25000)
  if (!listing.ok) return { ok: false, reason: listing.reason }

  const layouts = listing.result.visualLayouts
  const targets = (listing.result.terminals ?? [])
    .filter((entry) => entry.agentIdentity && entry.connected && entry.writable && !entry.orphaned)
    .map((entry) => ({
      terminalHandle: entry.handle,
      tabTitle: String(entry.title ?? '').replace(/^[^\w(]+\s*/, '').slice(0, 70),
      worktreePath: entry.worktreePath ?? '',
      worktreeName: (entry.worktreePath ?? '').split('/').filter(Boolean).pop() ?? '',
      branch: String(entry.branch ?? '').replace(/^refs\/heads\//, ''),
      agentIdentity: entry.agentIdentity,
      lastOutputAt: entry.lastOutputAt ?? 0,
      foreground: paneIsActive(layouts, entry.handle)
    }))
    .sort((a, b) => b.lastOutputAt - a.lastOutputAt)

  if (targets.length === 0) {
    return { ok: false, reason: 'No live agent terminal in Orca. Start one, then refresh.' }
  }
  return { ok: true, targets }
}

// A Run is bound to exactly one coordinator terminal, and the active Orca
// conversation moves. So the Run is keyed to the coordinator we just resolved:
// a cached id from another conversation is rejected by worker-start.
const RUN_PREFIX = 'GoFish:'

async function ensureRun(runId, objective, coordinatorHandle) {
  const listed = await orca(['orchestration', 'run-list', '--json'], 20000)
  if (listed.ok) {
    const runs = listed.result.runs ?? []
    const bound = runs.filter((run) => run.coordinator_handle === coordinatorHandle)
    const hinted = bound.find((run) => run.id === runId)
    const reusable = hinted ?? bound.find((run) => String(run.objective).startsWith(RUN_PREFIX))
    if (reusable) return { ok: true, runId: reusable.id, created: false }
  }
  const created = await orca([
    'orchestration', 'run-create',
    '--objective', `${RUN_PREFIX} ${objective}`.slice(0, 200),
    '--from', coordinatorHandle,
    '--json'
  ], 30000)
  if (!created.ok) return { ok: false, reason: created.reason }
  const id = created.result.run?.id ?? created.result.runId ?? created.result.id
  if (!id) return { ok: false, reason: 'run-create returned no run id' }
  return { ok: true, runId: id, created: true }
}

async function dispatch(message) {
  const listed = await listTargets()
  if (!listed.ok) return listed

  const chosen =
    listed.targets.find((entry) => entry.terminalHandle === message.terminalHandle) ??
    (message.terminalHandle ? null : listed.targets[0])
  if (!chosen) {
    return { ok: false, reason: 'That Orca conversation is gone. Pick another destination.' }
  }
  const resolved = { ok: true, target: chosen }

  const run = await ensureRun(
    message.runId,
    message.objective || 'GoFish design feedback',
    resolved.target.terminalHandle
  )
  if (!run.ok) return { ok: false, reason: run.reason, target: resolved.target }

  const agent = message.agent || resolved.target.agentIdentity || 'claude'
  const args = [
    'orchestration', 'worker-start',
    '--run', run.runId,
    '--from', resolved.target.terminalHandle,
    '--spec', message.spec,
    '--worktree', `path:${resolved.target.worktreePath}`,
    '--agent', agent,
    '--json'
  ]
  if (message.title) args.splice(args.length - 1, 0, '--task-title', message.title)

  const started = await orca(args, 180000)
  if (!started.ok) {
    return { ok: false, reason: started.reason, runId: run.runId, target: resolved.target }
  }
  const result = started.result
  return {
    ok: true,
    runId: run.runId,
    agent,
    taskId: result.task?.id ?? result.taskId ?? null,
    dispatchId: result.dispatch?.id ?? result.dispatchId ?? null,
    workerHandle:
      result.agentTerminalHandle ??
      result.worker?.agentTerminalHandle ??
      result.dispatch?.agentTerminalHandle ??
      result.worker?.handle ??
      result.terminal?.handle ??
      null,
    target: resolved.target
  }
}

// Completion is a push the panel cannot get from sendNativeMessage, which
// closes stdin before a later result exists. `watch` keeps this process alive
// on a connectNative port and polls task status. `check` is deliberately not
// used: it would consume the coordinator's inbox.
const watches = new Map()
let watchTimer = null
let pollFlight = null
let stopping = false

function armWatch(runId, taskIds) {
  if (stopping || typeof runId !== 'string' || runId.length === 0) return
  let ids = watches.get(runId)
  if (!ids) {
    ids = new Set()
    watches.set(runId, ids)
  }
  for (const id of taskIds ?? []) {
    if (typeof id === 'string' && id.length > 0) ids.add(id)
  }
  if (watchTimer || stopping) return
  void pollWatch()
  watchTimer = setInterval(() => void pollWatch(), SETTLE_MS)
}

function stopWatch() {
  if (watchTimer) clearInterval(watchTimer)
  watchTimer = null
}

function pollWatch() {
  if (stopping || pollFlight) return
  pollFlight = runPoll().finally(() => {
    pollFlight = null
  })
}

async function runPoll() {
  for (const [runId, ids] of watches) {
    if (stopping) return
    if (ids.size === 0) {
      watches.delete(runId)
      continue
    }
    const listed = await orca(
      ['orchestration', 'task-list', '--run', runId, '--brief', '--json'],
      20000
    )
    if (!listed.ok || stopping) continue
    for (const task of listed.result?.tasks ?? []) {
      if (!ids.has(task.id)) continue
      if (task.status !== 'completed' && task.status !== 'failed') continue
      ids.delete(task.id)
      log(`SETTLED ${task.id} ${task.status}`)
      write({ cmd: 'settled', protocol: PROTOCOL, ok: true, taskId: task.id, status: task.status })
    }
  }
  if ([...watches.values()].every((ids) => ids.size === 0)) stopWatch()
}

// The panel cannot write files, so a pasted clipboard image lands here and the
// worker gets its absolute path in the note.
function saveImage(message) {
  const ext = IMAGE_EXT[message.mime]
  if (!ext || typeof message.base64 !== 'string' || message.base64.length === 0) {
    return { ok: false, reason: 'saveImage needs a png/jpeg/gif/webp image' }
  }
  mkdirSync(PASTES, { recursive: true })
  const path = join(PASTES, `paste-${Date.now()}-${randomBytes(3).toString('hex')}.${ext}`)
  writeFileSync(path, Buffer.from(message.base64, 'base64'))
  log(`PASTE ${path}`)
  return { ok: true, path }
}

async function handle(message) {
  switch (message?.cmd) {
    case 'ping': {
      const status = await orca(['status', '--json'], 15000)
      return {
        ok: status.ok,
        host: HOST_VERSION,
        appVersion: status.ok ? status.result.runtime?.appVersion ?? null : null,
        reason: status.ok ? undefined : status.reason
      }
    }
    case 'resolve':
      return await listTargets()
    case 'dispatch':
      if (!message.spec) return { ok: false, reason: 'dispatch needs a spec' }
      return await dispatch(message)
    case 'watch':
      if (!message.runId || !Array.isArray(message.taskIds) || message.taskIds.length === 0) {
        return { ok: false, reason: 'watch needs a run and task ids' }
      }
      armWatch(message.runId, message.taskIds)
      return { ok: true, watching: true }
    case 'saveImage':
      return saveImage(message)
    default:
      return { ok: false, reason: `unknown command ${message?.cmd}` }
  }
}

// --- native messaging framing: 4-byte little-endian length, then JSON ---

// One frame at a time. A status poll and a command reply can both be ready
// to write, and two overlapping stdout writes would splice the length prefix.
let writeQueue = Promise.resolve()

function write(payload) {
  const body = Buffer.from(JSON.stringify(payload), 'utf8')
  const header = Buffer.alloc(4)
  header.writeUInt32LE(body.length)
  const frame = Buffer.concat([header, body])
  writeQueue = writeQueue.then(
    () =>
      new Promise((resolve) => {
        process.stdout.write(frame, () => resolve())
      })
  )
}

let buffered = Buffer.alloc(0)
let pending = Promise.resolve()

process.stdin.on('data', (chunk) => {
  buffered = Buffer.concat([buffered, chunk])
  while (buffered.length >= 4) {
    const length = buffered.readUInt32LE(0)
    if (buffered.length < 4 + length) return
    const body = buffered.subarray(4, 4 + length)
    buffered = buffered.subarray(4 + length)
    let message = null
    try {
      message = JSON.parse(body.toString('utf8'))
    } catch (error) {
      write({ ok: false, reason: 'unparsable message' })
      continue
    }
    // Serialize: concurrent run-create calls would race into duplicate Runs.
    pending = pending.then(async () => {
      try {
        write({ id: message.id, protocol: PROTOCOL, ...(await handle(message)) })
      } catch (error) {
        log(`ERROR ${error?.stack ?? error}`)
        write({
          id: message.id,
          protocol: PROTOCOL,
          ok: false,
          reason: String(error?.message ?? error)
        })
      }
    })
  }
})

// Why: chrome.runtime.sendNativeMessage closes stdin as soon as it has written
// the request, which lands long before the orca call it triggered resolves.
// Exiting on `end` killed the reply in flight and Chrome reported "Native host
// has exited".
process.stdin.on('end', () => {
  stopping = true
  stopWatch()
  Promise.resolve(pollFlight)
    .then(() => pending)
    .then(() => writeQueue)
    .then(() => process.exit(0))
    .catch(() => process.exit(0))
})
