// Isolated-world relay: the picker runs in the MAIN world (it needs React
// fiber expandos, which isolated worlds cannot see), so messages hop through
// window.postMessage.
;(function () {
  'use strict'
  if (window.__orcaTargetBridge) return
  window.__orcaTargetBridge = true

  window.addEventListener('message', function (event) {
    if (event.source !== window || !event.data || event.data.source !== 'orca-target-picker') return
    chrome.runtime.sendMessage({ type: event.data.type, payload: event.data.payload }).catch(
      function () {}
    )
  })

  chrome.runtime.onMessage.addListener(function (message) {
    if (!message || typeof message.type !== 'string') return
    if (message.type !== 'arm' && message.type !== 'disarm') return
    window.postMessage(
      { source: 'orca-target-panel', type: message.type, options: message.options || null },
      '*'
    )
  })
})()
