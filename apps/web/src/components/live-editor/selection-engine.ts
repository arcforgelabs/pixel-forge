export type SelectionSelectorKind = 'dom' | 'region'

export type PdfSelectionKind = 'text' | 'text-range' | 'region'

export type SelectionSurfaceKind =
  | 'dom'
  | 'svg'
  | 'canvas'
  | 'webgl'
  | 'video'
  | 'image'
  | 'pdf'
  | 'unknown'

export interface SelectionRegion {
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
}

export interface PdfTextRange {
  startIndex: number
  startOffset: number
  endIndex: number
  endOffset: number
}

export interface SelectionRecord {
  id: string
  selectorKind: SelectionSelectorKind
  surfaceKind: SelectionSurfaceKind
  pageKey: string
  tagName: string
  elementId: string | null
  classList: string[]
  textContent: string
  xpath: string
  outerHTML: string
  rootXPath: string | null
  rootTagName: string | null
  rootElementId: string | null
  rootClassList: string[]
  region: SelectionRegion | null
  pdfSelectionKind?: PdfSelectionKind | null
  pdfPage?: number | null
  pdfTextRange?: PdfTextRange | null
  pdfTextContent?: string | null
  previewDataUrl: string | null
  sourceTabId: string
  sourceTabLabel: string
  sourceUrl: string
  pageTitle?: string | null
}

export interface SelectionArtifactAttachment {
  id: string
  name: string
  mimeType: string
  dataUrl: string
  kind: 'image'
}

export interface SelectionTunnelRecord {
  id: string
  globalIndex: number
  selectorKind: SelectionSelectorKind
  surfaceKind: SelectionSurfaceKind
  sourceTabId: string
  sourceTabLabel: string
  sourceUrl: string
  pageKey: string
  pageTitle: string | null
  tagName: string
  elementId: string | null
  classList: string[]
  textContent: string
  xpath: string
  rootXPath: string | null
  rootTagName: string | null
  rootElementId: string | null
  rootClassList: string[]
  region: SelectionRegion | null
  pdfSelectionKind?: PdfSelectionKind | null
  pdfPage?: number | null
  pdfTextRange?: PdfTextRange | null
  pdfTextContent?: string | null
  previewAttachmentName: string | null
  outerHTMLExcerpt: string
}

export interface BuiltSelectionArtifacts {
  elementContext: string
  tunnel: {
    selections: SelectionTunnelRecord[]
  }
  attachments: SelectionArtifactAttachment[]
}

function normalizeText(value: string | null | undefined, maxLength = 200): string {
  return String(value || '').replace(/\s+/g, ' ').trim().slice(0, maxLength)
}

function escapeXml(value: string | null | undefined): string {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;')
}

function sanitizeName(value: string, fallback: string): string {
  const normalized = value
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
  return normalized || fallback
}

function guessMimeType(dataUrl: string): string {
  const match = /^data:([^;,]+)[;,]/.exec(dataUrl)
  return match?.[1] || 'image/jpeg'
}

function getSelectionLabel(selection: SelectionRecord): string {
  if (selection.selectorKind === 'region') {
    return `${selection.surfaceKind}-region`
  }

  let label = selection.tagName || 'element'
  if (selection.elementId) {
    label += `-${selection.elementId}`
  } else if (selection.classList.length > 0) {
    label += `-${selection.classList.slice(0, 2).join('-')}`
  }
  return label
}

function buildSelectionAttachment(
  selection: SelectionRecord,
  globalIndex: number
): SelectionArtifactAttachment | null {
  if (!selection.previewDataUrl) {
    return null
  }

  const suffix = guessMimeType(selection.previewDataUrl).includes('png') ? '.png' : '.jpg'
  const baseName = sanitizeName(getSelectionLabel(selection), `selection-${globalIndex}`)
  return {
    id: `selection-attachment-${selection.id}`,
    name: `selection-${String(globalIndex).padStart(2, '0')}-${baseName}${suffix}`,
    mimeType: guessMimeType(selection.previewDataUrl),
    dataUrl: selection.previewDataUrl,
    kind: 'image',
  }
}

function buildDomElementBlock(
  selection: SelectionRecord,
  globalIndex: number,
  previewAttachmentName: string | null
): string {
  const htmlLimit = 2000
  return `<selected-element global-index="${globalIndex}" selector="${selection.selectorKind}" surface="${selection.surfaceKind}">
<tag>${escapeXml(selection.tagName)}</tag>
${selection.elementId ? `<id>${escapeXml(selection.elementId)}</id>` : ''}
${selection.classList.length > 0 ? `<classes>${escapeXml(selection.classList.join(' '))}</classes>` : ''}
<page-key>${escapeXml(selection.pageKey)}</page-key>
${selection.pdfSelectionKind ? `<pdf-selection-kind>${escapeXml(selection.pdfSelectionKind)}</pdf-selection-kind>` : ''}
${selection.pdfPage ? `<pdf-page>${selection.pdfPage}</pdf-page>` : ''}
${selection.pdfTextRange ? `<pdf-text-range start-index="${selection.pdfTextRange.startIndex}" start-offset="${selection.pdfTextRange.startOffset}" end-index="${selection.pdfTextRange.endIndex}" end-offset="${selection.pdfTextRange.endOffset}" />` : ''}
${selection.pdfTextContent ? `<pdf-text>${escapeXml(selection.pdfTextContent)}</pdf-text>` : ''}
<xpath>${escapeXml(selection.xpath)}</xpath>
${previewAttachmentName ? `<preview-attachment>${escapeXml(previewAttachmentName)}</preview-attachment>` : ''}
<html>
${escapeXml(selection.outerHTML.slice(0, htmlLimit))}${selection.outerHTML.length > htmlLimit ? '... (truncated)' : ''}
</html>
</selected-element>`
}

function buildRegionElementBlock(
  selection: SelectionRecord,
  globalIndex: number,
  previewAttachmentName: string | null
): string {
  const region = selection.region
  const htmlLimit = 1200
  return `<selected-element global-index="${globalIndex}" selector="${selection.selectorKind}" surface="${selection.surfaceKind}">
<tag>${escapeXml(selection.tagName)}</tag>
<page-key>${escapeXml(selection.pageKey)}</page-key>
${selection.pdfSelectionKind ? `<pdf-selection-kind>${escapeXml(selection.pdfSelectionKind)}</pdf-selection-kind>` : ''}
${selection.pdfPage ? `<pdf-page>${selection.pdfPage}</pdf-page>` : ''}
${selection.pdfTextContent ? `<pdf-text>${escapeXml(selection.pdfTextContent)}</pdf-text>` : ''}
${selection.rootXPath ? `<root-xpath>${escapeXml(selection.rootXPath)}</root-xpath>` : ''}
${selection.rootTagName ? `<root-tag>${escapeXml(selection.rootTagName)}</root-tag>` : ''}
${selection.rootElementId ? `<root-id>${escapeXml(selection.rootElementId)}</root-id>` : ''}
${selection.rootClassList.length > 0 ? `<root-classes>${escapeXml(selection.rootClassList.join(' '))}</root-classes>` : ''}
${region ? `<region x="${region.x}" y="${region.y}" width="${region.width}" height="${region.height}" normalized-x="${region.normalizedX}" normalized-y="${region.normalizedY}" normalized-width="${region.normalizedWidth}" normalized-height="${region.normalizedHeight}" anchor-x="${region.anchorX}" anchor-y="${region.anchorY}" />` : ''}
${previewAttachmentName ? `<preview-attachment>${escapeXml(previewAttachmentName)}</preview-attachment>` : ''}
<html>
${escapeXml(selection.outerHTML.slice(0, htmlLimit))}${selection.outerHTML.length > htmlLimit ? '... (truncated)' : ''}
</html>
</selected-element>`
}

export function buildSelectionArtifacts(selectedElements: SelectionRecord[]): BuiltSelectionArtifacts {
  if (selectedElements.length === 0) {
    return {
      elementContext: '',
      tunnel: { selections: [] },
      attachments: [],
    }
  }

  const groups = new Map<
    string,
    {
      sourceTabId: string
      sourceTabLabel: string
      sourceUrl: string
      pageTitle: string | null
      selections: Array<{
        selection: SelectionRecord
        globalIndex: number
        previewAttachmentName: string | null
      }>
    }
  >()

  const attachments: SelectionArtifactAttachment[] = []
  const tunnelSelections: SelectionTunnelRecord[] = []

  selectedElements.forEach((selection, index) => {
    const globalIndex = index + 1
    const attachment = buildSelectionAttachment(selection, globalIndex)
    if (attachment) {
      attachments.push(attachment)
    }

    const groupKey = `${selection.sourceTabId}::${selection.sourceUrl}`
    if (!groups.has(groupKey)) {
      groups.set(groupKey, {
        sourceTabId: selection.sourceTabId,
        sourceTabLabel: selection.sourceTabLabel,
        sourceUrl: selection.sourceUrl,
        pageTitle: selection.pageTitle ?? null,
        selections: [],
      })
    }

    groups.get(groupKey)?.selections.push({
      selection,
      globalIndex,
      previewAttachmentName: attachment?.name ?? null,
    })

    tunnelSelections.push({
      id: selection.id,
      globalIndex,
      selectorKind: selection.selectorKind,
      surfaceKind: selection.surfaceKind,
      sourceTabId: selection.sourceTabId,
      sourceTabLabel: selection.sourceTabLabel,
      sourceUrl: selection.sourceUrl,
      pageKey: selection.pageKey,
      pageTitle: selection.pageTitle ?? null,
      tagName: selection.tagName,
      elementId: selection.elementId,
      classList: selection.classList,
      textContent: normalizeText(selection.textContent, 240),
      xpath: selection.xpath,
      pdfSelectionKind: selection.pdfSelectionKind ?? null,
      pdfPage: selection.pdfPage ?? null,
      pdfTextRange: selection.pdfTextRange ?? null,
      pdfTextContent: selection.pdfTextContent ?? null,
      rootXPath: selection.rootXPath,
      rootTagName: selection.rootTagName,
      rootElementId: selection.rootElementId,
      rootClassList: selection.rootClassList,
      region: selection.region,
      previewAttachmentName: attachment?.name ?? null,
      outerHTMLExcerpt: selection.outerHTML.slice(0, 2400),
    })
  })

  const elementContext = Array.from(groups.values())
    .map((group, groupIndex) => {
      const titleBlock = group.pageTitle
        ? `\n<title>${escapeXml(group.pageTitle)}</title>`
        : ''

      const selectionBlocks = group.selections
        .map(({ selection, globalIndex, previewAttachmentName }) =>
          selection.selectorKind === 'region'
            ? buildRegionElementBlock(selection, globalIndex, previewAttachmentName)
            : buildDomElementBlock(selection, globalIndex, previewAttachmentName)
        )
        .join('\n\n')

      return `<source index="${groupIndex + 1}" tab-id="${escapeXml(group.sourceTabId)}" tab="${escapeXml(group.sourceTabLabel)}" url="${escapeXml(group.sourceUrl)}">${titleBlock}
${selectionBlocks}
</source>`
    })
    .join('\n\n')

  return {
    elementContext,
    tunnel: {
      selections: tunnelSelections,
    },
    attachments,
  }
}
