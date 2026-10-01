'use strict'

// Orca agent launcher ids accepted by `orchestration worker-start --agent`. Which
// of these is actually enabled lives in Orca settings, not the CLI, so the
// worker agent is the user's choice rather than the destination terminal's.
const AGENTS = [
  'claude',
  'codex',
  'cursor',
  'antigravity',
  'muse',
  'zcode',
  'opencode',
  'opencode2',
  'grok'
]

const INTENTS = ['fix', 'change', 'question', 'approve']
const HOST = 'com.gofish.orca'
const PROTOCOL = 2

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
const destinationText = destinationRow.querySelector('.destination-text')
const destinationRefresh = document.getElementById('destination-refresh')
const agentSelect = document.getElementById('agent')
const sendAllButton = document.getElementById('send-all')

function setStatus(text, tone) {
  statusEl.textContent = text
  if (tone) statusEl.dataset.tone = tone
  else delete statusEl.dataset.tone
}

function setArmed(tabId) {
  armedTabId = tabId
  castButton.dataset.armed = tabId === null ? 'false' : 'true'
  castButton.textContent = tabId === null ? 'Cast' : 'Reel in (Esc)'
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
    port.postMessage({ cmd: 'watch', id: `watch-${watchedRun}`, runId: watchedRun, taskIds })
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
  const name = target.worktreeName || target.worktreePath
  return `${name} · ${target.tabTitle || 'untitled'} · ${target.agentIdentity}`
}

async function refreshDestination() {
  showDestinationError('Checking Orca…')
  const reply = await callHost({ cmd: 'resolve' })
  if (!reply.ok) {
    destination = null
    showDestinationError(describeBridgeFailure(reply))
    return
  }

  const stored = await chrome.storage.session.get('destinationHandle')
  destinationTargets = reply.targets
  destinationSelect.replaceChildren()
  for (const target of reply.targets) {
    const option = document.createElement('option')
    option.value = target.terminalHandle
    option.textContent = describeTarget(target)
    destinationSelect.appendChild(option)
  }
  // Keep the chosen conversation across refreshes; fall back to the most
  // recently active one, which is the usual answer.
  const keep = reply.targets.some((target) => target.terminalHandle === stored.destinationHandle)
  destinationSelect.value = keep ? stored.destinationHandle : reply.targets[0].terminalHandle
  destination = targetFor(destinationSelect.value)
  followDestinationAgent()
  destinationRow.dataset.ready = 'true'
  destinationText.hidden = true
  destinationSelect.hidden = false
}

for (const id of AGENTS) {
  const option = document.createElement('option')
  option.value = id
  option.textContent = id
  agentSelect.appendChild(option)
}
agentSelect.value = 'claude'

// An explicit pick sticks; otherwise the agent follows whichever conversation
// is selected, which is right until the user says otherwise.
let agentPinned = false

async function restoreAgent() {
  const stored = await chrome.storage.session.get('agent')
  if (stored.agent && AGENTS.includes(stored.agent)) {
    agentSelect.value = stored.agent
    agentPinned = true
  }
}

function targetFor(handle) {
  return destinationTargets.find((target) => target.terminalHandle === handle) ?? null
}

function followDestinationAgent() {
  if (agentPinned) return
  const identity = destination?.agentIdentity
  if (identity && AGENTS.includes(identity)) agentSelect.value = identity
}

agentSelect.addEventListener('change', () => {
  agentPinned = true
  void chrome.storage.session.set({ agent: agentSelect.value })
})

destinationSelect.addEventListener('change', () => {
  void chrome.storage.session.set({ destinationHandle: destinationSelect.value })
  destination = targetFor(destinationSelect.value)
  followDestinationAgent()
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
    terminalHandle: destinationSelect.value || null,
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

const SVG_NS = 'http://www.w3.org/2000/svg'

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
    void addCapture(message.payload)
  }
  if (message.type === 'cancelled') {
    setArmed(null)
    setStatus(tally())
  }
  if (message.type === 'error') setStatus('Could not read that element')
})

async function captureScreenshot(rect) {
  try {
    const dataUrl = await chrome.tabs.captureVisibleTab({ format: 'png' })
    const bitmap = await createImageBitmap(await (await fetch(dataUrl)).blob())
    // The capture is in device pixels; the rect is in CSS pixels.
    const scale = rect.viewportWidth > 0 ? bitmap.width / rect.viewportWidth : 1
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

async function addCapture(payload) {
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

  const shot = await captureScreenshot({
    x: payload.target.rectViewport.x,
    y: payload.target.rectViewport.y,
    width: payload.target.rectViewport.width,
    height: payload.target.rectViewport.height,
    viewportWidth: payload.page.viewportWidth
  })
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

chrome.tabs.onActivated.addListener(() => {
  if (armedTabId !== null) void reelIn()
  void (async () => {
  showHost((await activeTab())?.url)
  const stored = await chrome.storage.session.get('runId')
  runId = stored.runId ?? null
  await refreshDestination()
})()
})

void (async () => {
  showHost((await activeTab())?.url)
  const stored = await chrome.storage.session.get('runId')
  runId = stored.runId ?? null
  await restoreAgent()
  await refreshDestination()
})()
