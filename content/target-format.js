// Clipboard formats ported from Orca:
//   text     -> formatGrabPayloadAsText (GrabConfirmationSheet.tsx)
//   markdown -> formatBrowserAnnotationsAsMarkdown (browser-annotation-output.ts)
;(function () {
  'use strict'
  if (globalThis.OrcaTargetFormat) return

  var INLINE_MAX = 2048

  function inlineText(content, maxLength) {
    var max = maxLength || INLINE_MAX
    return String(content || '')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, max)
  }

  function formatGrabPayloadAsText(payload) {
    var lines = []
    var target = payload.target
    lines.push('Attached browser context from ' + payload.page.sanitizedUrl)
    lines.push('')
    lines.push('Selected element:')
    lines.push(target.tagName)
    if (target.accessibility.accessibleName) {
      lines.push('Accessible name: "' + target.accessibility.accessibleName + '"')
    }
    if (target.accessibility.role) lines.push('Role: ' + target.accessibility.role)
    lines.push('Selector: ' + target.selector)
    if (target.sourceFile) lines.push('Source: ' + target.sourceFile)
    if (target.reactComponents) lines.push('React: ' + target.reactComponents)
    var rect = target.rectViewport
    lines.push('Dimensions: ' + Math.round(rect.width) + 'x' + Math.round(rect.height))
    lines.push('')

    if (target.textSnippet) {
      lines.push('Text content:')
      lines.push(target.textSnippet)
      lines.push('')
    }
    if (payload.nearbyText.length > 0) {
      lines.push('Nearby context:')
      payload.nearbyText.forEach(function (text) {
        lines.push('- ' + text)
      })
      lines.push('')
    }

    var styles = target.computedStyles
    var styleLines = []
    if (styles.display && styles.display !== 'inline') styleLines.push('display: ' + styles.display)
    if (styles.position && styles.position !== 'static') {
      styleLines.push('position: ' + styles.position)
    }
    if (styles.fontSize) styleLines.push('font-size: ' + styles.fontSize)
    if (styles.color) styleLines.push('color: ' + styles.color)
    if (styles.backgroundColor && styles.backgroundColor !== 'rgba(0, 0, 0, 0)') {
      styleLines.push('background: ' + styles.backgroundColor)
    }
    if (styleLines.length > 0) {
      lines.push('Computed styles:')
      styleLines.forEach(function (styleLine) {
        lines.push('  ' + styleLine)
      })
      lines.push('')
    }

    if (target.htmlSnippet) {
      lines.push('HTML:')
      lines.push(target.htmlSnippet)
      lines.push('')
    }
    if (payload.ancestorPath.length > 0) {
      lines.push('Ancestor path: ' + payload.ancestorPath.join(' > '))
    }
    if (target.fullPath) lines.push('Full DOM path: ' + target.fullPath)

    return lines.join('\n').replace(/\s+$/, '')
  }

  function maxBacktickRunLength(content, floor) {
    var maxRun = floor
    var currentRun = 0
    for (var index = 0; index < content.length; index += 1) {
      if (content.charCodeAt(index) !== 96) {
        currentRun = 0
        continue
      }
      currentRun += 1
      if (currentRun > maxRun) maxRun = currentRun
    }
    return maxRun
  }

  function fence(language, content) {
    var marker = '`'.repeat(maxBacktickRunLength(content, 3) + 1)
    return [marker + language, content, marker]
  }

  function inlineCode(content) {
    var marker = '`'.repeat(maxBacktickRunLength(content, 0) + 1)
    var padding = content.startsWith('`') || content.endsWith('`') ? ' ' : ''
    return marker + padding + content + padding + marker
  }

  function formatPageHeading(payload) {
    try {
      var url = new URL(payload.page.sanitizedUrl)
      return url.pathname + url.search
    } catch (e) {
      return payload.page.sanitizedUrl || 'current page'
    }
  }

  function annotationElementLabel(payload) {
    var target = payload.target
    var accessibleName = target.accessibility.accessibleName
    var base = accessibleName
      ? target.tagName + ' "' + inlineText(accessibleName) + '"'
      : target.textSnippet
        ? target.tagName + ' "' + inlineText(target.textSnippet).slice(0, 60) + '"'
        : target.tagName
    return target.reactComponents ? inlineText(target.reactComponents) + ' ' + base : base
  }

  function formatStyles(styles) {
    var entries = [
      ['display', styles.display],
      ['position', styles.position],
      ['width', styles.width],
      ['height', styles.height],
      ['margin', styles.margin],
      ['padding', styles.padding],
      ['color', styles.color],
      ['background', styles.backgroundColor],
      ['border', styles.border],
      ['border-radius', styles.borderRadius],
      ['font-family', styles.fontFamily],
      ['font-size', styles.fontSize],
      ['font-weight', styles.fontWeight],
      ['line-height', styles.lineHeight],
      ['text-align', styles.textAlign],
      ['z-index', styles.zIndex]
    ]
    var lines = []
    entries.forEach(function (entry) {
      var name = entry[0]
      var value = entry[1]
      if (!value || value === 'auto' || value === 'normal') return
      if (name === 'position' && value === 'static') return
      if (name === 'display' && value === 'inline') return
      if (name === 'background' && value === 'rgba(0, 0, 0, 0)') return
      lines.push('- ' + name + ': ' + value)
    })
    return lines
  }

  // annotations: [{ payload, intent, comment, browserPageId }]
  function formatAnnotationsAsMarkdown(annotations) {
    if (annotations.length === 0) return ''
    var first = annotations[0].payload
    var lines = [
      '## Design Feedback: ' + formatPageHeading(first),
      '',
      '**URL:** ' + first.page.sanitizedUrl,
      '**Browser tab id:** ' + (annotations[0].browserPageId || 'chrome'),
      '**Viewport:** ' + first.page.viewportWidth + 'x' + first.page.viewportHeight,
      ''
    ]

    annotations.forEach(function (annotation, index) {
      var payload = annotation.payload
      var target = payload.target
      var rect = target.rectViewport
      var styleLines = formatStyles(target.computedStyles)

      lines.push('### ' + (index + 1) + '. ' + annotationElementLabel(payload))
      lines.push('**Intent:** ' + annotation.intent)
      lines.push('**Selector:** ' + inlineCode(target.selector))
      if (target.elementPath) lines.push('**Location:** ' + inlineCode(target.elementPath))
      if (target.sourceFile) lines.push('**Source:** ' + inlineText(target.sourceFile))
      if (target.reactComponents) lines.push('**React:** ' + inlineText(target.reactComponents))
      lines.push(
        '**Bounds:** x=' +
          Math.round(rect.x) +
          ', y=' +
          Math.round(rect.y) +
          ', ' +
          Math.round(rect.width) +
          'x' +
          Math.round(rect.height)
      )
      if (target.cssClasses) lines.push('**Classes:** ' + inlineCode(target.cssClasses))
      if (target.selectedText) {
        lines.push('**Selected text:** "' + inlineText(target.selectedText) + '"')
      } else if (target.textSnippet) {
        lines.push('**Text:** "' + inlineText(target.textSnippet) + '"')
      }
      if (payload.nearbyText.length > 0) {
        lines.push('**Nearby text:**')
        payload.nearbyText.forEach(function (text) {
          lines.push('- ' + inlineText(text))
        })
      }
      if (target.nearbyElements && target.nearbyElements.length) {
        lines.push('**Nearby elements:**')
        target.nearbyElements.forEach(function (element) {
          lines.push('- ' + inlineText(element))
        })
      }
      if (styleLines.length > 0) {
        lines.push('**Computed styles:**')
        lines.push.apply(lines, styleLines)
      }
      if (target.fullPath) lines.push('**Full DOM path:** ' + inlineCode(target.fullPath))
      if (target.htmlSnippet) {
        lines.push('**HTML:**')
        lines.push.apply(lines, fence('html', target.htmlSnippet))
      }
      if (annotation.comment) lines.push('**Feedback:** ' + inlineText(annotation.comment))
      lines.push('')
    })

    return lines.join('\n').replace(/\s+$/, '')
  }

  globalThis.OrcaTargetFormat = {
    formatGrabPayloadAsText: formatGrabPayloadAsText,
    formatAnnotationsAsMarkdown: formatAnnotationsAsMarkdown
  }
})()
