const INTERNAL_PDF_VIEWER_PATH = '/internal/pdf-viewer'
const PDF_FILENAME_RE = /\.pdf$/i
const CHROMIUM_ERROR_PROTOCOL = 'chrome-error:'
const CHROMIUM_ERROR_HOST = 'chromewebdata'

function normalizeText(value: string | null | undefined): string {
  return String(value || '').trim()
}

function parseUrl(value: string): URL | null {
  try {
    return new URL(value)
  } catch {
    return null
  }
}

function isRejectedPreviewUrl(value: string | null | undefined): boolean {
  const normalizedValue = normalizeText(value)
  if (!normalizedValue) {
    return true
  }

  const parsed = parseUrl(normalizedValue)
  if (!parsed) {
    return false
  }

  return (
    parsed.protocol === CHROMIUM_ERROR_PROTOCOL
    || (parsed.protocol === 'chrome:' && parsed.hostname === CHROMIUM_ERROR_HOST)
  )
}

export function isInternalPdfViewerUrl(value: string | null | undefined): boolean {
  const normalizedValue = normalizeText(value)
  if (!normalizedValue) {
    return false
  }

  const parsed = parseUrl(normalizedValue)
  return parsed?.pathname === INTERNAL_PDF_VIEWER_PATH
}

export function embeddedPdfSourceUrl(value: string | null | undefined): string | null {
  const normalizedValue = normalizeText(value)
  if (!normalizedValue) {
    return null
  }

  const parsed = parseUrl(normalizedValue)
  if (parsed?.pathname !== INTERNAL_PDF_VIEWER_PATH) {
    return null
  }

  const sourceUrl = normalizeText(parsed.searchParams.get('source'))
  return sourceUrl || null
}

export function looksLikePdfUrl(value: string | null | undefined): boolean {
  const normalizedValue = normalizeText(value)
  if (!normalizedValue) {
    return false
  }

  const parsed = parseUrl(normalizedValue)
  const pathname = parsed
    ? decodeURIComponent(parsed.pathname || '')
    : normalizedValue.split(/[?#]/, 1)[0]
  return PDF_FILENAME_RE.test(pathname)
}

export function normalizePersistedPreviewUrl(
  value: string | null | undefined,
  fallbackUrl?: string | null
): string {
  const normalizedValue = normalizeText(value)
  if (!normalizedValue) {
    return ''
  }

  const normalizedFallback = normalizeText(fallbackUrl)
  if (isRejectedPreviewUrl(normalizedValue)) {
    return isRejectedPreviewUrl(normalizedFallback) ? '' : normalizedFallback
  }

  if (!isInternalPdfViewerUrl(normalizedValue)) {
    return normalizedValue
  }

  const embeddedSource = embeddedPdfSourceUrl(normalizedValue)
  if (embeddedSource) {
    return embeddedSource
  }

  return isRejectedPreviewUrl(normalizedFallback) ? '' : normalizedFallback
}

export function findLatestRecoverablePdfUrl(
  candidates: Array<string | null | undefined>
): string | null {
  for (let index = candidates.length - 1; index >= 0; index -= 1) {
    const normalizedCandidate = normalizePersistedPreviewUrl(candidates[index])
    if (normalizedCandidate && looksLikePdfUrl(normalizedCandidate)) {
      return normalizedCandidate
    }
  }

  return null
}
