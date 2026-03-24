import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'

const PDF_VIEWER_PATH = '/internal/pdf-viewer'
const PDF_CONTENT_TYPE_RE = /\bapplication\/pdf\b/i
const PDF_FILENAME_RE = /\.pdf$/i

function normalizeText(value) {
  if (typeof value !== 'string') {
    return null
  }
  const trimmed = value.trim()
  return trimmed || null
}

function parseUrl(rawUrl) {
  try {
    return new URL(String(rawUrl))
  } catch {
    return null
  }
}

export function readInternalPdfViewerState(candidateUrl, shellUrl) {
  const target = parseUrl(candidateUrl)
  const shell = parseUrl(shellUrl)
  if (!target || !shell) {
    return null
  }

  if (target.origin !== shell.origin || target.pathname !== PDF_VIEWER_PATH) {
    return null
  }

  return {
    tabId: normalizeText(target.searchParams.get('tabId')),
    sourceUrl: normalizeText(target.searchParams.get('source')),
    title: normalizeText(target.searchParams.get('title')),
    contentType: normalizeText(target.searchParams.get('contentType')),
  }
}

function filenameFromDisposition(contentDisposition) {
  const normalized = normalizeText(contentDisposition)
  if (!normalized) {
    return null
  }

  const utf8Match = /filename\*\s*=\s*UTF-8''([^;]+)/i.exec(normalized)
  if (utf8Match?.[1]) {
    try {
      return decodeURIComponent(utf8Match[1])
    } catch {
      return utf8Match[1]
    }
  }

  const plainMatch = /filename\s*=\s*"([^"]+)"|filename\s*=\s*([^;]+)/i.exec(normalized)
  const rawValue = plainMatch?.[1] || plainMatch?.[2]
  if (!rawValue) {
    return null
  }
  return rawValue.trim()
}

export function isPdfContentType(contentType) {
  const normalized = normalizeText(contentType)
  return normalized ? PDF_CONTENT_TYPE_RE.test(normalized) : false
}

export function contentDispositionLooksLikePdf(contentDisposition) {
  const filename = filenameFromDisposition(contentDisposition)
  return filename ? PDF_FILENAME_RE.test(filename) : false
}

export function looksLikePdfUrl(rawUrl) {
  const parsed = parseUrl(rawUrl)
  const pathname = parsed
    ? decodeURIComponent(parsed.pathname || '')
    : String(rawUrl || '').split(/[?#]/, 1)[0]
  return PDF_FILENAME_RE.test(pathname)
}

export function guessPdfTitle(rawUrl, contentDisposition) {
  const dispositionFilename = filenameFromDisposition(contentDisposition)
  if (dispositionFilename) {
    return dispositionFilename
  }

  const parsed = parseUrl(rawUrl)
  if (!parsed) {
    return 'Document.pdf'
  }

  const segments = parsed.pathname.split('/').filter(Boolean)
  const filename = segments[segments.length - 1]
  return filename || 'Document.pdf'
}

export function resolvePdfTargetMetadata({
  requestedUrl,
  finalUrl,
  contentType,
  contentDisposition,
}) {
  const normalizedRequestedUrl = normalizeText(requestedUrl)
  const normalizedFinalUrl = normalizeText(finalUrl) || normalizedRequestedUrl
  if (!normalizedFinalUrl) {
    return null
  }

  const pdfByHeaders =
    isPdfContentType(contentType)
    || contentDispositionLooksLikePdf(contentDisposition)
  const pdfByUrl =
    looksLikePdfUrl(normalizedRequestedUrl || normalizedFinalUrl)
    || looksLikePdfUrl(normalizedFinalUrl)

  if (!pdfByHeaders && !pdfByUrl) {
    return null
  }

  return {
    sourceUrl: normalizedFinalUrl,
    title: guessPdfTitle(normalizedFinalUrl, contentDisposition),
    contentType: isPdfContentType(contentType) ? normalizeText(contentType) : null,
  }
}

async function fetchPdfMetadata(previewSession, requestedUrl, init = {}) {
  const response = await previewSession.fetch(requestedUrl, {
    redirect: 'follow',
    ...init,
  })

  return resolvePdfTargetMetadata({
    requestedUrl,
    finalUrl: response.url || requestedUrl,
    contentType: response.headers.get('content-type'),
    contentDisposition: response.headers.get('content-disposition'),
  })
}

export async function detectPdfPreviewTarget(previewSession, requestedUrl) {
  const directMatch = resolvePdfTargetMetadata({
    requestedUrl,
    finalUrl: requestedUrl,
    contentType: null,
    contentDisposition: null,
  })
  if (directMatch) {
    return directMatch
  }

  if (!previewSession || typeof previewSession.fetch !== 'function') {
    return null
  }

  try {
    const headMatch = await fetchPdfMetadata(previewSession, requestedUrl, {
      method: 'HEAD',
    })
    if (headMatch) {
      return headMatch
    }
  } catch {
    // Some targets reject HEAD even when GET succeeds.
  }

  try {
    return await fetchPdfMetadata(previewSession, requestedUrl, {
      method: 'GET',
      headers: {
        Range: 'bytes=0-0',
      },
    })
  } catch {
    return null
  }
}

export async function readPdfDocumentSource({
  previewSession,
  sourceUrl,
  title = null,
  contentType = null,
  readLocalFile = readFile,
}) {
  const normalizedSourceUrl = normalizeText(sourceUrl)
  if (!normalizedSourceUrl) {
    throw new Error('PDF source URL is required')
  }

  const parsedSourceUrl = parseUrl(normalizedSourceUrl)
  if (parsedSourceUrl?.protocol === 'file:') {
    const bytes = await readLocalFile(fileURLToPath(parsedSourceUrl))
    return {
      sourceUrl: normalizedSourceUrl,
      title: normalizeText(title) || guessPdfTitle(normalizedSourceUrl, null),
      contentType: normalizeText(contentType) || 'application/pdf',
      bytes,
    }
  }

  if (!previewSession || typeof previewSession.fetch !== 'function') {
    throw new Error('Preview session fetch is unavailable for PDF source loading')
  }

  const response = await previewSession.fetch(normalizedSourceUrl, {
    method: 'GET',
    redirect: 'follow',
  })
  if (!response.ok) {
    throw new Error(`Failed to load PDF bytes: HTTP ${response.status}`)
  }

  const resolvedPdfTarget = resolvePdfTargetMetadata({
    requestedUrl: normalizedSourceUrl,
    finalUrl: response.url || normalizedSourceUrl,
    contentType: response.headers.get('content-type'),
    contentDisposition: response.headers.get('content-disposition'),
  })

  return {
    sourceUrl: resolvedPdfTarget?.sourceUrl || normalizedSourceUrl,
    title: normalizeText(title) || resolvedPdfTarget?.title || guessPdfTitle(normalizedSourceUrl, null),
    contentType:
      normalizeText(contentType)
      || resolvedPdfTarget?.contentType
      || response.headers.get('content-type')
      || 'application/pdf',
    bytes: Buffer.from(await response.arrayBuffer()),
  }
}

export function buildInternalPdfViewerUrl(
  shellUrl,
  {
    tabId = '',
    sourceUrl = '',
    title = '',
    contentType = '',
  } = {},
) {
  const url = new URL(PDF_VIEWER_PATH, shellUrl)
  url.searchParams.set('embedded', '1')
  if (normalizeText(tabId)) {
    url.searchParams.set('tabId', String(tabId))
  }
  if (normalizeText(sourceUrl)) {
    url.searchParams.set('source', String(sourceUrl))
  }
  if (normalizeText(title)) {
    url.searchParams.set('title', String(title))
  }
  if (normalizeText(contentType)) {
    url.searchParams.set('contentType', String(contentType))
  }
  return url.toString()
}

export function isInternalPdfViewerUrl(candidateUrl, shellUrl) {
  return readInternalPdfViewerState(candidateUrl, shellUrl) !== null
}
