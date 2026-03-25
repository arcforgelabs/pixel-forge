import { describe, expect, it } from 'vitest'

import {
  embeddedPdfSourceUrl,
  isInternalPdfViewerUrl,
  normalizePersistedPreviewUrl,
} from './preview-url'

describe('preview-url helpers', () => {
  const helperUrl = 'http://pixel-forge-alpha.localhost:7201/internal/pdf-viewer?embedded=1&tabId=preview-123&source=file%3A%2F%2F%2Ftmp%2Fquote.pdf&title=quote.pdf'
  const failingUrl = 'chrome-error://chromewebdata/'

  it('recognizes internal pdf viewer urls', () => {
    expect(isInternalPdfViewerUrl(helperUrl)).toBe(true)
    expect(isInternalPdfViewerUrl('file:///tmp/quote.pdf')).toBe(false)
  })

  it('extracts and normalizes the embedded pdf source url', () => {
    expect(embeddedPdfSourceUrl(helperUrl)).toBe('file:///tmp/quote.pdf')
    expect(normalizePersistedPreviewUrl(helperUrl)).toBe('file:///tmp/quote.pdf')
  })

  it('rejects chromium error pages and falls back to the last stable target', () => {
    expect(normalizePersistedPreviewUrl(failingUrl, 'http://localhost:3002/admin/control-room')).toBe(
      'http://localhost:3002/admin/control-room'
    )
    expect(normalizePersistedPreviewUrl(failingUrl)).toBe('')
  })
})
