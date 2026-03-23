function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max)
}

function normalizeText(value, maxLength = 200) {
  return String(value || '').replace(/\s+/g, ' ').trim().slice(0, maxLength)
}

function normalizePageKey(rawUrl = window.location.href) {
  try {
    const url = new URL(rawUrl, window.location.href)
    return `${url.origin}${url.pathname}${url.hash || ''}`
  } catch {
    return String(rawUrl || '')
  }
}

function roundRect(rect) {
  return {
    x: Math.round(rect.x),
    y: Math.round(rect.y),
    width: Math.round(rect.width),
    height: Math.round(rect.height),
  }
}

function rectContainsPoint(rect, x, y) {
  return (
    x >= rect.left
    && x <= rect.right
    && y >= rect.top
    && y <= rect.bottom
  )
}

function toViewportRect(rect) {
  const left = clamp(rect.left, 0, window.innerWidth)
  const top = clamp(rect.top, 0, window.innerHeight)
  const right = clamp(rect.right, 0, window.innerWidth)
  const bottom = clamp(rect.bottom, 0, window.innerHeight)
  return {
    left,
    top,
    right,
    bottom,
    width: Math.max(0, right - left),
    height: Math.max(0, bottom - top),
    x: left,
    y: top,
  }
}

function generateSelectionId() {
  if (typeof crypto?.randomUUID === 'function') {
    return `selection-${crypto.randomUUID()}`
  }
  return `selection-${Math.random().toString(36).slice(2, 10)}${Date.now().toString(36)}`
}

function getSelectionAdapter() {
  const adapter = window.__pixelForgePdfSelectionAdapter
  if (!adapter || typeof adapter !== 'object') {
    return null
  }
  return adapter
}

function currentPageContext() {
  const adapter = getSelectionAdapter()
  const adapterContext =
    typeof adapter?.getPageContext === 'function'
      ? adapter.getPageContext()
      : null
  const pageUrl =
    typeof adapterContext?.pageUrl === 'string' && adapterContext.pageUrl
      ? adapterContext.pageUrl
      : window.location.href
  return {
    pageUrl,
    pageTitle:
      typeof adapterContext?.pageTitle === 'string'
        ? adapterContext.pageTitle
        : document.title || null,
    pageKey:
      typeof adapterContext?.pageKey === 'string' && adapterContext.pageKey
        ? adapterContext.pageKey
        : normalizePageKey(pageUrl),
  }
}

export function installSelectionBridge({ emit, captureRegion }) {
  if (window.__pixelForgeSelectionBridgeLoaded) {
    return
  }
  window.__pixelForgeSelectionBridgeLoaded = true

  let selectMode = false
  let hoverOverlay = null
  let hoverLabel = null
  let currentTarget = null
  let hoverTargets = []
  let hoverTargetIndex = 0
  let hoverClientX = 0
  let hoverClientY = 0
  let lastPointerElement = null
  let keyboardState = { ctrl: false, shift: false }
  let promotionSourceSelectionKey = null
  let selectedElements = []
  let desiredSelections = []
  let reconcileFrame = null
  let domObserver = null

  function previewOwnsInput() {
    return document.visibilityState === 'visible' && document.hasFocus()
  }

  function getXPath(element) {
    if (!element) return ''
    if (element.id) return `//*[@id="${element.id}"]`
    if (element === document.body) return '/html/body'

    let index = 0
    const siblings = element.parentNode ? element.parentNode.childNodes : []
    for (let i = 0; i < siblings.length; i += 1) {
      const sibling = siblings[i]
      if (sibling === element) {
        const parentPath = getXPath(element.parentNode)
        const tagName = element.tagName.toLowerCase()
        return `${parentPath}/${tagName}[${index + 1}]`
      }
      if (sibling.nodeType === 1 && sibling.tagName === element.tagName) {
        index += 1
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

  function createHoverOverlay() {
    if (hoverOverlay || !document.body) return

    hoverOverlay = document.createElement('div')
    hoverOverlay.setAttribute('data-pixel-forge-injected', 'true')
    hoverOverlay.style.cssText = `
      position: fixed;
      pointer-events: none;
      border: 2px dashed #3b82f6;
      background: rgba(59, 130, 246, 0.1);
      z-index: 2147483646;
      transition: all 0.05s ease-out;
      display: none;
      border-radius: 4px;
    `
    document.body.appendChild(hoverOverlay)

    hoverLabel = document.createElement('div')
    hoverLabel.setAttribute('data-pixel-forge-injected', 'true')
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

  function hideHoverOverlay() {
    if (hoverOverlay) hoverOverlay.style.display = 'none'
    if (hoverLabel) hoverLabel.style.display = 'none'
    currentTarget = null
    hoverTargets = []
    hoverTargetIndex = 0
    clearPromotionSourceHighlight()
  }

  function updateSelectionPosition(rect, overlay, badge) {
    overlay.style.top = `${rect.top}px`
    overlay.style.left = `${rect.left}px`
    overlay.style.width = `${rect.width}px`
    overlay.style.height = `${rect.height}px`
    badge.style.top = `${rect.top - 9}px`
    badge.style.left = `${rect.right - 9}px`
  }

  function updateAllPositions() {
    for (const entry of selectedElements) {
      const resolved = resolveSelection(entry.selection)
      if (!resolved) {
        continue
      }
      entry.lastRect = resolved.rect
      updateSelectionPosition(resolved.rect, entry.overlay, entry.badge)
    }
  }

  function normalizeGlobalIndex(value, fallbackIndex) {
    const numericValue = Number(value)
    if (Number.isFinite(numericValue) && numericValue > 0) {
      return Math.round(numericValue)
    }
    return fallbackIndex
  }

  function normalizeRegion(value) {
    if (!value || typeof value !== 'object') {
      return null
    }
    const region = value
    const numericKeys = [
      'x',
      'y',
      'width',
      'height',
      'normalizedX',
      'normalizedY',
      'normalizedWidth',
      'normalizedHeight',
      'anchorX',
      'anchorY',
    ]
    for (const key of numericKeys) {
      if (!Number.isFinite(Number(region[key]))) {
        return null
      }
    }
    return {
      x: Number(region.x),
      y: Number(region.y),
      width: Number(region.width),
      height: Number(region.height),
      normalizedX: Number(region.normalizedX),
      normalizedY: Number(region.normalizedY),
      normalizedWidth: Number(region.normalizedWidth),
      normalizedHeight: Number(region.normalizedHeight),
      anchorX: Number(region.anchorX),
      anchorY: Number(region.anchorY),
    }
  }

  function normalizeAppliedSelections(selections) {
    return (selections || []).flatMap((entry, index) => {
      if (typeof entry === 'string') {
        return [{
          id: entry,
          selectorKind: 'dom',
          surfaceKind: 'dom',
          pageKey: currentPageContext().pageKey,
          xpath: entry,
          globalIndex: index + 1,
          tagName: '',
          elementId: null,
          classList: [],
          textSample: '',
          rootXPath: null,
          rootTagName: null,
          rootElementId: null,
          rootClassList: [],
          region: null,
        }]
      }

      if (!entry || typeof entry !== 'object' || typeof entry.id !== 'string') {
        return []
      }

      const selectorKind = entry.selectorKind === 'region' ? 'region' : 'dom'
      return [{
        id: entry.id,
        selectorKind,
        surfaceKind: typeof entry.surfaceKind === 'string' ? entry.surfaceKind : selectorKind === 'region' ? 'unknown' : 'dom',
        pageKey: typeof entry.pageKey === 'string' && entry.pageKey ? entry.pageKey : currentPageContext().pageKey,
        xpath: typeof entry.xpath === 'string' ? entry.xpath : '',
        globalIndex: normalizeGlobalIndex(entry.globalIndex, index + 1),
        tagName: typeof entry.tagName === 'string' ? entry.tagName : '',
        elementId: typeof entry.elementId === 'string' ? entry.elementId : null,
        classList: Array.isArray(entry.classList) ? entry.classList.filter((value) => typeof value === 'string') : [],
        textSample: typeof entry.textSample === 'string' ? normalizeText(entry.textSample, 120) : '',
        pdfPage: Number.isFinite(Number(entry.pdfPage)) ? Math.round(Number(entry.pdfPage)) : null,
        pdfTextContent: typeof entry.pdfTextContent === 'string' ? normalizeText(entry.pdfTextContent, 400) : null,
        rootXPath: typeof entry.rootXPath === 'string' ? entry.rootXPath : null,
        rootTagName: typeof entry.rootTagName === 'string' ? entry.rootTagName : null,
        rootElementId: typeof entry.rootElementId === 'string' ? entry.rootElementId : null,
        rootClassList: Array.isArray(entry.rootClassList)
          ? entry.rootClassList.filter((value) => typeof value === 'string')
          : [],
        region: normalizeRegion(entry.region),
      }]
    })
  }

  function selectionKey(selection) {
    return String(selection?.id || selection?.xpath || '')
  }

  function setSelectionTone(overlay, badge, tone = 'selected') {
    const palette = tone === 'promotion'
      ? {
          border: '#f59e0b',
          background: 'rgba(245, 158, 11, 0.12)',
          shadow: 'rgba(245, 158, 11, 0.28)',
          badge: '#f59e0b',
        }
      : {
          border: '#22c55e',
          background: 'rgba(34, 197, 94, 0.15)',
          shadow: 'rgba(34, 197, 94, 0.3)',
          badge: '#22c55e',
        }

    overlay.style.borderColor = palette.border
    overlay.style.background = palette.background
    overlay.style.boxShadow = `0 0 0 1px ${palette.shadow}`
    badge.style.background = palette.badge
  }

  function clearPromotionSourceHighlight() {
    if (!promotionSourceSelectionKey) {
      return
    }

    const entry = selectedElements.find(
      (selected) => selected.selectionKey === promotionSourceSelectionKey
    )
    if (entry) {
      setSelectionTone(entry.overlay, entry.badge, 'selected')
    }
    promotionSourceSelectionKey = null
  }

  function highlightPromotionSource(selectionKeyValue) {
    if (!selectionKeyValue) {
      clearPromotionSourceHighlight()
      return
    }

    if (promotionSourceSelectionKey && promotionSourceSelectionKey !== selectionKeyValue) {
      clearPromotionSourceHighlight()
    }

    const entry = selectedElements.find(
      (selected) => selected.selectionKey === selectionKeyValue
    )
    if (!entry) {
      promotionSourceSelectionKey = null
      return
    }

    setSelectionTone(entry.overlay, entry.badge, 'promotion')
    promotionSourceSelectionKey = selectionKeyValue
  }

  function isElementVisiblyRenderable(element) {
    if (!(element instanceof Element) || !element.isConnected) {
      return false
    }

    const style = window.getComputedStyle(element)
    if (style.display === 'none' || style.visibility === 'hidden') {
      return false
    }

    const rect = element.getBoundingClientRect()
    return rect.width > 0 && rect.height > 0
  }

  function matchesDomFingerprint(element, selection) {
    if (!(element instanceof Element)) {
      return false
    }

    if (selection.pageKey && selection.pageKey !== normalizePageKey()) {
      return false
    }

    if (selection.tagName && element.tagName.toLowerCase() !== selection.tagName) {
      return false
    }

    if (selection.elementId && element.id !== selection.elementId) {
      return false
    }

    if (selection.classList.length > 0) {
      const matchedClasses = selection.classList.filter((className) => element.classList.contains(className)).length
      if (!selection.elementId && matchedClasses === 0) {
        return false
      }
    }

    const expectedText = normalizeText(selection.textSample, 120)
    if (expectedText) {
      const actualText = normalizeText(element.textContent, 120)
      const expectedPrefix = expectedText.slice(0, 48)
      if (!actualText || !actualText.includes(expectedPrefix)) {
        return false
      }
    }

    return isElementVisiblyRenderable(element)
  }

  function matchesRegionFingerprint(element, selection) {
    if (!(element instanceof Element) || !selection.region) {
      return false
    }

    if (selection.pageKey && selection.pageKey !== normalizePageKey()) {
      return false
    }

    if (selection.rootTagName && element.tagName.toLowerCase() !== selection.rootTagName) {
      return false
    }

    if (selection.rootElementId && element.id !== selection.rootElementId) {
      return false
    }

    if (selection.rootClassList.length > 0) {
      const matchedClasses = selection.rootClassList.filter((className) => element.classList.contains(className)).length
      if (!selection.rootElementId && matchedClasses === 0) {
        return false
      }
    }

    return isElementVisiblyRenderable(element)
  }

  function computeRegionRect(rootRect, region) {
    const width = Math.max(1, rootRect.width * region.normalizedWidth)
    const height = Math.max(1, rootRect.height * region.normalizedHeight)
    const left = rootRect.left + rootRect.width * region.normalizedX
    const top = rootRect.top + rootRect.height * region.normalizedY
    return {
      left,
      top,
      right: left + width,
      bottom: top + height,
      width,
      height,
    }
  }

  function resolveSelection(selection) {
    const adapter = getSelectionAdapter()
    if (selection.surfaceKind === 'pdf' && typeof adapter?.resolveSelection === 'function') {
      return adapter.resolveSelection(selection, {
        findElementByXPath,
        normalizeText,
      })
    }

    if (selection.selectorKind === 'region') {
      if (!selection.rootXPath || !selection.region) {
        return null
      }
      const hintedRootElement =
        selection.__pixelForgeResolvedElement instanceof Element
          ? selection.__pixelForgeResolvedElement
          : null
      if (matchesRegionFingerprint(hintedRootElement, selection)) {
        const rect = computeRegionRect(hintedRootElement.getBoundingClientRect(), selection.region)
        if (rect.width > 0 && rect.height > 0) {
          return { element: hintedRootElement, rect }
        }
      }
      const rootElement = findElementByXPath(selection.rootXPath)
      if (!matchesRegionFingerprint(rootElement, selection)) {
        return null
      }
      const rect = computeRegionRect(rootElement.getBoundingClientRect(), selection.region)
      if (rect.width <= 0 || rect.height <= 0) {
        return null
      }
      return { element: rootElement, rect }
    }

    const hintedElement =
      selection.__pixelForgeResolvedElement instanceof Element
        ? selection.__pixelForgeResolvedElement
        : null
    if (matchesDomFingerprint(hintedElement, selection)) {
      return { element: hintedElement, rect: hintedElement.getBoundingClientRect() }
    }

    const element = findElementByXPath(selection.xpath)
    if (!element || !matchesDomFingerprint(element, selection)) {
      return null
    }

    return { element, rect: element.getBoundingClientRect() }
  }

  function removeRenderedSelection(entry) {
    entry.overlay.remove()
    entry.badge.remove()
  }

  function shouldIgnoreMutationNode(node) {
    return node instanceof Element && node.hasAttribute('data-pixel-forge-injected')
  }

  function createSelectionOverlay(rect, globalIndex) {
    const overlay = document.createElement('div')
    overlay.setAttribute('data-pixel-forge-injected', 'true')
    overlay.style.cssText = `
      position: fixed;
      pointer-events: none;
      z-index: 2147483645;
      border-radius: 4px;
    `
    document.body.appendChild(overlay)

    const badge = document.createElement('div')
    badge.setAttribute('data-pixel-forge-injected', 'true')
    badge.textContent = String(globalIndex)
    badge.style.cssText = `
      position: fixed;
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

    setSelectionTone(overlay, badge, 'selected')
    updateSelectionPosition(rect, overlay, badge)
    return { overlay, badge }
  }

  async function capturePreviewData(rect) {
    if (typeof captureRegion !== 'function') {
      return null
    }

    const clipped = toViewportRect(rect)
    if (clipped.width < 4 || clipped.height < 4) {
      return null
    }

    try {
      return await captureRegion(roundRect(clipped))
    } catch (error) {
      console.warn('[pixel-forge] Failed to capture selection region', error)
      return null
    }
  }

  function detectCanvasSurfaceType(canvas) {
    if (!(canvas instanceof HTMLCanvasElement)) {
      return 'canvas'
    }
    try {
      if (canvas.getContext('webgl2') || canvas.getContext('webgl') || canvas.getContext('experimental-webgl')) {
        return 'webgl'
      }
    } catch {
      return 'canvas'
    }
    return 'canvas'
  }

  function detectSurfaceKind(element) {
    const adapter = getSelectionAdapter()
    if (typeof adapter?.getSurfaceKind === 'function') {
      const adapterSurfaceKind = adapter.getSurfaceKind(element)
      if (typeof adapterSurfaceKind === 'string' && adapterSurfaceKind) {
        return adapterSurfaceKind
      }
    }

    if (element instanceof SVGElement) {
      return 'svg'
    }
    if (element instanceof HTMLCanvasElement) {
      return detectCanvasSurfaceType(element)
    }
    if (element instanceof HTMLVideoElement) {
      return 'video'
    }
    if (element instanceof HTMLImageElement) {
      return 'image'
    }
    return 'dom'
  }

  function getElementLabel(element) {
    if (!(element instanceof Element)) {
      return 'element'
    }

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

  function getElementParent(element) {
    if (!(element instanceof Element)) {
      return null
    }

    if (element.parentElement instanceof Element) {
      return element.parentElement
    }

    const root = typeof element.getRootNode === 'function'
      ? element.getRootNode()
      : null
    if (root instanceof ShadowRoot && root.host instanceof Element) {
      return root.host
    }

    return null
  }

  function getAncestorTargets(element) {
    const targets = []
    let current = element

    while (current instanceof Element) {
      if (
        !current.hasAttribute('data-pixel-forge-injected')
        && isElementVisiblyRenderable(current)
      ) {
        targets.push(current)
      }
      current = getElementParent(current)
    }

    return targets
  }

  function buildHoverLabel(label) {
    if (hoverTargets.length <= 1) {
      return label
    }
    return `${label} ${hoverTargetIndex + 1}/${hoverTargets.length}`
  }

  function setCurrentHoverTarget(element) {
    if (!(element instanceof Element)) {
      hideHoverOverlay()
      return
    }

    const classification = classifySelectionTarget(element)
    currentTarget = {
      element,
      selectorKind: classification.selectorKind,
      hoverRect: classification.hoverRect,
      label: buildHoverLabel(classification.label),
      clientX: hoverClientX,
      clientY: hoverClientY,
      promotionSourceSelectionId: null,
    }
    highlightCandidate(currentTarget)
  }

  function setHoverTarget(element, clientX, clientY) {
    hoverClientX = clientX
    hoverClientY = clientY
    hoverTargets = getAncestorTargets(element)
    hoverTargetIndex = 0
    setCurrentHoverTarget(hoverTargets[0] || element)
  }

  function cycleHoverTarget() {
    if (hoverTargets.length <= 1) {
      return false
    }

    const nextIndex = Math.min(hoverTargetIndex + 1, hoverTargets.length - 1)
    if (nextIndex === hoverTargetIndex) {
      return false
    }

    hoverTargetIndex = nextIndex
    setCurrentHoverTarget(hoverTargets[hoverTargetIndex])
    return true
  }

  function getRenderedSelectionEntryAtPoint(element, clientX, clientY) {
    const index = findRenderedSelectionIndex(element, clientX, clientY)
    if (index < 0) {
      return null
    }
    return {
      entry: selectedElements[index],
      index,
    }
  }

  function buildPromotionCandidate(entry, clientX, clientY) {
    if (!entry || entry.selection.selectorKind !== 'dom') {
      return null
    }

    const baseElement = entry.element instanceof Element
      ? entry.element
      : resolveSelection(entry.selection)?.element
    if (!(baseElement instanceof Element)) {
      return null
    }

    const ancestors = getAncestorTargets(baseElement)
    const nextAncestor = ancestors[1]
    if (!(nextAncestor instanceof Element)) {
      return null
    }

    const classification = classifySelectionTarget(nextAncestor)
    const targetElement =
      classification.selectorKind === 'region' && classification.surfaceElement
        ? classification.surfaceElement
        : nextAncestor

    return {
      element: targetElement,
      selectorKind: classification.selectorKind,
      hoverRect: classification.hoverRect,
      label: `Promote to ${classification.label}`,
      clientX,
      clientY,
      promotionSourceSelectionId: entry.selection.id,
    }
  }

  function refreshHoverTargetFromPointer() {
    if (!selectMode || !(lastPointerElement instanceof Element)) {
      clearPromotionSourceHighlight()
      return
    }

    if (keyboardState.ctrl && keyboardState.shift) {
      const selectedMatch = getRenderedSelectionEntryAtPoint(
        lastPointerElement,
        hoverClientX,
        hoverClientY
      )

      if (selectedMatch) {
        const promotionCandidate = buildPromotionCandidate(
          selectedMatch.entry,
          hoverClientX,
          hoverClientY
        )
        if (promotionCandidate) {
          highlightPromotionSource(selectedMatch.entry.selectionKey)
          currentTarget = promotionCandidate
          highlightCandidate(promotionCandidate)
          return
        }
      }
    }

    clearPromotionSourceHighlight()
    setHoverTarget(lastPointerElement, hoverClientX, hoverClientY)
  }

  function isMeaningfulDomElement(element) {
    if (!(element instanceof Element)) {
      return false
    }

    if (element instanceof HTMLCanvasElement || element instanceof HTMLVideoElement) {
      return false
    }

    if (element instanceof SVGElement) {
      return true
    }

    const tagName = element.tagName.toLowerCase()
    if (['button', 'input', 'textarea', 'select', 'label', 'a'].includes(tagName)) {
      return true
    }

    const text = normalizeText(element.textContent, 80)
    if (text) {
      return true
    }

    if (element.id || element.classList.length > 0) {
      const rect = element.getBoundingClientRect()
      const viewportArea = window.innerWidth * window.innerHeight
      const elementArea = rect.width * rect.height
      return elementArea < viewportArea * 0.92
    }

    return false
  }

  function isElementVisibleInViewport(element) {
    if (!(element instanceof Element) || !isElementVisiblyRenderable(element)) {
      return false
    }

    const rect = element.getBoundingClientRect()
    return rect.bottom > 0
      && rect.right > 0
      && rect.top < window.innerHeight
      && rect.left < window.innerWidth
  }

  function isElementInteractive(element) {
    if (!(element instanceof Element)) {
      return false
    }

    const tagName = element.tagName.toLowerCase()
    if (['button', 'summary', 'select', 'textarea'].includes(tagName)) {
      return true
    }
    if (tagName === 'a' && element.hasAttribute('href')) {
      return true
    }
    if (tagName === 'input') {
      const inputType = String(element.getAttribute('type') || '').toLowerCase()
      return inputType !== 'hidden'
    }

    const role = String(element.getAttribute('role') || '').toLowerCase()
    if (
      ['button', 'link', 'menuitem', 'option', 'switch', 'tab', 'checkbox', 'radio'].includes(role)
    ) {
      return true
    }

    const tabIndex = Number(element.getAttribute('tabindex'))
    return Number.isFinite(tabIndex) && tabIndex >= 0
  }

  function getElementTextCandidates(element) {
    if (!(element instanceof Element)) {
      return []
    }

    return [
      normalizeText(element.getAttribute('aria-label')),
      normalizeText(element.getAttribute('aria-labelledby')
        ? document.getElementById(String(element.getAttribute('aria-labelledby') || ''))?.textContent
        : ''),
      normalizeText(element.innerText, 200),
      normalizeText(element.textContent, 200),
      normalizeText(element.getAttribute('value')),
      normalizeText(element.getAttribute('placeholder')),
      normalizeText(element.getAttribute('title')),
      normalizeText(element.getAttribute('alt')),
    ].filter(Boolean)
  }

  function getInteractiveLabel(element) {
    return getElementTextCandidates(element)[0] || ''
  }

  function buildBoundingBox(rect) {
    return {
      x: Math.round(rect.left),
      y: Math.round(rect.top),
      width: Math.round(rect.width),
      height: Math.round(rect.height),
    }
  }

  function getFirstPresentStateAttribute(element) {
    if (!(element instanceof Element)) {
      return null
    }

    const orderedAttributes = [
      'aria-selected',
      'aria-expanded',
      'aria-checked',
      'data-state',
      'value',
      'checked',
    ]
    for (const name of orderedAttributes) {
      if (name === 'checked' && 'checked' in element) {
        return {
          name,
          value: Boolean(element.checked),
        }
      }
      const attributeValue = element.getAttribute(name)
      if (attributeValue !== null) {
        return {
          name,
          value: attributeValue,
        }
      }
    }
    return null
  }

  function collectVisibleInteractiveElements(root, limit = 10) {
    if (!(root instanceof Element) || limit <= 0) {
      return []
    }

    const results = []
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT)
    while (results.length < limit) {
      const nextNode = walker.nextNode()
      if (!(nextNode instanceof Element)) {
        break
      }
      if (!isElementInteractive(nextNode) || !isElementVisibleInViewport(nextNode)) {
        continue
      }
      results.push(nextNode)
    }
    return results
  }

  function buildInteractiveDescriptor(element) {
    if (!(element instanceof Element)) {
      return null
    }

    return {
      tag_name: element.tagName.toLowerCase(),
      role: normalizeText(element.getAttribute('role')),
      text: getInteractiveLabel(element) || null,
      aria_label: normalizeText(element.getAttribute('aria-label')),
      xpath: getXPath(element),
      bounding_box: buildBoundingBox(element.getBoundingClientRect()),
    }
  }

  function countVisibleInteractiveDescendants(root, limit = 200) {
    return collectVisibleInteractiveElements(root, limit).length
  }

  function findMeaningfulContainer(element) {
    let current = element instanceof Element ? element : null
    while (current instanceof Element) {
      if (isElementVisibleInViewport(current)) {
        const interactiveCount = countVisibleInteractiveDescendants(current, 200)
        if (interactiveCount >= 2) {
          return current
        }
      }
      current = getElementParent(current)
    }
    return element instanceof Element ? element : null
  }

  function buildElementSummary(element) {
    if (!(element instanceof Element)) {
      return null
    }

    const container = findMeaningfulContainer(element)
    const containerInteractives = container instanceof Element
      ? collectVisibleInteractiveElements(container, 12)
      : []
    return {
      tag_name: element.tagName.toLowerCase(),
      xpath: getXPath(element),
      text_excerpt: normalizeText(element.textContent, 200) || null,
      bounding_box: buildBoundingBox(element.getBoundingClientRect()),
      first_state_attribute: getFirstPresentStateAttribute(element),
      closest_container: container instanceof Element
        ? {
            tag_name: container.tagName.toLowerCase(),
            xpath: getXPath(container),
            text_excerpt: normalizeText(container.textContent, 200) || null,
            bounding_box: buildBoundingBox(container.getBoundingClientRect()),
            interactive_descendant_count: countVisibleInteractiveDescendants(container, 200),
            interactive_descendants: containerInteractives
              .map((candidate) => buildInteractiveDescriptor(candidate))
              .filter(Boolean)
              .slice(0, 6),
            first_state_attribute: getFirstPresentStateAttribute(container),
          }
        : null,
    }
  }

  function inspectSelectionHints(selectionHints) {
    const normalizedHints = normalizeAppliedSelections(
      Array.isArray(selectionHints)
        ? selectionHints.map((hint) => ({
            id: hint?.id,
            selectorKind: hint?.selectorKind,
            surfaceKind: hint?.surfaceKind,
            pageKey: hint?.pageKey,
            xpath: hint?.xpath,
            globalIndex: hint?.globalIndex,
            tagName: hint?.tagName,
            elementId: hint?.elementId,
            classList: hint?.classList,
            textSample: hint?.textContent,
            pdfPage: hint?.pdfPage,
            pdfTextContent: hint?.pdfTextContent,
            rootXPath: hint?.rootXPath,
            rootTagName: hint?.rootTagName,
            rootElementId: hint?.rootElementId,
            rootClassList: hint?.rootClassList,
            region: hint?.region,
          }))
        : []
    )

    return normalizedHints.map((selection) => {
      const resolved = resolveSelection(selection)
      if (!resolved) {
        return {
          selection_id: selection.id || null,
          found: false,
          visible: false,
        }
      }

      return {
        selection_id: selection.id || null,
        found: true,
        visible: isElementVisibleInViewport(resolved.element),
        selector_kind: selection.selectorKind,
        surface_kind: selection.surfaceKind,
        ...(resolved.summary || buildElementSummary(resolved.element)),
      }
    })
  }

  async function inspectLiveContext(payload = {}) {
    const pageContext = currentPageContext()
    const selectionHints = Array.isArray(payload?.selectionHints)
      ? payload.selectionHints
      : []
    const visibleInteractives = collectVisibleInteractiveElements(document.body, 8)
      .map((element) => buildInteractiveDescriptor(element))
      .filter(Boolean)
    const adapter = getSelectionAdapter()
    const adapterMetadata =
      typeof adapter?.inspectContextMetadata === 'function'
        ? adapter.inspectContextMetadata()
        : null

    return {
      live_inspection_available: true,
      live_inspection_mode: 'controller-browserview',
      current_url: pageContext.pageUrl,
      current_title: pageContext.pageTitle || pageContext.pageUrl,
      ready_state: document.readyState,
      viewport: {
        width: Math.round(window.innerWidth),
        height: Math.round(window.innerHeight),
        scroll_x: Math.round(window.scrollX),
        scroll_y: Math.round(window.scrollY),
      },
      ...(adapterMetadata && typeof adapterMetadata === 'object' ? adapterMetadata : {}),
      visible_interactives: visibleInteractives,
      selection_matches: inspectSelectionHints(selectionHints),
    }
  }

  function findRegionSurface(element) {
    const adapter = getSelectionAdapter()
    if (typeof adapter?.findRegionSurface === 'function') {
      const adapterSurface = adapter.findRegionSurface(element)
      if (adapterSurface instanceof Element) {
        return adapterSurface
      }
    }

    let current = element
    while (current instanceof Element && current !== document.body) {
      if (
        current instanceof HTMLCanvasElement
        || current instanceof HTMLVideoElement
        || current instanceof HTMLImageElement
      ) {
        return current
      }
      current = current.parentElement
    }
    return null
  }

  function classifySelectionTarget(element) {
    const adapter = getSelectionAdapter()
    if (typeof adapter?.classifySelectionTarget === 'function') {
      const adapterClassification = adapter.classifySelectionTarget(element)
      if (adapterClassification && typeof adapterClassification === 'object') {
        return adapterClassification
      }
    }

    const regionSurface = findRegionSurface(element)
    if (!regionSurface) {
      return {
        selectorKind: 'dom',
        surfaceElement: null,
        hoverRect: element.getBoundingClientRect(),
        label: getElementLabel(element),
      }
    }

    const regionRect = regionSurface.getBoundingClientRect()
    const elementRect = element.getBoundingClientRect()
    const regionArea = regionRect.width * regionRect.height
    const elementArea = elementRect.width * elementRect.height
    const shouldUseRegion =
      element === regionSurface
      || !isMeaningfulDomElement(element)
      || elementArea >= regionArea * 0.8

    if (shouldUseRegion) {
      return {
        selectorKind: 'region',
        surfaceElement: regionSurface,
        hoverRect: regionRect,
        label: `${detectSurfaceKind(regionSurface)} region`,
      }
    }

    return {
      selectorKind: 'dom',
      surfaceElement: null,
      hoverRect: elementRect,
      label: getElementLabel(element),
    }
  }

  async function buildDomSelection(element, selectionId = generateSelectionId()) {
    const adapter = getSelectionAdapter()
    if (typeof adapter?.buildSelectionDescriptor === 'function') {
      const adapterSelection = await adapter.buildSelectionDescriptor(
        element,
        null,
        null,
        selectionId,
        {
          capturePreviewData,
          getXPath,
          normalizeText,
          pageContext: currentPageContext(),
        },
      )
      if (adapterSelection) {
        return adapterSelection
      }
    }

    const pageContext = currentPageContext()
    const rect = element.getBoundingClientRect()
    return {
      id: selectionId,
      selectorKind: 'dom',
      surfaceKind: detectSurfaceKind(element),
      pageKey: pageContext.pageKey,
      tagName: element.tagName.toLowerCase(),
      elementId: element.id || null,
      classList: [...element.classList],
      textContent: normalizeText(element.textContent, 200),
      xpath: getXPath(element),
      outerHTML: element.outerHTML,
      rootXPath: null,
      rootTagName: null,
      rootElementId: null,
      rootClassList: [],
      region: null,
      previewDataUrl: await capturePreviewData(rect),
      pageUrl: pageContext.pageUrl,
      pageTitle: pageContext.pageTitle,
      selectionId,
      __pixelForgeResolvedElement: element,
    }
  }

  function buildRegionBounds(surfaceElement, clientX, clientY) {
    const surfaceRect = surfaceElement.getBoundingClientRect()
    const width = clamp(Math.min(surfaceRect.width * 0.3, 320), 96, surfaceRect.width)
    const height = clamp(Math.min(surfaceRect.height * 0.24, 240), 72, surfaceRect.height)
    const left = clamp(
      clientX - width / 2,
      surfaceRect.left,
      Math.max(surfaceRect.left, surfaceRect.right - width)
    )
    const top = clamp(
      clientY - height / 2,
      surfaceRect.top,
      Math.max(surfaceRect.top, surfaceRect.bottom - height)
    )
    return {
      left,
      top,
      right: left + width,
      bottom: top + height,
      width,
      height,
    }
  }

  async function buildRegionSelection(surfaceElement, clientX, clientY, selectionId = generateSelectionId()) {
    const adapter = getSelectionAdapter()
    if (typeof adapter?.buildSelectionDescriptor === 'function') {
      const adapterSelection = await adapter.buildSelectionDescriptor(
        surfaceElement,
        clientX,
        clientY,
        selectionId,
        {
          buildRegionBounds,
          capturePreviewData,
          getXPath,
          normalizeText,
          pageContext: currentPageContext(),
        },
      )
      if (adapterSelection) {
        return adapterSelection
      }
    }

    const pageContext = currentPageContext()
    const surfaceRect = surfaceElement.getBoundingClientRect()
    const regionRect = buildRegionBounds(surfaceElement, clientX, clientY)
    const region = {
      x: Math.round(regionRect.left - surfaceRect.left),
      y: Math.round(regionRect.top - surfaceRect.top),
      width: Math.round(regionRect.width),
      height: Math.round(regionRect.height),
      normalizedX: Number(((regionRect.left - surfaceRect.left) / Math.max(surfaceRect.width, 1)).toFixed(6)),
      normalizedY: Number(((regionRect.top - surfaceRect.top) / Math.max(surfaceRect.height, 1)).toFixed(6)),
      normalizedWidth: Number((regionRect.width / Math.max(surfaceRect.width, 1)).toFixed(6)),
      normalizedHeight: Number((regionRect.height / Math.max(surfaceRect.height, 1)).toFixed(6)),
      anchorX: Number(((clientX - surfaceRect.left) / Math.max(surfaceRect.width, 1)).toFixed(6)),
      anchorY: Number(((clientY - surfaceRect.top) / Math.max(surfaceRect.height, 1)).toFixed(6)),
    }

    return {
      id: selectionId,
      selectorKind: 'region',
      surfaceKind: detectSurfaceKind(surfaceElement),
      pageKey: pageContext.pageKey,
      tagName: surfaceElement.tagName.toLowerCase(),
      elementId: null,
      classList: [],
      textContent: '',
      xpath: '',
      outerHTML: surfaceElement.outerHTML,
      rootXPath: getXPath(surfaceElement),
      rootTagName: surfaceElement.tagName.toLowerCase(),
      rootElementId: surfaceElement.id || null,
      rootClassList: [...surfaceElement.classList],
      region,
      previewDataUrl: await capturePreviewData(regionRect),
      pageUrl: pageContext.pageUrl,
      pageTitle: pageContext.pageTitle,
      selectionId,
      __pixelForgeResolvedElement: surfaceElement,
    }
  }

  async function buildSelectionDescriptor(element, clientX, clientY, selectionId = generateSelectionId()) {
    const adapter = getSelectionAdapter()
    if (typeof adapter?.buildSelectionDescriptor === 'function') {
      const adapterSelection = await adapter.buildSelectionDescriptor(
        element,
        clientX,
        clientY,
        selectionId,
        {
          buildRegionBounds,
          capturePreviewData,
          getXPath,
          normalizeText,
          pageContext: currentPageContext(),
        },
      )
      if (adapterSelection) {
        return adapterSelection
      }
    }

    const classification = classifySelectionTarget(element)
    if (classification.selectorKind === 'region' && classification.surfaceElement) {
      return buildRegionSelection(classification.surfaceElement, clientX, clientY, selectionId)
    }
    return buildDomSelection(element, selectionId)
  }

  function findRenderedSelectionIndex(element, clientX, clientY) {
    const xpath = getXPath(element)
    for (let index = selectedElements.length - 1; index >= 0; index -= 1) {
      const entry = selectedElements[index]
      if (entry.selection.selectorKind === 'region' || entry.selection.surfaceKind === 'pdf') {
        if (entry.lastRect && rectContainsPoint(entry.lastRect, clientX, clientY)) {
          return index
        }
        if (entry.selection.selectorKind === 'region') {
          continue
        }
      }
      if (entry.xpath === xpath) {
        return index
      }
    }
    return -1
  }

  function scheduleSelectionReconcile() {
    if (reconcileFrame !== null) {
      return
    }

    reconcileFrame = window.requestAnimationFrame(() => {
      reconcileFrame = null
      reconcileDesiredSelections()
    })
  }

  function reconcileDesiredSelections() {
    const desiredByKey = new Map(desiredSelections.map((selection) => [selectionKey(selection), selection]))
    const nextRenderedSelections = []

    for (const entry of selectedElements) {
      const desiredSelection = desiredByKey.get(entry.selectionKey)
      if (!desiredSelection) {
        removeRenderedSelection(entry)
        continue
      }

      const resolved = resolveSelection(desiredSelection)
      if (!resolved) {
        removeRenderedSelection(entry)
        continue
      }

      if (entry.element !== resolved.element) {
        removeRenderedSelection(entry)
        continue
      }

      entry.selection = desiredSelection
      entry.globalIndex = normalizeGlobalIndex(desiredSelection.globalIndex, entry.globalIndex)
      entry.badge.textContent = String(entry.globalIndex)
      entry.lastRect = resolved.rect
      updateSelectionPosition(resolved.rect, entry.overlay, entry.badge)
      nextRenderedSelections.push(entry)
    }

    selectedElements = nextRenderedSelections

    for (const desiredSelection of desiredSelections) {
      const key = selectionKey(desiredSelection)
      if (selectedElements.some((entry) => entry.selectionKey === key)) {
        continue
      }

      const resolved = resolveSelection(desiredSelection)
      if (!resolved) {
        continue
      }

      const { overlay, badge } = createSelectionOverlay(
        resolved.rect,
        normalizeGlobalIndex(desiredSelection.globalIndex, selectedElements.length + 1)
      )

      selectedElements.push({
        selectionKey: key,
        selection: desiredSelection,
        element: resolved.element,
        xpath: desiredSelection.xpath,
        overlay,
        badge,
        lastRect: resolved.rect,
        globalIndex: normalizeGlobalIndex(desiredSelection.globalIndex, selectedElements.length + 1),
      })
    }
  }

  function highlightCandidate(candidate) {
    createHoverOverlay()
    if (!hoverOverlay || !hoverLabel) return

    if (candidate.promotionSourceSelectionId) {
      hoverOverlay.style.borderColor = '#f59e0b'
      hoverOverlay.style.background = 'rgba(245, 158, 11, 0.12)'
      hoverLabel.style.background = '#f59e0b'
      hoverLabel.textContent = candidate.label
    } else {
      const selectedIndex = candidate.selectorKind === 'region'
        ? selectedElements.findIndex((entry) => entry.lastRect && rectContainsPoint(entry.lastRect, candidate.clientX, candidate.clientY))
        : findRenderedSelectionIndex(candidate.element, candidate.clientX, candidate.clientY)

      if (selectedIndex >= 0) {
        hoverOverlay.style.borderColor = '#ef4444'
        hoverOverlay.style.background = 'rgba(239, 68, 68, 0.1)'
        hoverLabel.style.background = '#ef4444'
        hoverLabel.textContent = 'Click to deselect'
      } else {
        hoverOverlay.style.borderColor = '#3b82f6'
        hoverOverlay.style.background = 'rgba(59, 130, 246, 0.1)'
        hoverLabel.style.background = '#3b82f6'
        hoverLabel.textContent = candidate.label
      }
    }

    hoverOverlay.style.top = `${candidate.hoverRect.top}px`
    hoverOverlay.style.left = `${candidate.hoverRect.left}px`
    hoverOverlay.style.width = `${candidate.hoverRect.width}px`
    hoverOverlay.style.height = `${candidate.hoverRect.height}px`
    hoverOverlay.style.display = 'block'
    hoverLabel.style.top = `${Math.max(0, candidate.hoverRect.top - 20)}px`
    hoverLabel.style.left = `${candidate.hoverRect.left}px`
    hoverLabel.style.display = 'block'
  }

  function notifyLocationChange() {
    const pageContext = currentPageContext()
    emit('browser-location-changed', {
      url: pageContext.pageUrl,
      title: pageContext.pageTitle,
    })
  }

  async function emitSelectionEvent(type, selection, extra = {}) {
    const pageContext = currentPageContext()
    await emit(type, {
      ...extra,
      selectionId: selection.id,
      selectorKind: selection.selectorKind,
      surfaceKind: selection.surfaceKind,
      pageKey: selection.pageKey,
      outerHTML: selection.outerHTML,
      tagName: selection.tagName,
      elementId: selection.elementId,
      classList: selection.classList,
      textContent: selection.textContent,
      xpath: selection.xpath,
      rootXPath: selection.rootXPath,
      rootTagName: selection.rootTagName,
      rootElementId: selection.rootElementId,
      rootClassList: selection.rootClassList,
      region: selection.region,
      pdfPage: selection.pdfPage ?? null,
      pdfTextContent: selection.pdfTextContent ?? null,
      previewDataUrl: selection.previewDataUrl,
      pageUrl: selection.pageUrl || pageContext.pageUrl,
      pageTitle: selection.pageTitle ?? pageContext.pageTitle,
    })
  }

  async function selectResolvedSelection(selection, notifyParent = true) {
    const resolved = resolveSelection(selection)
    if (!resolved) {
      return
    }

    const globalIndex = normalizeGlobalIndex(selection.globalIndex, selectedElements.length + 1)
    const { overlay, badge } = createSelectionOverlay(resolved.rect, globalIndex)
    selectedElements.push({
      selectionKey: selectionKey(selection),
      selection,
      element: resolved.element,
      xpath: selection.xpath,
      overlay,
      badge,
      lastRect: resolved.rect,
      globalIndex,
    })

    if (notifyParent) {
      await emitSelectionEvent('browser-element-selected', selection)
    }
  }

  async function replaceResolvedSelection(index, selection, notifyParent = true) {
    const selected = selectedElements[index]
    if (!selected) {
      return
    }

    const resolved = resolveSelection(selection)
    if (!resolved) {
      return
    }

    removeRenderedSelection(selected)
    const globalIndex = selected.globalIndex
    const { overlay, badge } = createSelectionOverlay(resolved.rect, globalIndex)

    selectedElements[index] = {
      selectionKey: selectionKey(selection),
      selection,
      element: resolved.element,
      xpath: selection.xpath,
      overlay,
      badge,
      lastRect: resolved.rect,
      globalIndex,
    }

    if (notifyParent) {
      await emitSelectionEvent('browser-element-updated', selection)
    }
  }

  async function deselectElement(index, notifyParent = true) {
    const selected = selectedElements[index]
    if (!selected) return
    if (selected.selectionKey === promotionSourceSelectionKey) {
      promotionSourceSelectionKey = null
    }
    removeRenderedSelection(selected)
    selectedElements.splice(index, 1)
    if (notifyParent) {
      await emitSelectionEvent('browser-element-deselected', selected.selection)
    }
  }

  async function clearSelections(notifyParent = true) {
    desiredSelections = []
    promotionSourceSelectionKey = null
    for (const selected of selectedElements) {
      removeRenderedSelection(selected)
    }
    selectedElements = []
    if (notifyParent) {
      const pageContext = currentPageContext()
      await emit('browser-selection-cleared', {
        pageUrl: pageContext.pageUrl,
        pageTitle: pageContext.pageTitle,
      })
    }
  }

  async function applySelections(selections) {
    desiredSelections = normalizeAppliedSelections(selections)
    reconcileDesiredSelections()
  }

  async function handleClick(event) {
    if (!selectMode) return
    event.preventDefault()
    event.stopPropagation()
    event.stopImmediatePropagation()

    const element = currentTarget?.element || event.target
    if (!(element instanceof Element)) {
      return false
    }

    if (event.ctrlKey && event.shiftKey && currentTarget?.promotionSourceSelectionId) {
      const selectedIndex = selectedElements.findIndex(
        (entry) => entry.selection.id === currentTarget.promotionSourceSelectionId
      )
      if (selectedIndex >= 0) {
        const selection = await buildSelectionDescriptor(
          element,
          event.clientX,
          event.clientY,
          currentTarget.promotionSourceSelectionId
        )
        await replaceResolvedSelection(selectedIndex, selection)
        const updatedEntry = selectedElements[selectedIndex]
        if (updatedEntry) {
          const promotedCandidate = buildPromotionCandidate(
            updatedEntry,
            event.clientX,
            event.clientY
          )
          if (promotedCandidate) {
            highlightPromotionSource(updatedEntry.selectionKey)
            currentTarget = promotedCandidate
            highlightCandidate(promotedCandidate)
            return false
          }
        }
        clearPromotionSourceHighlight()
        refreshHoverTargetFromPointer()
      }
      return false
    }

    const selectedIndex = findRenderedSelectionIndex(element, event.clientX, event.clientY)
    if (selectedIndex >= 0) {
      await deselectElement(selectedIndex)
    } else {
      const selection = await buildSelectionDescriptor(element, event.clientX, event.clientY)
      await selectResolvedSelection(selection)
    }
    return false
  }

  function handleMouseMove(event) {
    if (!selectMode) return
    if (!previewOwnsInput()) {
      hideHoverOverlay()
      return
    }
    if (!(event.target instanceof Element)) return
    if (event.target.hasAttribute('data-pixel-forge-injected')) return
    lastPointerElement = event.target
    hoverClientX = event.clientX
    hoverClientY = event.clientY
    refreshHoverTargetFromPointer()
  }

  function handleKeyDown(event) {
    if (!previewOwnsInput()) {
      return
    }

    if (event.key === 'Shift') {
      keyboardState.shift = true
      if (selectMode && keyboardState.ctrl) {
        event.preventDefault()
        event.stopPropagation()
        refreshHoverTargetFromPointer()
      }
      return
    }

    if (
      event.code === 'ControlLeft'
      && selectMode
      && !event.repeat
      && currentTarget
      && !event.shiftKey
      && !keyboardState.shift
    ) {
      keyboardState.ctrl = true
      event.preventDefault()
      event.stopPropagation()
      cycleHoverTarget()
      return
    }

    if (event.key === 'Control') {
      keyboardState.ctrl = true
      if (selectMode && keyboardState.shift) {
        event.preventDefault()
        event.stopPropagation()
        refreshHoverTargetFromPointer()
      }
      return
    }

    if (event.key === 'Escape' && selectMode) {
      selectMode = false
      document.body.style.cursor = ''
      hideHoverOverlay()
      const pageContext = currentPageContext()
      emit('browser-select-cancelled', {
        pageUrl: pageContext.pageUrl,
        pageTitle: pageContext.pageTitle,
      })
    }
  }

  function handleKeyUp(event) {
    if (!previewOwnsInput()) {
      keyboardState = { ctrl: false, shift: false }
      return
    }

    if (event.key === 'Shift') {
      keyboardState.shift = false
      if (promotionSourceSelectionKey) {
        refreshHoverTargetFromPointer()
      }
      return
    }

    if (event.key === 'Control') {
      keyboardState.ctrl = false
      if (promotionSourceSelectionKey) {
        refreshHoverTargetFromPointer()
      }
    }
  }

  const originalPushState = history.pushState.bind(history)
  history.pushState = function pushState(...args) {
    const result = originalPushState(...args)
    queueMicrotask(() => {
      notifyLocationChange()
      scheduleSelectionReconcile()
    })
    return result
  }

  const originalReplaceState = history.replaceState.bind(history)
  history.replaceState = function replaceState(...args) {
    const result = originalReplaceState(...args)
    queueMicrotask(() => {
      notifyLocationChange()
      scheduleSelectionReconcile()
    })
    return result
  }

  document.addEventListener('mousemove', handleMouseMove, true)
  document.addEventListener('click', handleClick, true)
  document.addEventListener('keydown', handleKeyDown, true)
  document.addEventListener('keyup', handleKeyUp, true)
  document.addEventListener('mouseleave', hideHoverOverlay)
  window.addEventListener('blur', () => {
    keyboardState = { ctrl: false, shift: false }
    hideHoverOverlay()
  })
  window.addEventListener('hashchange', () => {
    notifyLocationChange()
    scheduleSelectionReconcile()
  })
  window.addEventListener('popstate', () => {
    notifyLocationChange()
    scheduleSelectionReconcile()
  })
  window.addEventListener('load', () => {
    notifyLocationChange()
    scheduleSelectionReconcile()
  })
  window.addEventListener('scroll', updateAllPositions, true)
  window.addEventListener('resize', () => {
    updateAllPositions()
    scheduleSelectionReconcile()
  })

  window.addEventListener('DOMContentLoaded', () => {
    if (!domObserver && document.documentElement) {
      domObserver = new MutationObserver((mutations) => {
        const shouldReconcile = mutations.some((mutation) => {
          if (mutation.type === 'attributes') {
            return !shouldIgnoreMutationNode(mutation.target)
          }

          if (shouldIgnoreMutationNode(mutation.target)) {
            return false
          }

          return [...mutation.addedNodes, ...mutation.removedNodes].some(
            (node) => !shouldIgnoreMutationNode(node)
          )
        })

        if (shouldReconcile) {
          scheduleSelectionReconcile()
        }
      })
      domObserver.observe(document.documentElement, {
        childList: true,
        subtree: true,
        attributes: true,
        attributeFilter: ['class', 'style', 'hidden', 'aria-hidden'],
      })
    }

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
    scheduleSelectionReconcile()
  })

  function setTool(tool) {
    selectMode = tool === 'select'
    keyboardState = { ctrl: false, shift: false }
    lastPointerElement = null
    if (selectMode) {
      createHoverOverlay()
      if (document.body) {
        document.body.style.cursor = 'crosshair'
      }
    } else if (document.body) {
      document.body.style.cursor = ''
      hideHoverOverlay()
    }
  }

  return {
    inspectLiveContext,
    setTool,
    setSelectMode(enabled) {
      setTool(Boolean(enabled) ? 'select' : null)
    },
    async clearSelections() {
      await clearSelections(false)
    },
    async deselect(selectionId, xpath = '') {
      desiredSelections = desiredSelections.filter(
        (selection) => selection.id !== selectionId && (!xpath || selection.xpath !== xpath)
      )
      const index = selectedElements.findIndex(
        (entry) => entry.selection.id === selectionId || (xpath && entry.xpath === xpath)
      )
      if (index >= 0) {
        await deselectElement(index, false)
      }
      scheduleSelectionReconcile()
    },
    async applySelections(selections) {
      await applySelections(Array.isArray(selections) ? selections : [])
    },
  }
}
