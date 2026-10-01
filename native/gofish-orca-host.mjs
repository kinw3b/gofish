// GoFish native messaging host: the only thing that can reach Orca.
// Chrome extensions cannot open Orca's unix runtime socket or spawn processes,
// so this short-lived helper shells out to the `orca` CLI on their behalf.
import { execFile } from 'node:child_process'
import { appendFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const HOST_VERSION = '1.0.0'
const ORCA = process.env.GOFISH_ORCA_BIN || 'orca'
const LOG = join(homedir(), 'Library', 'Logs', 'gofish-orca-host.log')

function log(line) {
  try {
    appendFileSync(LOG, `${new Date().toISOString()} ${line}\n`)
  } catch (error) {
    // Logging is best effort; never fail a dispatch over it.
  }
}

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

// The active pane of the active tab of the active worktree: what the user is
// looking at in Orca right now.
function readActivePane(layouts) {
  const layout = Array.isArray(layouts) ? layouts[0] : null
  const root = layout?.root
  if (!root) return null
  const tab = (root.tabs ?? []).find((entry) => entry.tabId === root.activeTabId) ?? root.tabs?.[0]
  if (!tab) return null

  const leaves = []
  const walk = (node) => {
    if (!node) return
    if (node.type === 'terminal') leaves.push(node)
    for (const child of node.children ?? node.panes ?? []) walk(child)
  }
  walk(tab.panes)

  const pane =
    leaves.find((leaf) => leaf.leafId === tab.activeLeafId) ??
    leaves.find((leaf) => leaf.active) ??
    leaves[0]
  if (!pane) return null
  return { pane, tabTitle: tab.title ?? pane.title ?? '', worktreePath: layout.worktreePath }
}

async function resolveTarget() {
  const listing = await orca([
    'terminal', 'list', '--worktree', 'active', '--include-visual-layouts', '--json'
  ], 20000)
  if (!listing.ok) return { ok: false, reason: listing.reason }

  const active = readActivePane(listing.result.visualLayouts)
  if (!active) {
    return { ok: false, reason: 'No active Orca terminal. Open a conversation in Orca first.' }
  }
  const terminal = (listing.result.terminals ?? []).find(
    (entry) => entry.handle === active.pane.handle
  )
  return {
    ok: true,
    target: {
      terminalHandle: active.pane.handle,
      tabTitle: active.tabTitle.replace(/^[^\w(]+\s*/, ''),
      worktreePath: active.worktreePath ?? terminal?.worktreePath ?? '',
      worktreeName: (active.worktreePath ?? '').split('/').filter(Boolean).pop() ?? '',
      branch: (terminal?.branch ?? '').replace(/^refs\/heads\//, ''),
      agentIdentity: terminal?.agentIdentity ?? null
    }
  }
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
  const resolved = await resolveTarget()
  if (!resolved.ok) return resolved

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
      result.agentTerminalHandle ?? result.worker?.handle ?? result.terminal?.handle ?? null,
    target: resolved.target
  }
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
      return await resolveTarget()
    case 'dispatch':
      if (!message.spec) return { ok: false, reason: 'dispatch needs a spec' }
      return await dispatch(message)
    default:
      return { ok: false, reason: `unknown command ${message?.cmd}` }
  }
}

// --- native messaging framing: 4-byte little-endian length, then JSON ---

function write(payload) {
  const body = Buffer.from(JSON.stringify(payload), 'utf8')
  const header = Buffer.alloc(4)
  header.writeUInt32LE(body.length)
  process.stdout.write(Buffer.concat([header, body]))
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
        write({ id: message.id, ...(await handle(message)) })
      } catch (error) {
        log(`ERROR ${error?.stack ?? error}`)
        write({ id: message.id, ok: false, reason: String(error?.message ?? error) })
      }
    })
  }
})

process.stdin.on('end', () => process.exit(0))
