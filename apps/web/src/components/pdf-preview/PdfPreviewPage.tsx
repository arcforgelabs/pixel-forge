import { useEffect, useRef, useState } from 'react'
import * as pdfjs from 'pdfjs-dist/webpack.mjs'
import { TextLayerBuilder } from 'pdfjs-dist/web/pdf_viewer.mjs'
import 'pdfjs-dist/web/pdf_viewer.css'
import './pdf-preview.css'

type PdfLoadingTask = ReturnType<typeof pdfjs.getDocument>
type PdfDocumentProxy = Awaited<PdfLoadingTask['promise']>
type PdfPageProxy = Awaited<ReturnType<PdfDocumentProxy['getPage']>>

interface PreviewBridgePdfSource {
  source_url: string
  title: string | null
  content_type: string | null
  bytes: Uint8Array | ArrayBuffer | number[] | { data?: number[] }
}

interface PreviewBridge {
  emitEvent?: (type: string, data?: Record<string, unknown>) => void
  readPdfPreviewSource?: () => Promise<PreviewBridgePdfSource>
}

interface PdfLineCandidate {
  anchorElement: Element
  pageNumber: number
  pageRoot: HTMLElement
  rect: {
    left: number
    top: number
    right: number
    bottom: number
    width: number
    height: number
  }
  spans: HTMLElement[]
  text: string
}

interface PdfPreviewState {
  sourceUrl: string
  title: string
  pageCount: number
  pageElements: Map<number, HTMLElement>
  visiblePages: number[]
}

interface PdfAdapterSelection {
  id: string
  selectorKind: 'dom' | 'region'
  surfaceKind: 'pdf'
  pageKey: string
  tagName: string
  elementId: null
  classList: string[]
  textContent: string
  xpath: string
  outerHTML: string
  rootXPath: string | null
  rootTagName: string | null
  rootElementId: null
  rootClassList: string[]
  region: {
    x: number
    y: number
    width: number
    height: number
    normalizedX: number
    normalizedY: number
    normalizedWidth: number
    normalizedHeight: number
    anchorX: number
    anchorY: number
  } | null
  previewDataUrl: string | null
  pageUrl: string
  pageTitle: string | null
  selectionId: string
  pdfPage: number
  pdfTextContent: string | null
  __pixelForgeResolvedElement: Element
}

interface PreviewSelectionHelpers {
  buildRegionBounds?: (
    surfaceElement: Element,
    clientX: number,
    clientY: number
  ) => {
    left: number
    top: number
    right: number
    bottom: number
    width: number
    height: number
  }
  capturePreviewData: (rect: {
    left: number
    top: number
    right: number
    bottom: number
    width: number
    height: number
  }) => Promise<string | null>
  getXPath: (element: Element | null) => string
  normalizeText: (value: string | null | undefined, maxLength?: number) => string
  pageContext: {
    pageUrl: string
    pageTitle: string | null
  }
  findElementByXPath?: (xpath: string) => Element | null
}

function getPreviewBridge(): PreviewBridge | null {
  return (
    (window as Window & { __pixelForgePreviewBridge?: PreviewBridge }).__pixelForgePreviewBridge
    || null
  )
}

function normalizeBytes(value: PreviewBridgePdfSource['bytes']): Uint8Array {
  if (value instanceof Uint8Array) {
    return value
  }
  if (value instanceof ArrayBuffer) {
    return new Uint8Array(value)
  }
  if (Array.isArray(value)) {
    return Uint8Array.from(value)
  }
  if (value && typeof value === 'object' && Array.isArray(value.data)) {
    return Uint8Array.from(value.data)
  }
  return new Uint8Array()
}

function normalizeText(value: string | null | undefined, maxLength = 400): string {
  return String(value || '').replace(/\s+/g, ' ').trim().slice(0, maxLength)
}

function pageKeyFor(sourceUrl: string, pageNumber: number): string {
  return `${sourceUrl}#page=${pageNumber}`
}

function findPdfPageRoot(element: Element | null): HTMLElement | null {
  return element?.closest?.('[data-pf-pdf-page-number]') as HTMLElement | null
}

function pageNumberForRoot(pageRoot: HTMLElement | null): number | null {
  const rawPageNumber = pageRoot?.dataset.pfPdfPageNumber
  const numericPage = Number(rawPageNumber)
  return Number.isFinite(numericPage) && numericPage > 0
    ? Math.round(numericPage)
    : null
}

function findTextSpan(element: Element | null): HTMLElement | null {
  return element?.closest?.('[data-pf-pdf-text="1"]') as HTMLElement | null
}

function rectsIntersect(
  first: { left: number; top: number; right: number; bottom: number },
  second: { left: number; top: number; right: number; bottom: number }
): boolean {
  return !(
    first.right < second.left
    || first.left > second.right
    || first.bottom < second.top
    || first.top > second.bottom
  )
}

function unionRect(
  rects: Array<{
    left: number
    top: number
    right: number
    bottom: number
    width: number
    height: number
  }>
) {
  if (rects.length === 0) {
    return null
  }

  const left = Math.min(...rects.map((rect) => rect.left))
  const top = Math.min(...rects.map((rect) => rect.top))
  const right = Math.max(...rects.map((rect) => rect.right))
  const bottom = Math.max(...rects.map((rect) => rect.bottom))
  return {
    left,
    top,
    right,
    bottom,
    width: Math.max(0, right - left),
    height: Math.max(0, bottom - top),
  }
}

function collectTextSpans(pageRoot: HTMLElement | null): HTMLElement[] {
  if (!pageRoot) {
    return []
  }
  return Array.from(pageRoot.querySelectorAll<HTMLElement>('[data-pf-pdf-text="1"]'))
}

function collectLineCandidates(pageRoot: HTMLElement | null): PdfLineCandidate[] {
  const pageNumber = pageNumberForRoot(pageRoot)
  if (!pageRoot || !pageNumber) {
    return []
  }

  const items = collectTextSpans(pageRoot)
    .map((span) => ({
      span,
      rect: span.getBoundingClientRect(),
      text: normalizeText(span.textContent, 120),
    }))
    .filter((item) => item.rect.width > 0 && item.rect.height > 0 && item.text)
    .sort((left, right) => {
      const topDelta = left.rect.top - right.rect.top
      return Math.abs(topDelta) > 4 ? topDelta : left.rect.left - right.rect.left
    })

  const grouped: Array<{
    centerY: number
    averageHeight: number
    items: typeof items
  }> = []

  items.forEach((item) => {
    const centerY = item.rect.top + item.rect.height / 2
    const lastGroup = grouped[grouped.length - 1]
    const tolerance = Math.max(4, (lastGroup?.averageHeight || item.rect.height) * 0.75)
    if (!lastGroup || Math.abs(centerY - lastGroup.centerY) > tolerance) {
      grouped.push({
        centerY,
        averageHeight: item.rect.height,
        items: [item],
      })
      return
    }

    lastGroup.items.push(item)
    lastGroup.centerY =
      (lastGroup.centerY * (lastGroup.items.length - 1) + centerY) / lastGroup.items.length
    lastGroup.averageHeight =
      (lastGroup.averageHeight * (lastGroup.items.length - 1) + item.rect.height) / lastGroup.items.length
  })

  return grouped.flatMap((group) => {
    const sortedItems = [...group.items].sort((left, right) => left.rect.left - right.rect.left)
    const rect = unionRect(sortedItems.map((item) => item.rect))
    const text = normalizeText(sortedItems.map((item) => item.text).join(' '), 400)
    if (!rect || !text) {
      return []
    }
    return [{
      anchorElement: sortedItems[0].span,
      pageNumber,
      pageRoot,
      rect,
      spans: sortedItems.map((item) => item.span),
      text,
    }]
  })
}

function findLineCandidateForElement(element: Element | null): PdfLineCandidate | null {
  const pageRoot = findPdfPageRoot(element)
  const anchorSpan = findTextSpan(element)
  if (!pageRoot || !anchorSpan) {
    return null
  }
  return collectLineCandidates(pageRoot).find((candidate) =>
    candidate.spans.some((span) => span === anchorSpan)
  ) || null
}

function findLineCandidateByText(
  pageRoot: HTMLElement | null,
  textNeedle: string
): PdfLineCandidate | null {
  const normalizedNeedle = normalizeText(textNeedle, 240)
  if (!pageRoot || !normalizedNeedle) {
    return null
  }

  const prefix = normalizedNeedle.slice(0, Math.min(normalizedNeedle.length, 72))
  return collectLineCandidates(pageRoot).find((candidate) => {
    const candidateText = normalizeText(candidate.text, 400)
    return candidateText.includes(prefix) || prefix.includes(candidateText.slice(0, 48))
  }) || null
}

function extractTextForRegion(
  pageRoot: HTMLElement | null,
  regionRect: { left: number; top: number; right: number; bottom: number }
): string | null {
  if (!pageRoot) {
    return null
  }

  const matchingLines = collectLineCandidates(pageRoot).filter((candidate) =>
    rectsIntersect(candidate.rect, regionRect)
  )
  const combinedText = normalizeText(
    matchingLines.map((candidate) => candidate.text).join(' '),
    500,
  )
  return combinedText || null
}

function buildBoundingBox(rect: {
  left: number
  top: number
  width: number
  height: number
}) {
  return {
    x: Math.round(rect.left),
    y: Math.round(rect.top),
    width: Math.round(rect.width),
    height: Math.round(rect.height),
  }
}

function decorateTextLayer(textLayerRoot: HTMLElement, pageNumber: number) {
  Array.from(textLayerRoot.querySelectorAll<HTMLElement>('span'))
    .filter((span) => normalizeText(span.textContent, 32))
    .forEach((span, index) => {
      span.dataset.pfPdfText = '1'
      span.dataset.pfPdfPageNumber = String(pageNumber)
      span.dataset.pfPdfTextIndex = String(index + 1)
    })
}

async function renderPdfPage(
  pdfPage: PdfPageProxy,
  pageRoot: HTMLElement,
  viewerWidth: number
) {
  const baseViewport = pdfPage.getViewport({ scale: 1 })
  const availableWidth = Math.max(360, viewerWidth - 48)
  const scale = Math.min(2.2, Math.max(1, availableWidth / Math.max(baseViewport.width, 1)))
  const viewport = pdfPage.getViewport({ scale })

  pageRoot.replaceChildren()
  pageRoot.style.width = `${viewport.width}px`
  pageRoot.style.height = `${viewport.height}px`
  pageRoot.dataset.pfPdfScale = scale.toFixed(4)

  const pageNumberBadge = document.createElement('div')
  pageNumberBadge.className = 'pf-pdf-page-badge'
  pageNumberBadge.textContent = `Page ${pdfPage.pageNumber}`
  pageRoot.appendChild(pageNumberBadge)

  const canvasWrapper = document.createElement('div')
  canvasWrapper.className = 'canvasWrapper pf-pdf-canvas-layer'
  pageRoot.appendChild(canvasWrapper)

  const canvas = document.createElement('canvas')
  canvas.setAttribute('aria-hidden', 'true')
  canvasWrapper.appendChild(canvas)

  const outputScale = Math.max(1, window.devicePixelRatio || 1)
  canvas.width = Math.floor(viewport.width * outputScale)
  canvas.height = Math.floor(viewport.height * outputScale)
  canvas.style.width = `${viewport.width}px`
  canvas.style.height = `${viewport.height}px`

  const canvasContext = canvas.getContext('2d', { alpha: false })
  if (!canvasContext) {
    throw new Error(`Canvas context unavailable for PDF page ${pdfPage.pageNumber}`)
  }

  await pdfPage.render({
    canvasContext,
    viewport,
    transform: outputScale === 1 ? undefined : [outputScale, 0, 0, outputScale, 0, 0],
  }).promise

  const textLayerBuilder = new TextLayerBuilder({
    pdfPage,
  })
  await textLayerBuilder.render(viewport)
  if (!textLayerBuilder.div.isConnected) {
    pageRoot.appendChild(textLayerBuilder.div)
  }
  decorateTextLayer(textLayerBuilder.div, pdfPage.pageNumber)
}

export default function PdfPreviewPage() {
  const viewportRef = useRef<HTMLDivElement | null>(null)
  const viewerRef = useRef<HTMLDivElement | null>(null)
  const pdfDocumentRef = useRef<PdfDocumentProxy | null>(null)
  const stateRef = useRef<PdfPreviewState>({
    sourceUrl: '',
    title: 'PDF Preview',
    pageCount: 0,
    pageElements: new Map(),
    visiblePages: [],
  })
  const [title, setTitle] = useState('PDF Preview')
  const [pageCount, setPageCount] = useState(0)
  const [visiblePages, setVisiblePages] = useState<number[]>([])
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    const adapter: NonNullable<Window['__pixelForgePdfSelectionAdapter']> = {
      getPageContext() {
        const state = stateRef.current
        const primaryVisiblePage = state.visiblePages[0] || 1
        return {
          pageUrl: state.sourceUrl || window.location.href,
          pageTitle: state.title || document.title || null,
          pageKey: pageKeyFor(state.sourceUrl || window.location.href, primaryVisiblePage),
        }
      },
      getSurfaceKind(element: Element | null) {
        return findPdfPageRoot(element) ? 'pdf' : null
      },
      findRegionSurface(element: Element | null) {
        return findPdfPageRoot(element)
      },
      classifySelectionTarget(element: Element | null) {
        const lineCandidate = findLineCandidateForElement(element)
        if (lineCandidate) {
          return {
            selectorKind: 'dom' as const,
            surfaceElement: null,
            hoverRect: lineCandidate.rect,
            label: `PDF page ${lineCandidate.pageNumber} text`,
          }
        }

        const pageRoot = findPdfPageRoot(element)
        const pageNumber = pageNumberForRoot(pageRoot)
        if (!pageRoot || !pageNumber) {
          return null
        }

        return {
          selectorKind: 'region' as const,
          surfaceElement: pageRoot,
          hoverRect: pageRoot.getBoundingClientRect(),
          label: `PDF page ${pageNumber} region`,
        }
      },
      async buildSelectionDescriptor(
        element: Element | null,
        clientX: number | null,
        clientY: number | null,
        selectionId: string,
        helpers: PreviewSelectionHelpers
      ): Promise<PdfAdapterSelection | null> {
        const state = stateRef.current
        const lineCandidate = findLineCandidateForElement(element)
        if (lineCandidate) {
          const previewDataUrl = await helpers.capturePreviewData(lineCandidate.rect)
          const xpath = helpers.getXPath(lineCandidate.anchorElement)
          const pdfTextContent = lineCandidate.text
          return {
            id: selectionId,
            selectorKind: 'dom',
            surfaceKind: 'pdf',
            pageKey: pageKeyFor(state.sourceUrl || helpers.pageContext.pageUrl, lineCandidate.pageNumber),
            tagName: 'pdf-text',
            elementId: null,
            classList: ['pdf-text'],
            textContent: pdfTextContent,
            xpath,
            outerHTML: lineCandidate.spans.map((span) => span.outerHTML).join(''),
            rootXPath: null,
            rootTagName: null,
            rootElementId: null,
            rootClassList: [],
            region: null,
            previewDataUrl,
            pageUrl: state.sourceUrl || helpers.pageContext.pageUrl,
            pageTitle: state.title || helpers.pageContext.pageTitle,
            selectionId,
            pdfPage: lineCandidate.pageNumber,
            pdfTextContent,
            __pixelForgeResolvedElement: lineCandidate.anchorElement,
          }
        }

        const pageRoot = findPdfPageRoot(element)
        const pageNumber = pageNumberForRoot(pageRoot)
        if (
          !pageRoot
          || !pageNumber
          || typeof helpers.buildRegionBounds !== 'function'
          || !Number.isFinite(clientX)
          || !Number.isFinite(clientY)
        ) {
          return null
        }

        const anchorClientX = Number(clientX)
        const anchorClientY = Number(clientY)
        const regionRect = helpers.buildRegionBounds(pageRoot, anchorClientX, anchorClientY)
        const pageRect = pageRoot.getBoundingClientRect()
        const pdfTextContent = extractTextForRegion(pageRoot, regionRect)
        const previewDataUrl = await helpers.capturePreviewData(regionRect)
        const region = {
          x: Math.round(regionRect.left - pageRect.left),
          y: Math.round(regionRect.top - pageRect.top),
          width: Math.round(regionRect.width),
          height: Math.round(regionRect.height),
          normalizedX: Number(((regionRect.left - pageRect.left) / Math.max(pageRect.width, 1)).toFixed(6)),
          normalizedY: Number(((regionRect.top - pageRect.top) / Math.max(pageRect.height, 1)).toFixed(6)),
          normalizedWidth: Number((regionRect.width / Math.max(pageRect.width, 1)).toFixed(6)),
          normalizedHeight: Number((regionRect.height / Math.max(pageRect.height, 1)).toFixed(6)),
          anchorX: Number(((anchorClientX - pageRect.left) / Math.max(pageRect.width, 1)).toFixed(6)),
          anchorY: Number(((anchorClientY - pageRect.top) / Math.max(pageRect.height, 1)).toFixed(6)),
        }

        return {
          id: selectionId,
          selectorKind: 'region',
          surfaceKind: 'pdf',
          pageKey: pageKeyFor(state.sourceUrl || helpers.pageContext.pageUrl, pageNumber),
          tagName: 'pdf-page',
          elementId: null,
          classList: ['pdf-page'],
          textContent: pdfTextContent || '',
          xpath: '',
          outerHTML: pageRoot.outerHTML,
          rootXPath: helpers.getXPath(pageRoot),
          rootTagName: 'pdf-page',
          rootElementId: null,
          rootClassList: ['pdf-page'],
          region,
          previewDataUrl,
          pageUrl: state.sourceUrl || helpers.pageContext.pageUrl,
          pageTitle: state.title || helpers.pageContext.pageTitle,
          selectionId,
          pdfPage: pageNumber,
          pdfTextContent,
          __pixelForgeResolvedElement: pageRoot,
        }
      },
      resolveSelection(
        selection: {
          selectorKind: 'dom' | 'region'
          xpath?: string
          rootXPath?: string | null
          region?: {
            x: number
            y: number
            width: number
            height: number
          } | null
          pdfPage?: number | null
          pdfTextContent?: string | null
          textSample?: string
        },
        helpers: PreviewSelectionHelpers
      ) {
        const pageNumber =
          Number.isFinite(Number(selection.pdfPage)) && Number(selection.pdfPage) > 0
            ? Math.round(Number(selection.pdfPage))
            : null
        const pageRoot = pageNumber
          ? stateRef.current.pageElements.get(pageNumber) || null
          : (
              (selection.rootXPath && typeof helpers.findElementByXPath === 'function'
                ? findPdfPageRoot(helpers.findElementByXPath(selection.rootXPath))
                : null)
            )

        if (selection.selectorKind === 'region' && selection.region && pageRoot) {
          const pageRect = pageRoot.getBoundingClientRect()
          const rect = {
            left: pageRect.left + selection.region.x,
            top: pageRect.top + selection.region.y,
            width: selection.region.width,
            height: selection.region.height,
            right: pageRect.left + selection.region.x + selection.region.width,
            bottom: pageRect.top + selection.region.y + selection.region.height,
          }
          return {
            element: pageRoot,
            rect,
            summary: {
              tag_name: 'pdf-page',
              xpath: typeof selection.rootXPath === 'string' ? selection.rootXPath : '',
              text_excerpt:
                normalizeText(selection.pdfTextContent, 240)
                || extractTextForRegion(pageRoot, rect)
                || null,
              bounding_box: buildBoundingBox(rect),
              pdf_page: pageNumber,
            },
          }
        }

        const hintedElement =
          typeof selection.xpath === 'string' && selection.xpath && typeof helpers.findElementByXPath === 'function'
            ? helpers.findElementByXPath(selection.xpath)
            : null
        const hintedCandidate = findLineCandidateForElement(hintedElement)
        const expectedText =
          normalizeText(selection.pdfTextContent, 240)
          || normalizeText(selection.textSample, 240)
        if (hintedCandidate && (!expectedText || normalizeText(hintedCandidate.text, 240).includes(expectedText.slice(0, 48)))) {
          return {
            element: hintedCandidate.anchorElement,
            rect: hintedCandidate.rect,
            summary: {
              tag_name: 'pdf-text',
              xpath: typeof selection.xpath === 'string' ? selection.xpath : '',
              text_excerpt: hintedCandidate.text,
              bounding_box: buildBoundingBox(hintedCandidate.rect),
              pdf_page: hintedCandidate.pageNumber,
            },
          }
        }

        const resolvedPageRoot = pageRoot || findPdfPageRoot(hintedElement)
        const matchedCandidate = findLineCandidateByText(
          resolvedPageRoot,
          expectedText || '',
        )
        if (!matchedCandidate) {
          return null
        }

        return {
          element: matchedCandidate.anchorElement,
          rect: matchedCandidate.rect,
          summary: {
            tag_name: 'pdf-text',
            xpath: typeof selection.xpath === 'string' ? selection.xpath : '',
            text_excerpt: matchedCandidate.text,
            bounding_box: buildBoundingBox(matchedCandidate.rect),
            pdf_page: matchedCandidate.pageNumber,
          },
        }
      },
      inspectContextMetadata() {
        return {
          surface_kind: 'pdf',
          page_count: stateRef.current.pageCount,
          visible_page_numbers: [...stateRef.current.visiblePages],
        }
      },
    }

    window.__pixelForgePdfSelectionAdapter = adapter
    return () => {
      delete window.__pixelForgePdfSelectionAdapter
    }
  }, [])

  useEffect(() => {
    let cancelled = false

    const updateVisiblePages = () => {
      const viewport = viewportRef.current
      if (!viewport) {
        return
      }

      const viewportRect = viewport.getBoundingClientRect()
      const nextVisiblePages = Array.from(stateRef.current.pageElements.entries())
        .filter(([, pageRoot]) => rectsIntersect(pageRoot.getBoundingClientRect(), viewportRect))
        .map(([pageNumber]) => pageNumber)

      stateRef.current.visiblePages = nextVisiblePages
      setVisiblePages(nextVisiblePages)
    }

    const loadPdf = async () => {
      const bridge = getPreviewBridge()
      if (!bridge?.readPdfPreviewSource) {
        throw new Error('Preview PDF bridge is unavailable')
      }

      const source = await bridge.readPdfPreviewSource()
      const sourceUrl = source.source_url || window.location.href
      const sourceTitle = normalizeText(source.title, 240) || normalizeText(sourceUrl.split('/').pop(), 240) || 'PDF Preview'
      const pdfBytes = normalizeBytes(source.bytes)
      if (pdfBytes.byteLength === 0) {
        throw new Error('Preview PDF bridge returned no document bytes')
      }

      const loadingTask = pdfjs.getDocument({
        data: pdfBytes,
        useWorkerFetch: false,
      })
      const pdfDocument = await loadingTask.promise
      if (cancelled) {
        await pdfDocument.destroy()
        return
      }

      pdfDocumentRef.current = pdfDocument
      stateRef.current.sourceUrl = sourceUrl
      stateRef.current.title = sourceTitle
      stateRef.current.pageCount = pdfDocument.numPages
      stateRef.current.pageElements = new Map()
      document.title = sourceTitle
      setTitle(sourceTitle)
      setPageCount(pdfDocument.numPages)

      const viewerElement = viewerRef.current
      if (!viewerElement) {
        throw new Error('Preview PDF viewer element is unavailable')
      }

      viewerElement.replaceChildren()
      const viewerWidth = viewportRef.current?.clientWidth || viewerElement.clientWidth || 960

      for (let pageNumber = 1; pageNumber <= pdfDocument.numPages; pageNumber += 1) {
        const pageRoot = document.createElement('article')
        pageRoot.className = 'pf-pdf-page page'
        pageRoot.dataset.pfPdfPageNumber = String(pageNumber)
        pageRoot.setAttribute('aria-label', `PDF page ${pageNumber}`)
        viewerElement.appendChild(pageRoot)
        stateRef.current.pageElements.set(pageNumber, pageRoot)
        const pdfPage = await pdfDocument.getPage(pageNumber)
        await renderPdfPage(pdfPage, pageRoot, viewerWidth)
      }

      updateVisiblePages()
      bridge.emitEvent?.('browser-location-changed', {
        url: sourceUrl,
        title: sourceTitle,
      })
      setLoading(false)
      setError(null)
    }

    const handleScrollOrResize = () => updateVisiblePages()
    const viewport = viewportRef.current
    viewport?.addEventListener('scroll', handleScrollOrResize, { passive: true })
    window.addEventListener('resize', handleScrollOrResize)

    void loadPdf().catch((loadError) => {
      const message = loadError instanceof Error ? loadError.message : String(loadError || 'Unknown PDF preview error')
      setLoading(false)
      setError(message)
      getPreviewBridge()?.emitEvent?.('browser-load-failed', {
        errorCode: -1,
        errorDescription: message,
        url: stateRef.current.sourceUrl || window.location.href,
      })
    })

    return () => {
      cancelled = true
      viewport?.removeEventListener('scroll', handleScrollOrResize)
      window.removeEventListener('resize', handleScrollOrResize)
      void pdfDocumentRef.current?.destroy?.()
      pdfDocumentRef.current = null
    }
  }, [])

  return (
    <div className="pf-pdf-preview">
      <header className="pf-pdf-header">
        <div>
          <div className="pf-pdf-kicker">Embedded PDF Preview</div>
          <h1 className="pf-pdf-title">{title}</h1>
        </div>
        <div className="pf-pdf-meta">
          <span>{pageCount > 0 ? `${pageCount} pages` : 'Loading pages'}</span>
          <span>{visiblePages.length > 0 ? `Visible: ${visiblePages.join(', ')}` : 'Visible: calculating'}</span>
        </div>
      </header>
      <div ref={viewportRef} className="pf-pdf-scroll">
        <div ref={viewerRef} className="pdfViewer pf-pdf-viewer" />
        {loading ? <div className="pf-pdf-status">Loading PDF preview…</div> : null}
        {error ? <div className="pf-pdf-error">{error}</div> : null}
      </div>
    </div>
  )
}
