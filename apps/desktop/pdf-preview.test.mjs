import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import {
  buildInternalPdfViewerUrl,
  contentDispositionLooksLikePdf,
  detectPdfPreviewTarget,
  isInternalPdfViewerUrl,
  isPdfContentType,
  looksLikePdfUrl,
  readPdfDocumentSource,
  readInternalPdfViewerState,
  resolvePdfTargetMetadata,
} from './pdf-preview.mjs'

test('recognizes pdf urls and pdf response metadata', () => {
  assert.equal(looksLikePdfUrl('https://example.com/manual.pdf?download=1'), true)
  assert.equal(looksLikePdfUrl('https://example.com/download?id=7'), false)
  assert.equal(isPdfContentType('application/pdf; charset=binary'), true)
  assert.equal(
    contentDispositionLooksLikePdf('attachment; filename="project-spec.pdf"'),
    true,
  )

  assert.deepEqual(
    resolvePdfTargetMetadata({
      requestedUrl: 'https://example.com/download?id=7',
      finalUrl: 'https://example.com/download?id=7',
      contentType: 'application/pdf',
      contentDisposition: 'attachment; filename="project-spec.pdf"',
    }),
    {
      sourceUrl: 'https://example.com/download?id=7',
      title: 'project-spec.pdf',
      contentType: 'application/pdf',
    },
  )
})

test('detectPdfPreviewTarget falls back to session fetch for content-type based pdfs', async () => {
  const previewSession = {
    fetch: async (_url, init = {}) => {
      if (init.method === 'HEAD') {
        return {
          url: 'https://example.com/secure/export',
          headers: {
            get(name) {
              const normalizedName = String(name || '').toLowerCase()
              if (normalizedName === 'content-type') {
                return 'application/pdf'
              }
              if (normalizedName === 'content-disposition') {
                return 'inline; filename="export.pdf"'
              }
              return null
            },
          },
        }
      }
      throw new Error('GET should not be reached when HEAD proves pdf')
    },
  }

  assert.deepEqual(
    await detectPdfPreviewTarget(previewSession, 'https://example.com/secure/export'),
    {
      sourceUrl: 'https://example.com/secure/export',
      title: 'export.pdf',
      contentType: 'application/pdf',
    },
  )
})

test('builds and recognizes the internal viewer url', () => {
  const viewerUrl = buildInternalPdfViewerUrl('http://pixel-forge.localhost:7001', {
    tabId: 'tab-7',
    sourceUrl: 'file:///tmp/quote.pdf',
    title: 'Quote.pdf',
    contentType: 'application/pdf',
  })
  assert.equal(
    viewerUrl,
    'http://pixel-forge.localhost:7001/internal/pdf-viewer?embedded=1&tabId=tab-7&source=file%3A%2F%2F%2Ftmp%2Fquote.pdf&title=Quote.pdf&contentType=application%2Fpdf',
  )
  assert.equal(
    isInternalPdfViewerUrl(viewerUrl, 'http://pixel-forge.localhost:7001'),
    true,
  )
  assert.equal(
    isInternalPdfViewerUrl('https://example.com/manual.pdf', 'http://pixel-forge.localhost:7001'),
    false,
  )
  assert.deepEqual(
    readInternalPdfViewerState(viewerUrl, 'http://pixel-forge.localhost:7001'),
    {
      tabId: 'tab-7',
      sourceUrl: 'file:///tmp/quote.pdf',
      title: 'Quote.pdf',
      contentType: 'application/pdf',
    },
  )
})

test('readPdfDocumentSource loads local file urls from disk', async () => {
  const tempDir = mkdtempSync(path.join(os.tmpdir(), 'pixel-forge-pdf-'))
  const pdfPath = path.join(tempDir, 'quote.pdf')
  const pdfBytes = Buffer.from('%PDF-1.4\n1 0 obj\n<<>>\nendobj\n%%EOF\n', 'utf8')
  writeFileSync(pdfPath, pdfBytes)

  try {
    const result = await readPdfDocumentSource({
      previewSession: null,
      sourceUrl: `file://${pdfPath}`,
    })

    assert.equal(result.sourceUrl, `file://${pdfPath}`)
    assert.equal(result.title, 'quote.pdf')
    assert.equal(result.contentType, 'application/pdf')
    assert.equal(Buffer.compare(Buffer.from(result.bytes), pdfBytes), 0)
  } finally {
    rmSync(tempDir, { recursive: true, force: true })
  }
})
