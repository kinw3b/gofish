'use strict'

// Fallback until the bridge reports the agents Orca has enabled. The installed
// host reads settings.disabledTuiAgents and returns that list on resolve.
const AGENTS = [
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

const INTENTS = ['fix', 'change', 'question', 'approve']
const HOST = 'com.gofish.orca'
const PROTOCOL = 3

let destination = null
let destinationTargets = []
let runId = null
// Long-lived port: sendNativeMessage cannot push, so completion arrives here.
let watchPort = null
let watchGaveUp = false
let watchAttempts = 0

const captureNodes = new Map()

function nodeFor(capture) {
  return captureNodes.get(capture) ?? null
}

const captures = []
let armedTabId = null
let nextId = 1

const castButton = document.getElementById('cast')
const copyAllButton = document.getElementById('copy-all')
const clearButton = document.getElementById('clear')
const autoCopyInput = document.getElementById('auto-copy')
const keepPickingInput = document.getElementById('keep-picking')
const statusEl = document.getElementById('status')
const pageEl = document.getElementById('page')
const listEl = document.getElementById('list')
const emptyEl = document.getElementById('empty')
const template = document.getElementById('capture-template')
const destinationRow = document.querySelector('.destination')
const destinationSelect = document.getElementById('destination')
const destinationList = document.getElementById('destination-list')
const destinationValue = destinationSelect.querySelector('.destination-value')
const destinationText = destinationRow.querySelector('.destination-text')
const destinationRefresh = document.getElementById('destination-refresh')
const agentSelect = document.getElementById('agent')
const agentPicker = document.querySelector('.agent-picker')
const agentButton = document.getElementById('agent-button')
const agentValue = agentButton.querySelector('.agent-value')
const agentList = document.getElementById('agent-list')
const SVG_NS = 'http://www.w3.org/2000/svg'
const sendAllButton = document.getElementById('send-all')
const deviceButtons = [...document.querySelectorAll('.device')]

// Emulated viewports, driven through the debugger's CDP so media queries and
// every element (menus included) respond. desktop is the native window: no
// override, no debugger.
const DEVICE_SPECS = {
  tablet: { width: 834, height: 1112, deviceScaleFactor: 2, mobile: true },
  mobile: { width: 390, height: 844, deviceScaleFactor: 3, mobile: true }
}

const devices = new Map() // tabId -> device id
const attachedTabs = new Set()

function setStatus(text, tone) {
  statusEl.textContent = text
  if (tone) statusEl.dataset.tone = tone
  else delete statusEl.dataset.tone
}

function setArmed(tabId) {
  armedTabId = tabId
  castButton.dataset.armed = tabId === null ? 'false' : 'true'
  castButton.querySelector('.cast-label').textContent = tabId === null ? 'Cast Target' : 'Reel in (Esc)'
}

function showHost(url) {
  if (!url) {
    pageEl.textContent = ''
    return
  }
  try {
    const parsed = new URL(url)
    pageEl.textContent = parsed.host + (parsed.pathname === '/' ? '' : parsed.pathname)
  } catch (error) {
    pageEl.textContent = url
  }
}

// The native host is the only thing that can reach Orca: an extension can
// neither open Orca's unix runtime socket nor spawn the CLI.
async function callHost(message) {
  try {
    const reply = await chrome.runtime.sendNativeMessage(HOST, message)
    if (!reply) return { ok: false, reason: 'empty reply from the bridge' }
    // install.sh copies the host out of the repo, so pulling the repo leaves an
    // older bridge installed. Say that instead of failing on a changed shape.
    if (reply.protocol !== PROTOCOL) {
      return { ok: false, reason: 'Bridge is out of date: run native/install.sh again' }
    }
    return reply
  } catch (error) {
    return { ok: false, reason: 'bridge-missing', detail: String(error?.message ?? error) }
  }
}

// Chrome's three native-messaging failures need three different fixes, so say
// which one happened instead of collapsing them into "not installed".
function describeBridgeFailure(reply) {
  if (reply.reason !== 'bridge-missing') return reply.reason
  const detail = reply.detail ?? ''
  if (/not found/i.test(detail)) return 'Bridge not registered: run native/install.sh'
  if (/forbidden/i.test(detail)) return `Host manifest rejects id ${chrome.runtime.id}`
  if (/exited|closed/i.test(detail)) return 'Bridge crashed: see ~/Library/Logs/gofish-orca-host.log'
  return detail || 'Bridge unavailable'
}

function openWatches() {
  return captures.filter(
    (capture) => capture.sent?.taskId && capture.sent.runId && !capture.sent.settled && !capture.done
  )
}

function ensureWatchPort() {
  if (watchPort || watchGaveUp) return watchPort
  try {
    watchPort = chrome.runtime.connectNative(HOST)
  } catch (error) {
    watchGaveUp = true
    stopWorking()
    setStatus('Completion watch unavailable')
    return null
  }
  watchPort.onMessage.addListener((reply) => {
    if (!reply || reply.protocol !== PROTOCOL) {
      giveUpWatch('Bridge is out of date: run native/install.sh again')
      return
    }
    if (reply.cmd === 'settled' && reply.taskId) {
      watchAttempts = 0
      showLanded(reply.taskId, reply.status)
      return
    }
    if (reply.ok === false && /unknown command/.test(reply.reason ?? '')) {
      giveUpWatch('Bridge is out of date: run native/install.sh again')
      return
    }
    if (reply.ok === true) watchAttempts = 0
  })
  watchPort.onDisconnect.addListener(() => {
    watchPort = null
    if (watchGaveUp || openWatches().length === 0) return
    if (watchAttempts >= 3) {
      giveUpWatch('Completion watch dropped. See ~/Library/Logs/gofish-orca-host.log')
      return
    }
    watchAttempts += 1
    setTimeout(() => postWatch(), 1500)
  })
  return watchPort
}

function giveUpWatch(text) {
  if (watchGaveUp) return
  watchGaveUp = true
  stopWorking()
  const port = watchPort
  watchPort = null
  try {
    port?.disconnect()
  } catch (error) {
    // The port is already gone when this runs from onDisconnect.
  }
  setStatus(text)
}

// Asks the host to ping back when those tasks complete. Does not read mail.
function postWatch() {
  const pending = openWatches()
  if (pending.length === 0) return
  const port = ensureWatchPort()
  if (!port) return
  const byRun = new Map()
  for (const capture of pending) {
    const ids = byRun.get(capture.sent.runId) ?? []
    ids.push(capture.sent.taskId)
    byRun.set(capture.sent.runId, ids)
  }
  for (const [watchedRun, taskIds] of byRun) {
    const dispatches = taskIds.map((taskId) => {
      const capture = pending.find((entry) => entry.sent.taskId === taskId)
      return { taskId, dispatchId: capture?.sent.dispatchId ?? null }
    })
    port.postMessage({
      cmd: 'watch',
      id: `watch-${watchedRun}`,
      runId: watchedRun,
      taskIds,
      dispatches
    })
  }
}

function lockCatch(node) {
  node.dataset.done = 'true'
  for (const control of node.querySelectorAll('input, textarea, button')) {
    if (control.classList.contains('catch-head')) continue
    control.disabled = true
  }
  node.querySelector('.send').hidden = true
}

function showLanded(taskId, status) {
  const capture = captures.find((entry) => entry.sent?.taskId === taskId)
  if (!capture || capture.done || capture.sent.settled) return
  const failed = status === 'failed'
  capture.sent.settled = failed ? 'failed' : 'completed'
  capture.done = true
  const node = nodeFor(capture)
  if (!node) return
  const tag = node.querySelector('.sent-tag')
  tag.hidden = false
  tag.textContent = failed ? 'failed' : 'completed'
  tag.dataset.state = failed ? 'failed' : 'completed'
  lockCatch(node)
  if (failed) showCatchError(node, 'Worker failed')
  setStatus(failed ? 'A catch failed' : 'Completed', failed ? undefined : 'done')
}

function showDestinationError(text) {
  destinationRow.dataset.ready = 'false'
  destinationSelect.hidden = true
  destinationText.hidden = false
  destinationText.textContent = text
}

function describeTarget(target) {
  if (!target) return 'unknown destination'
  const name = target.projectName || target.worktreeName || target.worktreePath
  return `${name} · ${target.tabTitle || 'untitled'} · ${target.agentIdentity}`
}

// A native <select> cannot render images, and the project icon is the fastest
// way to tell one destination from another in a narrow panel. Orca stores the
// icon as a data-URI image, a lucide name, or an emoji. The lucide set is not
// shipped here, so those fall back to a tinted initial of the project name.
function projectIcon(target) {
  const icon = target?.projectIcon
  if (icon?.type === 'image' && typeof icon.src === 'string' && icon.src) {
    const img = document.createElement('img')
    img.className = 'project-icon'
    img.src = icon.src
    img.alt = ''
    return img
  }
  const badge = document.createElement('span')
  badge.className = 'project-icon project-icon-glyph'
  if (icon?.type === 'emoji' && typeof icon.emoji === 'string' && icon.emoji) {
    badge.textContent = icon.emoji
    return badge
  }
  const name = target?.projectName || target?.worktreeName || '?'
  badge.textContent = name.trim().charAt(0).toUpperCase() || '?'
  if (typeof target?.projectBadgeColor === 'string') badge.style.color = target.projectBadgeColor
  return badge
}

function renderDestinationValue() {
  destinationValue.replaceChildren()
  if (!destination) return
  destinationValue.append(projectIcon(destination), document.createTextNode(describeTarget(destination)))
}

let menuActive = -1

function destinationOptionNodes() {
  return [...destinationList.children]
}

function setMenuActive(index) {
  const options = destinationOptionNodes()
  if (options.length === 0) return
  menuActive = (index + options.length) % options.length
  options.forEach((option, i) => option.classList.toggle('is-active', i === menuActive))
}

function openDestinationMenu() {
  destinationList.hidden = false
  destinationSelect.setAttribute('aria-expanded', 'true')
  const options = destinationOptionNodes()
  const current = options.findIndex((option) => option.dataset.handle === destination?.terminalHandle)
  setMenuActive(current >= 0 ? current : 0)
}

function closeDestinationMenu() {
  if (destinationList.hidden) return
  destinationList.hidden = true
  destinationSelect.setAttribute('aria-expanded', 'false')
  for (const option of destinationList.children) option.classList.remove('is-active')
}

function chooseDestination(handle) {
  const target = targetFor(handle)
  if (!target) return
  destination = target
  void chrome.storage.session.set({ destinationHandle: handle })
  renderDestinationValue()
  for (const option of destinationList.children) {
    option.setAttribute('aria-selected', String(option.dataset.handle === handle))
  }
  followDestinationAgent()
  closeDestinationMenu()
}

function buildDestinationMenu() {
  destinationList.replaceChildren()
  for (const target of destinationTargets) {
    const option = document.createElement('li')
    option.className = 'destination-option'
    option.dataset.handle = target.terminalHandle
    option.setAttribute('role', 'option')
    option.setAttribute('aria-selected', String(target === destination))
    const text = document.createElement('span')
    text.className = 'destination-option-text'
    text.textContent = describeTarget(target)
    option.append(projectIcon(target), text)
    option.addEventListener('click', () => chooseDestination(target.terminalHandle))
    destinationList.appendChild(option)
  }
}

async function refreshDestination() {
  closeDestinationMenu()
  showDestinationError('Checking Orca…')
  const reply = await callHost({ cmd: 'resolve' })
  if (!reply.ok) {
    destination = null
    if (Array.isArray(reply.agents)) fillAgents(reply.agents)
    showDestinationError(describeBridgeFailure(reply))
    return
  }

  const stored = await chrome.storage.session.get('destinationHandle')
  destinationTargets = reply.targets
  // Keep the chosen conversation across refreshes; fall back to the most
  // recently active one, which is the usual answer.
  const keep = reply.targets.some((target) => target.terminalHandle === stored.destinationHandle)
  destination = targetFor(keep ? stored.destinationHandle : reply.targets[0].terminalHandle)
  buildDestinationMenu()
  renderDestinationValue()
  if (Array.isArray(reply.agents)) fillAgents(reply.agents)
  followDestinationAgent()
  destinationRow.dataset.ready = 'true'
  destinationText.hidden = true
  destinationSelect.hidden = false
}

// Monogram tiles, the same tinted-initial style the panel uses for projects.
// A native <select> cannot draw these, so the picker below is a custom menu
// that mirrors the hidden <select>, which stays the source of truth.
const AGENT_MARKS = {
  claude: 'CL',
  codex: 'CX',
  cursor: 'CU',
  antigravity: 'AG',
  muse: 'MU',
  zcode: 'ZC',
  opencode: 'OC',
  opencode2: 'O2',
  grok: 'GK',
  crush: 'CR',
  pi: 'PI'
}

function agentIcon(id) {
  const svg = document.createElementNS(SVG_NS, 'svg')
  svg.setAttribute('class', 'agent-icon')
  svg.setAttribute('viewBox', '0 0 14 14')
  svg.setAttribute('aria-hidden', 'true')
  const tile = document.createElementNS(SVG_NS, 'rect')
  tile.setAttribute('x', '0.5')
  tile.setAttribute('y', '0.5')
  tile.setAttribute('width', '13')
  tile.setAttribute('height', '13')
  tile.setAttribute('rx', '2.5')
  const mark = document.createElementNS(SVG_NS, 'text')
  mark.setAttribute('x', '7')
  mark.setAttribute('y', '7')
  mark.setAttribute('text-anchor', 'middle')
  mark.setAttribute('dominant-baseline', 'central')
  mark.textContent = AGENT_MARKS[id] ?? id.slice(0, 2).toUpperCase()
  svg.append(tile, mark)
  return svg
}

function renderAgentValue() {
  const id = agentSelect.value
  agentValue.replaceChildren()
  if (!id) return
  const text = document.createElement('span')
  text.className = 'destination-option-text'
  text.textContent = id
  agentValue.append(agentIcon(id), text)
}

function syncAgentMenu() {
  renderAgentValue()
  for (const option of agentList.children) {
    option.setAttribute('aria-selected', String(option.dataset.agent === agentSelect.value))
  }
}

function buildAgentMenu() {
  agentList.replaceChildren()
  for (const option of agentSelect.options) {
    const item = document.createElement('li')
    item.className = 'destination-option'
    item.dataset.agent = option.value
    item.setAttribute('role', 'option')
    const text = document.createElement('span')
    text.className = 'destination-option-text'
    text.textContent = option.value
    item.append(agentIcon(option.value), text)
    item.addEventListener('click', () => chooseAgent(option.value))
    agentList.appendChild(item)
  }
  syncAgentMenu()
}

let agentActive = 0

function agentOptionNodes() {
  return [...agentList.children]
}

function setAgentActive(index) {
  const options = agentOptionNodes()
  if (options.length === 0) return
  agentActive = (index + options.length) % options.length
  options.forEach((option, i) => option.classList.toggle('is-active', i === agentActive))
  options[agentActive].scrollIntoView({ block: 'nearest' })
}

function openAgentMenu() {
  agentList.hidden = false
  agentButton.setAttribute('aria-expanded', 'true')
  const current = agentOptionNodes().findIndex((option) => option.dataset.agent === agentSelect.value)
  setAgentActive(current >= 0 ? current : 0)
}

function closeAgentMenu() {
  if (agentList.hidden) return
  agentList.hidden = true
  agentButton.setAttribute('aria-expanded', 'false')
  for (const option of agentList.children) option.classList.remove('is-active')
}

function chooseAgent(id) {
  agentSelect.value = id
  // Fire the change event the hidden select already listens for, so the pin
  // and the session storage update exactly as a native pick would.
  agentSelect.dispatchEvent(new Event('change'))
  syncAgentMenu()
  closeAgentMenu()
}

agentButton.addEventListener('click', () => {
  if (agentList.hidden) openAgentMenu()
  else closeAgentMenu()
})
agentButton.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') {
    closeAgentMenu()
  } else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
    event.preventDefault()
    if (agentList.hidden) openAgentMenu()
    else setAgentActive(agentActive + (event.key === 'ArrowDown' ? 1 : -1))
  } else if (event.key === 'Enter' && !agentList.hidden) {
    event.preventDefault()
    const option = agentOptionNodes()[agentActive]
    if (option) chooseAgent(option.dataset.agent)
  }
})
document.addEventListener('click', (event) => {
  if (!agentPicker.contains(event.target)) closeAgentMenu()
})

let knownAgents = [...AGENTS]

function fillAgents(ids) {
  const next = (Array.isArray(ids) ? ids : []).filter((id) => AGENTS.includes(id))
  const list = next.length > 0 ? next : knownAgents
  knownAgents = list
  const current = agentSelect.value
  agentSelect.replaceChildren()
  for (const id of list) {
    const option = document.createElement('option')
    option.value = id
    option.textContent = id
    agentSelect.appendChild(option)
  }
  if (list.includes(current)) agentSelect.value = current
  else if (destination?.agentIdentity && list.includes(destination.agentIdentity) && !agentPinned) {
    agentSelect.value = destination.agentIdentity
  } else {
    agentSelect.value = list[0]
  }
  buildAgentMenu()
}

fillAgents(AGENTS)

// An explicit pick sticks; otherwise the agent follows whichever conversation
// is selected, which is right until the user says otherwise.
let agentPinned = false

async function restoreAgent() {
  const stored = await chrome.storage.session.get('agent')
  if (stored.agent && knownAgents.includes(stored.agent)) {
    agentSelect.value = stored.agent
    agentPinned = true
    syncAgentMenu()
  }
}

function targetFor(handle) {
  return destinationTargets.find((target) => target.terminalHandle === handle) ?? null
}

function followDestinationAgent() {
  if (agentPinned) return
  const identity = destination?.agentIdentity
  if (identity && knownAgents.includes(identity)) agentSelect.value = identity
  syncAgentMenu()
}

agentSelect.addEventListener('change', () => {
  agentPinned = true
  void chrome.storage.session.set({ agent: agentSelect.value })
})

destinationSelect.addEventListener('click', () => {
  if (destinationList.hidden) openDestinationMenu()
  else closeDestinationMenu()
})
document.addEventListener('click', (event) => {
  if (!destinationRow.contains(event.target)) closeDestinationMenu()
})
document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') {
    closeDestinationMenu()
    return
  }
  if (destinationList.hidden) return
  const options = destinationOptionNodes()
  if (event.key === 'ArrowDown') {
    event.preventDefault()
    setMenuActive(menuActive + 1)
  } else if (event.key === 'ArrowUp') {
    event.preventDefault()
    setMenuActive(menuActive - 1)
  } else if (event.key === 'Enter') {
    const option = options[menuActive]
    if (option) {
      event.preventDefault()
      chooseDestination(option.dataset.handle)
    }
  }
})
destinationRefresh.addEventListener('click', () => void refreshDestination())
destinationRow.title = `Send destination. This extension is ${chrome.runtime.id}`

// A dispatch can fail for reasons only Orca knows, such as an agent launcher
// that is not enabled. The footer status scrolls out of sight on a short panel,
// so the reason also lands on the card the user just pressed Send on.
async function blobToBase64(blob) {
  const bytes = new Uint8Array(await blob.arrayBuffer())
  let binary = ''
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
  }
  return btoa(binary)
}

// Clipboard images (Shottr etc.) have no path, so the host saves them and the
// note carries `[/abs/path.png]` for the worker to open.
async function pasteImages(note, capture, images) {
  setStatus('Saving pasted image…')
  const paths = []
  for (const image of images) {
    const reply = await callHost({ cmd: 'saveImage', mime: image.type, base64: await blobToBase64(image) })
    if (!reply.ok) {
      const reason = /unknown command/.test(reply.reason ?? '')
        ? 'Bridge is out of date: run native/install.sh again'
        : describeBridgeFailure(reply)
      setStatus(`Paste failed: ${reason}`)
      return
    }
    paths.push(`[${reply.path}]`)
  }
  const start = note.selectionStart
  const end = note.selectionEnd
  const before = note.value.slice(0, start)
  const text = (before && !/\s$/.test(before) ? ' ' : '') + paths.join(' ') + ' '
  note.setRangeText(text, start, end, 'end')
  capture.comment = note.value
  note.focus()
  setStatus(images.length > 1 ? `Attached ${images.length} images` : 'Attached image', 'done')
}

function showCatchError(node, text) {
  const slot = node.querySelector('.catch-error')
  slot.textContent = text ?? ''
  slot.hidden = !text
}

async function sendCapture(capture, node) {
  if (capture.sent) return true
  const spec = OrcaTaskSpec.buildTaskSpec(capture)
  if (!spec) {
    setStatus('Nothing to dispatch for an approve')
    return false
  }
  const button = node.querySelector('.send')
  showCatchError(node, null)
  button.disabled = true
  button.textContent = 'Sending…'
  setStatus(`Dispatching ${OrcaTaskSpec.buildTaskTitle(capture)}`)

  const reply = await callHost({
    cmd: 'dispatch',
    spec,
    title: OrcaTaskSpec.buildTaskTitle(capture),
    terminalHandle: destination?.terminalHandle ?? null,
    agent: agentSelect.value,
    runId,
    objective: `GoFish design feedback: ${capture.payload.page.sanitizedUrl}`
  })

  if (!reply.ok) {
    button.disabled = false
    button.textContent = 'Send'
    const detail = describeBridgeFailure(reply)
    showCatchError(node, detail)
    setStatus(detail)
    return false
  }

  runId = reply.runId
  void chrome.storage.session.set({ runId })
  capture.sent = {
    dispatchId: reply.dispatchId,
    taskId: reply.taskId,
    agent: reply.agent,
    runId: reply.runId
  }
  node.dataset.sent = 'true'
  const tag = node.querySelector('.sent-tag')
  tag.hidden = false
  const watched = Boolean(reply.taskId && reply.runId)
  if (watched) showWorking(tag)
  else tag.dataset.state = 'sent'
  // The locked form is noise once it's sent; the head carries the status.
  node.dataset.open = 'false'
  node.querySelector('.catch-head').setAttribute('aria-expanded', 'false')
  tag.title = `task ${reply.taskId ?? '?'} · dispatch ${reply.dispatchId ?? '?'}`
  button.textContent = 'Sent'
  button.title = reply.taskId ? 'Waiting for the worker to finish' : ''
  if (reply.target) destination = reply.target
  setStatus(`Dispatched to ${reply.agent}`, 'good')
  if (watched) postWatch()
  return true
}

function showWorking(tag) {
  const svg = document.createElementNS(SVG_NS, 'svg')
  svg.setAttribute('class', 'loop')
  svg.setAttribute('viewBox', '0 0 12 12')
  svg.setAttribute('aria-hidden', 'true')
  const track = document.createElementNS(SVG_NS, 'circle')
  track.setAttribute('class', 'loop-track')
  const arc = document.createElementNS(SVG_NS, 'circle')
  arc.setAttribute('class', 'loop-arc')
  for (const ring of [track, arc]) {
    ring.setAttribute('cx', '6')
    ring.setAttribute('cy', '6')
    ring.setAttribute('r', '4.5')
    svg.appendChild(ring)
  }
  const label = document.createElement('span')
  label.className = 'loop-label'
  label.textContent = 'working'
  tag.replaceChildren(svg, label)
  tag.dataset.state = 'working'
}

// Without a watch nothing will ever stop the loader, so fall back to a static tag.
function stopWorking() {
  for (const tag of listEl.querySelectorAll(".sent-tag[data-state='working']")) {
    tag.textContent = 'sent'
    tag.dataset.state = 'sent'
  }
}

async function activeTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true })
  return tab ?? null
}

function pickerOptions() {
  return { autoCopy: autoCopyInput.checked, keepPicking: keepPickingInput.checked }
}

function reflectDevice(tabId) {
  const device = devices.get(tabId) ?? 'desktop'
  for (const button of deviceButtons) {
    button.setAttribute('aria-pressed', button.dataset.device === device ? 'true' : 'false')
  }
}

async function attach(tabId) {
  if (attachedTabs.has(tabId)) return true
  try {
    await chrome.debugger.attach({ tabId }, '1.3')
    attachedTabs.add(tabId)
    return true
  } catch (error) {
    return false
  }
}

async function detach(tabId) {
  if (!attachedTabs.has(tabId)) return
  attachedTabs.delete(tabId)
  await chrome.debugger.detach({ tabId }).catch(() => {})
}

// Emulation is per debugger session and survives navigation, so the override
// has to be cleared before the debugger goes away.
async function applyDevice(tabId, device) {
  const spec = DEVICE_SPECS[device]
  if (!spec) {
    if (attachedTabs.has(tabId)) {
      await chrome.debugger
        .sendCommand({ tabId }, 'Emulation.clearDeviceMetricsOverride')
        .catch(() => {})
      await detach(tabId)
    }
    return true
  }
  if (!(await attach(tabId))) return false
  await chrome.debugger.sendCommand({ tabId }, 'Emulation.setDeviceMetricsOverride', spec)
  return true
}

async function setDevice(device) {
  const tab = await activeTab()
  if (!tab || !tab.id || !/^(https?|file):/.test(tab.url ?? '')) {
    setStatus('Open an http or file page first')
    return
  }
  if ((devices.get(tab.id) ?? 'desktop') === device) return
  if (!(await applyDevice(tab.id, device))) {
    setStatus('Close DevTools on this tab to preview a device')
    return
  }
  devices.set(tab.id, device)
  reflectDevice(tab.id)
  setStatus(device === 'desktop' ? 'Desktop viewport' : `${device} viewport`)
  // A reload re-runs JS that read the width once at mount. The override
  // outlives it, so the device sticks.
  await chrome.tabs.reload(tab.id).catch(() => {})
}

for (const button of deviceButtons) {
  button.addEventListener('click', () => void setDevice(button.dataset.device))
}

// DevTools opening on the tab (or the tab closing) detaches us; fall back to
// desktop rather than showing a preset that is no longer applied.
chrome.debugger.onDetach.addListener((source) => {
  if (source.tabId === undefined) return
  attachedTabs.delete(source.tabId)
  if ((devices.get(source.tabId) ?? 'desktop') === 'desktop') return
  devices.set(source.tabId, 'desktop')
  void (async () => {
    if ((await activeTab())?.id === source.tabId) reflectDevice(source.tabId)
  })()
})

async function cast() {
  const tab = await activeTab()
  if (!tab || !tab.id || !/^(https?|file):/.test(tab.url ?? '')) {
    setStatus('Open an http or file page first')
    return
  }
  try {
    await chrome.scripting.executeScript({
      target: { tabId: tab.id, allFrames: true },
      files: ['content/target-bridge.js']
    })
    await chrome.scripting.executeScript({
      target: { tabId: tab.id, allFrames: true },
      world: 'MAIN',
      files: ['content/target-format.js', 'content/target-picker.js']
    })
  } catch (error) {
    setStatus('Cannot reach this page')
    return
  }
  await chrome.tabs.sendMessage(tab.id, { type: 'arm', options: pickerOptions() }).catch(() => {})
  showHost(tab.url)
  setArmed(tab.id)
  setStatus('Hover the page, click to hook', 'good')
}

async function reelIn() {
  if (armedTabId !== null) {
    await chrome.tabs.sendMessage(armedTabId, { type: 'disarm' }).catch(() => {})
  }
  setArmed(null)
  setStatus(tally())
}

function tally() {
  if (captures.length === 0) return 'Ready'
  return captures.length === 1 ? '1 on the line' : `${captures.length} on the line`
}

castButton.addEventListener('click', () => {
  if (armedTabId === null) void cast()
  else void reelIn()
})

// Why: the picker copies from the page on click (only the page has focus at
// that moment), so settings must reach it before the next pick.
for (const input of [autoCopyInput, keepPickingInput]) {
  input.addEventListener('change', () => {
    if (armedTabId === null) return
    void chrome.tabs
      .sendMessage(armedTabId, { type: 'arm', options: pickerOptions() })
      .catch(() => {})
  })
}

chrome.runtime.onMessage.addListener((message, sender) => {
  if (!message || typeof message.type !== 'string') return
  if (sender.tab && armedTabId !== null && sender.tab.id !== armedTabId) return
  if (message.type === 'selected') {
    if (!keepPickingInput.checked) setArmed(null)
    void addCapture(message.payload, sender.tab?.id)
  }
  if (message.type === 'cancelled') {
    setArmed(null)
    setStatus(tally())
  }
  if (message.type === 'error') setStatus('Could not read that element')
})

function base64ToBlob(base64, type) {
  const binary = atob(base64)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
  return new Blob([bytes], { type })
}

async function captureScreenshot(tabId, target, viewportWidth) {
  const rect = target.rectViewport
  // Under device emulation the page is scaled to fit the tab, so a plain tab
  // capture no longer lines up with the element's CSS rect. The debugger can
  // clip to the element's page rect instead, which is exact at any zoom.
  if (tabId !== undefined && attachedTabs.has(tabId) && target.rectPage.width > 0 && target.rectPage.height > 0) {
    const page = target.rectPage
    try {
      const reply = await chrome.debugger.sendCommand({ tabId }, 'Page.captureScreenshot', {
        format: 'png',
        captureBeyondViewport: true,
        clip: { x: page.x, y: page.y, width: page.width, height: page.height, scale: 1 }
      })
      const blob = base64ToBlob(reply.data, 'image/png')
      return { blob, url: URL.createObjectURL(blob) }
    } catch (error) {
      // Fall through to the plain tab capture.
    }
  }
  try {
    const dataUrl = await chrome.tabs.captureVisibleTab({ format: 'png' })
    const bitmap = await createImageBitmap(await (await fetch(dataUrl)).blob())
    // The capture is in device pixels; the rect is in CSS pixels.
    const scale = viewportWidth > 0 ? bitmap.width / viewportWidth : 1
    const x = Math.max(0, Math.round(rect.x * scale))
    const y = Math.max(0, Math.round(rect.y * scale))
    const width = Math.min(bitmap.width - x, Math.round(rect.width * scale))
    const height = Math.min(bitmap.height - y, Math.round(rect.height * scale))
    if (width <= 0 || height <= 0) return null
    const canvas = new OffscreenCanvas(width, height)
    canvas.getContext('2d').drawImage(bitmap, x, y, width, height, 0, 0, width, height)
    const blob = await canvas.convertToBlob({ type: 'image/png' })
    return { blob, url: URL.createObjectURL(blob) }
  } catch (error) {
    return null
  }
}

async function addCapture(payload, tabId) {
  const capture = { id: nextId++, payload, intent: 'fix', comment: '', shot: null }
  captures.push(capture)
  emptyEl.hidden = true

  for (const node of listEl.querySelectorAll('.catch')) node.dataset.open = 'false'
  for (const node of listEl.querySelectorAll('.catch-head')) {
    node.setAttribute('aria-expanded', 'false')
  }

  const node = renderCapture(capture)
  listEl.appendChild(node)
  node.scrollIntoView({ block: 'nearest' })
  setStatus(autoCopyInput.checked ? 'Hooked, copied' : 'Hooked', 'good')

  const shot = await captureScreenshot(tabId, payload.target, payload.page.viewportWidth)
  if (!shot) return
  capture.shot = shot
  const image = node.querySelector('.shot')
  image.src = shot.url
  image.alt = `Screenshot of ${captureLabel(payload)}`
  image.hidden = false
  node.querySelector('.copy-img').hidden = false
}

function captureLabel(payload) {
  const target = payload.target
  const name = target.accessibility.accessibleName || target.textSnippet
  const base = name ? `${target.tagName} “${name.slice(0, 44)}”` : target.tagName
  return target.reactComponents ? `${target.reactComponents} ${base}` : base
}

function renderCapture(capture) {
  const node = template.content.firstElementChild.cloneNode(true)
  captureNodes.set(capture, node)
  node.dataset.open = 'true'
  node.classList.add('fresh')
  node.addEventListener('animationend', () => node.classList.remove('fresh'), { once: true })

  node.querySelector('.idx').textContent = String(captures.indexOf(capture) + 1).padStart(2, '0')
  node.querySelector('.label').textContent = captureLabel(capture.payload)
  node.querySelector('.selector').textContent = capture.payload.target.selector

  const head = node.querySelector('.catch-head')
  head.addEventListener('click', () => {
    const open = node.dataset.open !== 'true'
    node.dataset.open = open ? 'true' : 'false'
    head.setAttribute('aria-expanded', String(open))
  })

  const sendButton = node.querySelector('.send')
  if (capture.intent === 'approve') sendButton.disabled = true
  sendButton.addEventListener('click', () => {
    if (capture.done || capture.sent) return
    void sendCapture(capture, node)
  })

  const intents = node.querySelector('.intents')
  for (const intent of INTENTS) {
    const label = document.createElement('label')
    const input = document.createElement('input')
    input.type = 'radio'
    input.name = `intent-${capture.id}`
    input.value = intent
    input.checked = intent === capture.intent
    input.addEventListener('change', () => {
      capture.intent = intent
      // Approve carries no work, so there is nothing to dispatch.
      if (capture.done || capture.sent) return
      sendButton.disabled = intent === 'approve'
    })
    const span = document.createElement('span')
    const icon = document.createElementNS(SVG_NS, 'svg')
    icon.setAttribute('class', 'intent-icon')
    icon.setAttribute('aria-hidden', 'true')
    const use = document.createElementNS(SVG_NS, 'use')
    use.setAttribute('href', `#i-${intent}`)
    icon.appendChild(use)
    span.append(icon, intent)
    label.append(input, span)
    intents.appendChild(label)
  }

  const note = node.querySelector('.note')
  const submitWithModifier = navigator.userAgent.includes('Mac')
  node.querySelector('.note-send-hint').textContent = submitWithModifier
    ? 'cmd + enter'
    : 'ctrl + enter'
  note.addEventListener('input', (event) => {
    capture.comment = event.target.value
  })
  note.addEventListener('keydown', (event) => {
    // Plain Enter stays a newline. Modifier+Enter sends.
    if (event.key !== 'Enter' || event.isComposing || event.repeat || event.shiftKey) return
    const modifier = submitWithModifier ? event.metaKey : event.ctrlKey
    if (!modifier || event.altKey) return
    event.preventDefault()
    if (sendButton.disabled || capture.done || capture.sent) return
    void sendCapture(capture, node)
  })
  note.addEventListener('paste', (event) => {
    const images = [...(event.clipboardData?.files ?? [])].filter((file) => file.type.startsWith('image/'))
    if (images.length === 0) return
    event.preventDefault()
    void pasteImages(note, capture, images)
  })
  node.querySelector('.copy-text').addEventListener('click', () => {
    void writeText(OrcaTargetFormat.formatGrabPayloadAsText(capture.payload), 'Copied text')
  })
  node.querySelector('.copy-md').addEventListener('click', () => {
    void writeText(OrcaTargetFormat.formatAnnotationsAsMarkdown([capture]), 'Copied markdown')
  })
  node.querySelector('.copy-img').addEventListener('click', () => {
    void writeImage(capture)
  })
  node.querySelector('.remove').addEventListener('click', () => {
    const index = captures.indexOf(capture)
    if (index !== -1) captures.splice(index, 1)
    if (capture.shot) URL.revokeObjectURL(capture.shot.url)
    captureNodes.delete(capture)
    node.remove()
    renumber()
    emptyEl.hidden = captures.length > 0
    setStatus(tally())
  })
  return node
}

function renumber() {
  const nodes = listEl.querySelectorAll('.idx')
  nodes.forEach((element, index) => {
    element.textContent = String(index + 1).padStart(2, '0')
  })
}

async function writeText(text, okMessage) {
  try {
    await navigator.clipboard.writeText(text)
    setStatus(okMessage, 'good')
  } catch (error) {
    setStatus('Clipboard blocked: click the panel, retry')
  }
}

async function writeImage(capture) {
  if (!capture.shot) return
  try {
    await navigator.clipboard.write([new ClipboardItem({ 'image/png': capture.shot.blob })])
    setStatus('Copied image', 'good')
  } catch (error) {
    setStatus('Image clipboard blocked')
  }
}

sendAllButton.addEventListener('click', () => {
  void (async () => {
    const pending = captures.filter(
      (capture) => !capture.sent && capture.intent !== 'approve'
    )
    if (pending.length === 0) {
      setStatus('Nothing left to dispatch')
      return
    }
    let sent = 0
    for (const capture of pending) {
      const node = nodeFor(capture)
      if (!node) continue
      // Serial: each dispatch spins up a worker terminal in the same worktree.
      if (await sendCapture(capture, node)) sent += 1
    }
    setStatus(`Dispatched ${sent} of ${pending.length}`, sent > 0 ? 'good' : undefined)
  })()
})

copyAllButton.addEventListener('click', () => {
  if (captures.length === 0) {
    setStatus('Nothing on the line yet')
    return
  }
  void writeText(
    OrcaTargetFormat.formatAnnotationsAsMarkdown(captures),
    `Copied ${captures.length} as markdown`
  )
})

clearButton.addEventListener('click', () => {
  for (const capture of captures) if (capture.shot) URL.revokeObjectURL(capture.shot.url)
  captures.length = 0
  captureNodes.clear()
  for (const node of listEl.querySelectorAll('.catch')) node.remove()
  emptyEl.hidden = false
  setStatus('Ready')
})

chrome.tabs.onActivated.addListener(({ tabId }) => {
  if (armedTabId !== null) void reelIn()
  reflectDevice(tabId)
  void (async () => {
  showHost((await activeTab())?.url)
  const stored = await chrome.storage.session.get('runId')
  runId = stored.runId ?? null
  await refreshDestination()
})()
})

chrome.tabs.onRemoved.addListener((tabId) => {
  devices.delete(tabId)
  attachedTabs.delete(tabId)
})

void (async () => {
  const tab = await activeTab()
  showHost(tab?.url)
  reflectDevice(tab?.id)
  const stored = await chrome.storage.session.get('runId')
  runId = stored.runId ?? null
  await restoreAgent()
  await refreshDestination()
})()
