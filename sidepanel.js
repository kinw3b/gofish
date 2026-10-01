'use strict'

const INTENTS = ['fix', 'change', 'question', 'approve']

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
    })
    const span = document.createElement('span')
    span.textContent = intent
    label.append(input, span)
    intents.appendChild(label)
  }

  node.querySelector('.note').addEventListener('input', (event) => {
    capture.comment = event.target.value
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
  for (const node of listEl.querySelectorAll('.catch')) node.remove()
  emptyEl.hidden = false
  setStatus('Ready')
})

chrome.tabs.onActivated.addListener(() => {
  if (armedTabId !== null) void reelIn()
  void (async () => showHost((await activeTab())?.url))()
})

void (async () => showHost((await activeTab())?.url))()
