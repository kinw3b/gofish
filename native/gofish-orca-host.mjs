// GoFish native messaging host: the only thing that can reach Orca.
// Chrome extensions cannot open Orca's unix runtime socket or spawn processes,
// so this short-lived helper shells out to the `orca` CLI on their behalf.
import { execFile, execFileSync } from 'node:child_process'
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { randomBytes } from 'node:crypto'
import { homedir } from 'node:os'
import { join } from 'node:path'

const HOST_VERSION = '1.4.0'
// Bumped whenever a reply shape changes. install.sh copies this file out of the
// repo, so a pulled repo and an installed bridge drift apart silently otherwise.
// Protocol 3 adds projectName / projectIcon / projectBadgeColor to every target
// (the panel renders the Orca project, not the worktree folder name).
// Protocol 4 adds working (true while the agent is mid-turn) to every target.
const PROTOCOL = 4
const SETTLE_MS = Number(process.env.GOFISH_SETTLE_MS) || 5000
const ORCA = process.env.GOFISH_ORCA_BIN || 'orca'
const LOG = join(homedir(), 'Library', 'Logs', 'gofish-orca-host.log')
// Outside ~/Documents: TCC would block a browser-launched host from writing there.
const PASTES = join(homedir(), 'Library', 'Application Support', 'GoFish', 'pastes')
const IMAGE_EXT = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp' }
// Ids `worker-start --agent` accepts. Orca hides the rest via settings.disabledTuiAgents.
const WORKER_AGENTS = [
  'claude',
  'codex',
  'cursor',
  'antigravity',
  'muse',
  'zcode',
  'opencode',
  'opencode2',
  'grok',
  'crush',
  'pi'
]

function log(line) {
  try {
    appendFileSync(LOG, `${new Date().toISOString()} ${line}\n`)
  } catch (error) {
    // Logging is best effort; never fail a dispatch over it.
  }
}

log(`BOOT argv=${JSON.stringify(process.argv.slice(1))} node=${process.version} host=${HOST_VERSION}`)

// A pane injects these into every child. Chrome keeps them if it was launched
// from that pane, and the native host inherits them. Orca then attests this
// CLI as that pane and refuses --from for any other conversation
// ("attested as term_A and cannot act as term_B"). GoFish is an external
// dispatcher: the panel names the coordinator with --from, so the CLI must
// not carry a pane's identity. Names only — never log the values.
const CALLER_IDENTITY_ENV = [
  'ORCA_TERMINAL_HANDLE',
  'ORCA_PANE_KEY',
  'ORCA_AGENT_LAUNCH_TOKEN',
  'ORCA_AGENT_SESSION_ID',
  'ORCA_STRUCTURED_SESSION',
  'ORCA_AGENT_PANE',
  'ORCA_AGENT_LAUNCH',
  'ORCA_ORCHESTRATION_COMPATIBILITY_HOST_KIND',
  'ORCA_ORCHESTRATION_COMPATIBILITY_HOST_ID',
  'ORCA_ORCHESTRATION_COMPATIBILITY_HOST_INCARNATION',
  'ORCA_ORCHESTRATION_COMPATIBILITY_ATTACHMENT'
]

function callerEnv() {
  const env = { ...process.env }
  for (const key of CALLER_IDENTITY_ENV) delete env[key]
  return env
}

const inheritedIdentity = CALLER_IDENTITY_ENV.filter((key) => process.env[key])
if (inheritedIdentity.length > 0) {
  log(`not forwarding caller identity: ${inheritedIdentity.join(',')}`)
}

function orca(args, timeoutMs = 120000, quiet = false) {
  return new Promise((resolve) => {
    execFile(
      ORCA,
      args,
      { timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024, env: callerEnv() },
      (error, stdout, stderr) => {
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
        if (!quiet) log(`FAIL ${args[0]} ${args[1] ?? ''}: ${reason}`)
        resolve({ ok: false, reason: String(reason).slice(0, 600), raw: parsed })
      })
  })
}

// There is no "the conversation Orca is focused on" to ask for: the CLI's
// `active` worktree selector is literally path:<cwd>, and this host runs with
// cwd "/". So list every live agent terminal and let the panel choose; a guess
// here would dispatch work into whichever agent happened to print last.
// `terminal.title` is the agent prompt, which keeps moving. The name on the
// Orca tab is in the visual layout and is what a refresh should show.
function tabTitleByHandle(layouts) {
  const titles = new Map()
  const walkPanes = (node, tabTitle) => {
    if (!node) return
    if (node.type === 'pane-split') {
      walkPanes(node.first, tabTitle)
      walkPanes(node.second, tabTitle)
      return
    }
    if (node.handle) titles.set(node.handle, tabTitle || node.title || '')
  }
  const walk = (node) => {
    if (!node) return
    if (node.type === 'split') {
      walk(node.first)
      walk(node.second)
      return
    }
    for (const tab of node.tabs ?? []) walkPanes(tab.panes, tab.title)
  }
  for (const layout of layouts ?? []) walk(layout.root)
  return titles
}

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

// Orca's live settings live in profile-state.db (the `settings` document row).
// orca-data.json is only a legacy export that Orca stops refreshing, so reading
// it reports agents as disabled when they are enabled. Read the DB first.
function disabledAgentsFromSettings(settings) {
  return new Set((settings?.disabledTuiAgents ?? []).filter((id) => typeof id === 'string'))
}

function readLiveSettings(profileDir) {
  const dbPath = join(profileDir, 'profile-state.db')
  const out = execFileSync(
    'sqlite3',
    ['-readonly', dbPath, "select payload from profile_state_documents where domain = 'settings'"],
    { encoding: 'utf8', timeout: 3000 }
  ).trim()
  if (!out) throw new Error('no settings row in profile-state.db')
  return JSON.parse(out)
}

function enabledWorkerAgents() {
  const support = join(homedir(), 'Library', 'Application Support', 'orca')
  let profileId = 'local-default'
  try {
    const index = JSON.parse(readFileSync(join(support, 'orca-profile-index.json'), 'utf8'))
    profileId = index.activeProfileId || profileId
  } catch (error) {
    log(`agents: profile index: ${error?.message ?? error}`)
  }
  const profileDir = join(support, 'profiles', profileId)

  let settings = null
  try {
    settings = readLiveSettings(profileDir)
  } catch (error) {
    log(`agents: live settings unreadable, falling back to orca-data.json: ${error?.message ?? error}`)
    try {
      settings = JSON.parse(readFileSync(join(profileDir, 'orca-data.json'), 'utf8')).settings
    } catch (fallbackError) {
      log(`agents: ${fallbackError?.message ?? fallbackError}`)
      return WORKER_AGENTS
    }
  }

  const disabled = disabledAgentsFromSettings(settings)
  const enabled = WORKER_AGENTS.filter((id) => !disabled.has(id))
  return enabled.length > 0 ? enabled : WORKER_AGENTS
}

// A terminal carries the repo id inside its worktreeId (`<repoId>::<path>`),
// but not the project's display name or icon. `repo list` has both, keyed by
// that same id. The icon is a data URI (image), a lucide name, or an emoji, so
// the panel can tell two checkouts of the same folder apart at a glance.
async function repoMetadata() {
  const listed = await orca(['repo', 'list', '--json'], 20000)
  const byId = new Map()
  const byPath = new Map()
  if (!listed.ok) {
    log(`repos: ${listed.reason}`)
    return { byId, byPath }
  }
  for (const repo of listed.result.repos ?? []) {
    const meta = {
      projectName: String(repo.displayName ?? '').trim(),
      projectIcon: repo.repoIcon ?? null,
      projectBadgeColor: typeof repo.badgeColor === 'string' ? repo.badgeColor : null
    }
    if (repo.id) byId.set(String(repo.id), meta)
    if (repo.path) byPath.set(String(repo.path), meta)
  }
  return { byId, byPath }
}

// `terminal list` carries no task state. `tui-idle` is satisfied while the agent
// sits at its prompt, so a timeout means it is still mid-turn. A failed probe
// counts as working, which is the safer guess for a button that sends work.
async function agentIsIdle(handle) {
  const waited = await orca(
    ['terminal', 'wait', '--terminal', handle, '--for', 'tui-idle', '--timeout-ms', '400', '--json'],
    8000,
    true
  )
  return waited.ok && waited.result?.wait?.satisfied === true
}

async function listTargets() {
  const listing = await orca(['terminal', 'list', '--include-visual-layouts', '--json'], 25000)
  if (!listing.ok) return { ok: false, reason: listing.reason }

  const repos = await repoMetadata()
  const layouts = listing.result.visualLayouts
  const tabTitles = tabTitleByHandle(layouts)
  const targets = (listing.result.terminals ?? [])
    .filter((entry) => entry.agentIdentity && entry.connected && entry.writable && !entry.orphaned)
    .map((entry) => {
      const repoId = String(entry.worktreeId ?? '').split('::')[0]
      const repo = repos.byId.get(repoId) ?? repos.byPath.get(entry.worktreePath) ?? null
      const worktreeName = (entry.worktreePath ?? '').split('/').filter(Boolean).pop() ?? ''
      return {
        terminalHandle: entry.handle,
        tabTitle: String(tabTitles.get(entry.handle) || entry.title || '')
          .replace(/^[^\w(]+\s*/, '')
          .slice(0, 70),
        worktreePath: entry.worktreePath ?? '',
        worktreeName,
        projectName: repo?.projectName || worktreeName,
        projectIcon: repo?.projectIcon ?? null,
        projectBadgeColor: repo?.projectBadgeColor ?? null,
        branch: String(entry.branch ?? '').replace(/^refs\/heads\//, ''),
        agentIdentity: entry.agentIdentity,
        lastOutputAt: entry.lastOutputAt ?? 0,
        foreground: paneIsActive(layouts, entry.handle)
      }
    })
    .sort((a, b) => b.lastOutputAt - a.lastOutputAt)

  const idle = await Promise.all(targets.map((target) => agentIsIdle(target.terminalHandle)))
  targets.forEach((target, i) => {
    target.working = !idle[i]
  })

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
// used: it would consume the coordinator's inbox. When a task settles, the
// host releases that worker's terminal itself. Otherwise the pane stays
// reclaimable until someone runs worker-release in the coordinator.
const watches = new Map()
let watchTimer = null
let pollFlight = null
let stopping = false

function armWatch(runId, taskIds, dispatches) {
  if (stopping || typeof runId !== 'string' || runId.length === 0) return
  let ids = watches.get(runId)
  if (!ids) {
    ids = new Map()
    watches.set(runId, ids)
  }
  for (const id of taskIds ?? []) {
    if (typeof id === 'string' && id.length > 0 && !ids.has(id)) ids.set(id, null)
  }
  for (const entry of dispatches ?? []) {
    const taskId = entry?.taskId
    const dispatchId = entry?.dispatchId
    if (typeof taskId !== 'string' || taskId.length === 0) continue
    if (typeof dispatchId === 'string' && dispatchId.length > 0) ids.set(taskId, dispatchId)
    else if (!ids.has(taskId)) ids.set(taskId, null)
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

function asId(value) {
  return typeof value === 'string' && value.length > 0 ? value : null
}

// worker-list pages at 100. Walk until the task's dispatch shows up or the
// cursor runs out. A missing id is not fatal: settle still reports.
async function dispatchIdForTask(runId, taskId) {
  let cursor = null
  for (let page = 0; page < 10; page += 1) {
    const args = ['orchestration', 'worker-list', '--run', runId, '--limit', '100', '--json']
    if (cursor) args.push('--cursor', cursor)
    const listed = await orca(args, 20000)
    if (!listed.ok) return null
    const body = listed.result ?? {}
    const rows = body.workers ?? body.dispatches ?? body.rows ?? body.items ?? []
    for (const row of rows) {
      const rowTask = asId(row.taskId) ?? asId(row.task_id) ?? asId(row.task?.id)
      if (rowTask !== taskId) continue
      const found =
        asId(row.dispatchId) ??
        asId(row.dispatch_id) ??
        asId(row.id) ??
        asId(row.dispatch?.id)
      if (found) return found
    }
    cursor = asId(body.page?.nextCursor) ?? asId(body.nextCursor)
    if (!cursor) return null
  }
  return null
}

async function releaseWorker(runId, taskId, knownDispatchId) {
  const dispatchId = asId(knownDispatchId) ?? (await dispatchIdForTask(runId, taskId))
  if (!dispatchId) {
    log(`RELEASE skip ${taskId}: no dispatch id`)
    return
  }
  const released = await orca(
    ['orchestration', 'worker-release', '--dispatch', dispatchId, '--json'],
    30000
  )
  if (!released.ok) {
    log(`RELEASE failed ${taskId} ${dispatchId}: ${released.reason}`)
    return
  }
  const outcome =
    released.result?.outcome ??
    released.result?.terminalState ??
    released.result?.status ??
    'ok'
  log(`RELEASE ${taskId} ${dispatchId} ${outcome}`)
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
      const dispatchId = ids.get(task.id)
      ids.delete(task.id)
      log(`SETTLED ${task.id} ${task.status}`)
      await releaseWorker(runId, task.id, dispatchId)
      if (stopping) return
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
    case 'resolve': {
      const listed = await listTargets()
      return { ...listed, agents: enabledWorkerAgents() }
    }
    case 'dispatch':
      if (!message.spec) return { ok: false, reason: 'dispatch needs a spec' }
      return await dispatch(message)
    case 'watch': {
      const dispatches = Array.isArray(message.dispatches) ? message.dispatches : []
      const taskIds = Array.isArray(message.taskIds) ? message.taskIds : []
      if (!message.runId || (taskIds.length === 0 && dispatches.length === 0)) {
        return { ok: false, reason: 'watch needs a run and task ids' }
      }
      armWatch(message.runId, taskIds, dispatches)
      return { ok: true, watching: true }
    }
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
