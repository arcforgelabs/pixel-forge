import { ipcRenderer } from 'electron'

const MAX_SELECTIONS = 10

function emit(type, data = {}) {
  ipcRenderer.send('pixel-forge-preview:event', { type, data })
}

if (!window.__pixelForgeSelectionBridgeLoaded) {
  window.__pixelForgeSelectionBridgeLoaded = true

  let selectMode = false
  let hoverOverlay = null
  let hoverLabel = null
  let currentTarget = null
  let selectedElements = []

  function getXPath(element) {
    if (!element) return ''
    if (element.id) return `//*[@id="${element.id}"]`
    if (element === document.body) return '/html/body'

    let ix = 0
    const siblings = element.parentNode ? element.parentNode.childNodes : []
    for (let i = 0; i < siblings.length; i += 1) {
      const sibling = siblings[i]
      if (sibling === element) {
        const parentPath = getXPath(element.parentNode)
        const tagName = element.tagName.toLowerCase()
        return `${parentPath}/${tagName}[${ix + 1}]`
      }
      if (sibling.nodeType === 1 && sibling.tagName === element.tagName) {
        ix += 1
      }
    }
    return ''
  }

  function findElementByXPath(xpath) {
    if (!xpath) return null
    try {
      const result = document.evaluate(
        xpath,
        document,
        null,
        XPathResult.FIRST_ORDERED_NODE_TYPE,
        null
      )
      return result.singleNodeValue instanceof Element ? result.singleNodeValue : null
    } catch {
      return null
    }
  }

  function getElementLabel(element) {
    let label = element.tagName.toLowerCase()
    if (element.id) label += `#${element.id}`
    if (element.className && typeof element.className === 'string') {
      const classes = element.className.split(' ').filter(Boolean).slice(0, 2)
      if (classes.length) {
        label += `.${classes.join('.')}`
      }
    }
    return label
  }

  function createHoverOverlay() {
    if (hoverOverlay || !document.body) return

    hoverOverlay = document.createElement('div')
    hoverOverlay.style.cssText = `
      position: fixed;
      pointer-events: none;
      border: 2px dashed #3b82f6;
      background: rgba(59, 130, 246, 0.1);
      z-index: 2147483646;
      transition: all 0.05s ease-out;
      display: none;
      border-radius: 2px;
    `
    document.body.appendChild(hoverOverlay)

    hoverLabel = document.createElement('div')
    hoverLabel.style.cssText = `
      position: fixed;
      background: #3b82f6;
      color: white;
      font-size: 11px;
      font-family: ui-monospace, monospace;
      padding: 2px 6px;
      border-radius: 2px;
      z-index: 2147483646;
      pointer-events: none;
      display: none;
      white-space: nowrap;
    `
    document.body.appendChild(hoverLabel)
  }

  function updateSelectionPosition(element, overlay, badge) {
    const rect = element.getBoundingClientRect()
    overlay.style.top = `${rect.top}px`
    overlay.style.left = `${rect.left}px`
    overlay.style.width = `${rect.width}px`
    overlay.style.height = `${rect.height}px`
    badge.style.top = `${rect.top - 9}px`
    badge.style.left = `${rect.right - 9}px`
  }

  function updateAllPositions() {
    selectedElements.forEach((entry) => {
      if (entry.element.isConnected) {
        updateSelectionPosition(entry.element, entry.overlay, entry.badge)
      }
    })
  }

  function normalizeGlobalIndex(value, fallbackIndex) {
    const numericValue = Number(value)
    if (Number.isFinite(numericValue) && numericValue > 0) {
      return Math.round(numericValue)
    }
    return fallbackIndex
  }

  function normalizeAppliedSelections(selections) {
    return (selections || []).flatMap((entry, index) => {
      if (typeof entry === 'string') {
        return [{
          xpath: entry,
          globalIndex: index + 1,
        }]
      }

      if (!entry || typeof entry !== 'object' || typeof entry.xpath !== 'string') {
        return []
      }

      return [{
        xpath: entry.xpath,
        globalIndex: normalizeGlobalIndex(entry.globalIndex, index + 1),
      }]
    })
  }

  function createSelectionOverlay(element, globalIndex) {
    const overlay = document.createElement('div')
    overlay.style.cssText = `
      position: fixed;
      pointer-events: none;
      border: 2px solid #22c55e;
      background: rgba(34, 197, 94, 0.15);
      z-index: 2147483645;
      border-radius: 2px;
      box-shadow: 0 0 0 1px rgba(34, 197, 94, 0.3);
    `
    document.body.appendChild(overlay)

    const badge = document.createElement('div')
    badge.textContent = String(globalIndex)
    badge.style.cssText = `
      position: fixed;
      background: #22c55e;
      color: white;
      font-size: 10px;
      font-family: ui-monospace, monospace;
      font-weight: bold;
      width: 18px;
      height: 18px;
      border-radius: 50%;
      display: flex;
      align-items: center;
      justify-content: center;
      z-index: 2147483647;
      pointer-events: none;
      box-shadow: 0 1px 3px rgba(0, 0, 0, 0.3);
    `
    document.body.appendChild(badge)

    updateSelectionPosition(element, overlay, badge)
    return { overlay, badge }
  }

  function hideHoverOverlay() {
    if (hoverOverlay) hoverOverlay.style.display = 'none'
    if (hoverLabel) hoverLabel.style.display = 'none'
    currentTarget = null
  }

  function getElementData(element) {
    return {
      outerHTML: element.outerHTML,
      innerHTML: element.innerHTML,
      tagName: element.tagName.toLowerCase(),
      elementId: element.id || null,
      classList: [...element.classList],
      xpath: getXPath(element),
      textContent: element.textContent?.slice(0, 200) || '',
      attributes: Array.from(element.attributes).map((attribute) => ({
        name: attribute.name,
        value: attribute.value,
      })),
      rect: element.getBoundingClientRect(),
      pageUrl: window.location.href,
      pageTitle: document.title || null,
    }
  }

  function selectedIndexFor(element) {
    const xpath = getXPath(element)
    return selectedElements.findIndex((entry) => entry.xpath === xpath)
  }

  function highlightElement(element) {
    createHoverOverlay()
    if (!hoverOverlay || !hoverLabel) return

    const rect = element.getBoundingClientRect()
    const selectedIndex = selectedIndexFor(element)
    if (selectedIndex >= 0) {
      hoverOverlay.style.borderColor = '#ef4444'
      hoverOverlay.style.background = 'rgba(239, 68, 68, 0.1)'
      hoverLabel.style.background = '#ef4444'
      hoverLabel.textContent = 'Click to deselect'
    } else {
      hoverOverlay.style.borderColor = '#3b82f6'
      hoverOverlay.style.background = 'rgba(59, 130, 246, 0.1)'
      hoverLabel.style.background = '#3b82f6'
      hoverLabel.textContent = getElementLabel(element)
    }

    hoverOverlay.style.top = `${rect.top}px`
    hoverOverlay.style.left = `${rect.left}px`
    hoverOverlay.style.width = `${rect.width}px`
    hoverOverlay.style.height = `${rect.height}px`
    hoverOverlay.style.display = 'block'

    hoverLabel.style.top = `${Math.max(0, rect.top - 20)}px`
    hoverLabel.style.left = `${rect.left}px`
    hoverLabel.style.display = 'block'
    currentTarget = element
  }

  function notifyLocationChange() {
    emit('browser-location-changed', {
      url: window.location.href,
      title: document.title || null,
    })
  }

  async function selectElement(element, notifyParent = true, globalIndex) {
    if (selectedElements.length >= MAX_SELECTIONS) {
      return
    }
    const xpath = getXPath(element)
    const resolvedGlobalIndex = normalizeGlobalIndex(globalIndex, selectedElements.length + 1)
    const { overlay, badge } = createSelectionOverlay(element, resolvedGlobalIndex)
    selectedElements.push({ element, xpath, overlay, badge, globalIndex: resolvedGlobalIndex })
    if (notifyParent) {
      emit('browser-element-selected', getElementData(element))
    }
  }

  async function deselectElement(index, notifyParent = true) {
    const selected = selectedElements[index]
    if (!selected) return
    selected.overlay.remove()
    selected.badge.remove()
    selectedElements.splice(index, 1)
    if (notifyParent) {
      emit('browser-element-deselected', {
        xpath: selected.xpath,
        index,
        pageUrl: window.location.href,
        pageTitle: document.title || null,
      })
    }
  }

  async function clearSelections(notifyParent = true) {
    selectedElements.forEach((selected) => {
      selected.overlay.remove()
      selected.badge.remove()
    })
    selectedElements = []
    if (notifyParent) {
      emit('browser-selection-cleared', {
        pageUrl: window.location.href,
        pageTitle: document.title || null,
      })
    }
  }

  async function applySelections(selections) {
    await clearSelections(false)
    for (const selection of normalizeAppliedSelections(selections)) {
      const element = findElementByXPath(selection.xpath)
      if (element) {
        await selectElement(element, false, selection.globalIndex)
      }
    }
  }

  async function handleClick(event) {
    if (!selectMode) return
    event.preventDefault()
    event.stopPropagation()
    event.stopImmediatePropagation()

    const element = currentTarget || event.target
    if (!(element instanceof Element)) {
      return false
    }

    const selectedIndex = selectedIndexFor(element)
    if (selectedIndex >= 0) {
      await deselectElement(selectedIndex)
    } else {
      await selectElement(element)
    }
    return false
  }

  function handleMouseMove(event) {
    if (!selectMode) return
    if (!(event.target instanceof Element)) return
    highlightElement(event.target)
  }

  function handleKeyDown(event) {
    if (event.key === 'Escape' && selectMode) {
      selectMode = false
      document.body.style.cursor = ''
      hideHoverOverlay()
      emit('browser-select-cancelled', {
        pageUrl: window.location.href,
        pageTitle: document.title || null,
      })
    }
  }

  const originalPushState = history.pushState.bind(history)
  history.pushState = function pushState(...args) {
    const result = originalPushState(...args)
    queueMicrotask(notifyLocationChange)
    return result
  }

  const originalReplaceState = history.replaceState.bind(history)
  history.replaceState = function replaceState(...args) {
    const result = originalReplaceState(...args)
    queueMicrotask(notifyLocationChange)
    return result
  }

  ipcRenderer.on('pixel-forge-preview:command', async (_event, command) => {
    if (command.type === 'set-select-mode') {
      selectMode = Boolean(command.enabled)
      if (selectMode) {
        createHoverOverlay()
        if (document.body) {
          document.body.style.cursor = 'crosshair'
        }
      } else if (document.body) {
        document.body.style.cursor = ''
        hideHoverOverlay()
      }
      return
    }

    if (command.type === 'clear-selections') {
      await clearSelections(false)
      return
    }

    if (command.type === 'deselect') {
      const index = selectedElements.findIndex((entry) => entry.xpath === command.xpath)
      if (index >= 0) {
        await deselectElement(index, false)
      }
      return
    }

    if (command.type === 'apply-selections') {
      await applySelections(
        Array.isArray(command.selections)
          ? command.selections
          : Array.isArray(command.xpaths)
            ? command.xpaths
            : []
      )
    }
  })

  document.addEventListener('mousemove', handleMouseMove, true)
  document.addEventListener('click', handleClick, true)
  document.addEventListener('keydown', handleKeyDown, true)
  document.addEventListener('mouseleave', hideHoverOverlay)
  window.addEventListener('hashchange', notifyLocationChange)
  window.addEventListener('popstate', notifyLocationChange)
  window.addEventListener('load', notifyLocationChange)
  window.addEventListener('scroll', updateAllPositions, true)
  window.addEventListener('resize', updateAllPositions)

  window.addEventListener('DOMContentLoaded', () => {
    const titleElement = document.querySelector('title')
    if (titleElement) {
      const titleObserver = new MutationObserver(() => notifyLocationChange())
      titleObserver.observe(titleElement, {
        childList: true,
        subtree: true,
        characterData: true,
      })
    }
    notifyLocationChange()
  })
}
