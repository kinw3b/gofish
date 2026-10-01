;(function () {
'use strict'

// Builds the orchestration Task spec. Orca's task-spec contract wants Target,
// Change, Constraints, Ownership and Observable acceptance to be explicit, so
// the raw annotation markdown is carried as evidence underneath them rather
// than being handed over as the whole brief.

const CHANGE_BY_INTENT = {
  fix: 'Fix the defect reported below.',
  change: 'Make the change requested below.',
  question: 'Answer the question below about how this is implemented. Do not change code unless answering requires it.',
  approve: null
}

const ACCEPTANCE_BY_INTENT = {
  fix: 'The reported defect is gone on that page, and the repo’s own typecheck, lint and tests pass.',
  change: 'The change is visible on that page, and the repo’s own typecheck, lint and tests pass.',
  question: 'A written answer naming the files and lines that implement this. No unrelated edits.'
}

function describeSpecTarget(payload) {
  const target = payload.target
  const lines = [`\`${target.selector}\` on ${payload.page.sanitizedUrl}`]
  if (target.sourceFile) lines.push(`Rendered by \`${target.sourceFile}\`.`)
  if (target.reactComponents) lines.push(`React owners: ${target.reactComponents}.`)
  return lines.join(' ')
}

function shortLabel(payload) {
  const target = payload.target
  const name = target.accessibility.accessibleName || target.textSnippet
  return name ? `${target.tagName} “${name.slice(0, 32)}”` : target.tagName
}

function buildTaskSpec(capture) {
  const payload = capture.payload
  const change = CHANGE_BY_INTENT[capture.intent]
  if (!change) return null

  const note = capture.comment.trim()
  const lines = [
    `**Target:** ${describeSpecTarget(payload)}`,
    '',
    `**Change:** ${change}${note ? ` Specifically: ${note}` : ''}`,
    '',
    '**Constraints:** Touch only this element and the code that renders it. Follow the patterns and' +
      ' design system already in this repo. Do not refactor unrelated code, and do not change' +
      ' behaviour nobody reported.',
    '',
    '**Ownership:** You own the files that render this element. Leave everything else alone; other' +
      ' workers may be editing it.',
    '',
    `**Observable acceptance:** ${ACCEPTANCE_BY_INTENT[capture.intent]}`,
    '',
    '---',
    '',
    OrcaTargetFormat.formatAnnotationsAsMarkdown([capture])
  ]
  return lines.join('\n')
}

function buildTaskTitle(capture) {
  return `GoFish ${capture.intent}: ${shortLabel(capture.payload)}`.slice(0, 72)
}

globalThis.OrcaTaskSpec = { buildTaskSpec, buildTaskTitle }
})()
