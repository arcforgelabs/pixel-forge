import { describe, expect, test } from 'vitest'

import { buildSelectionArtifacts } from './selection-engine'

describe('buildSelectionArtifacts', () => {
  test('builds structured tunnel and attachments for dom and region selections', () => {
    const artifacts = buildSelectionArtifacts([
      {
        id: 'dom-selection',
        selectorKind: 'dom',
        surfaceKind: 'dom',
        pageKey: 'https://example.com/app',
        tagName: 'button',
        elementId: 'save-button',
        classList: ['btn', 'btn-primary'],
        textContent: 'Save changes',
        xpath: '//*[@id="save-button"]',
        outerHTML: '<button id="save-button">Save changes</button>',
        rootXPath: null,
        rootTagName: null,
        rootElementId: null,
        rootClassList: [],
        region: null,
        previewDataUrl: 'data:image/jpeg;base64,AAA=',
        sourceTabId: 'tab-1',
        sourceTabLabel: 'App',
        sourceUrl: 'https://example.com/app',
        pageTitle: 'Example App',
      },
      {
        id: 'region-selection',
        selectorKind: 'region',
        surfaceKind: 'canvas',
        pageKey: 'https://example.com/game',
        tagName: 'canvas',
        elementId: null,
        classList: [],
        textContent: '',
        xpath: '',
        outerHTML: '<canvas class="game-stage"></canvas>',
        rootXPath: '/html/body/canvas[1]',
        rootTagName: 'canvas',
        rootElementId: null,
        rootClassList: ['game-stage'],
        region: {
          x: 40,
          y: 24,
          width: 160,
          height: 96,
          normalizedX: 0.1,
          normalizedY: 0.2,
          normalizedWidth: 0.4,
          normalizedHeight: 0.3,
          anchorX: 0.18,
          anchorY: 0.35,
        },
        previewDataUrl: 'data:image/jpeg;base64,BBB=',
        sourceTabId: 'tab-2',
        sourceTabLabel: 'Game',
        sourceUrl: 'https://example.com/game',
        pageTitle: 'Example Game',
      },
      {
        id: 'pdf-selection',
        selectorKind: 'dom',
        surfaceKind: 'pdf',
        pageKey: 'https://example.com/spec.pdf#page=4',
        tagName: 'pdf-text',
        elementId: null,
        classList: ['pdf-text'],
        textContent: 'The controller must preserve the live preview session.',
        xpath: '/html/body/div[1]/div[2]/span[5]',
        outerHTML: '<span data-pf-pdf-text="1">The controller must preserve the live preview session.</span>',
        rootXPath: null,
        rootTagName: null,
        rootElementId: null,
        rootClassList: [],
        region: null,
        pdfPage: 4,
        pdfTextContent: 'The controller must preserve the live preview session.',
        previewDataUrl: null,
        sourceTabId: 'tab-3',
        sourceTabLabel: 'Spec',
        sourceUrl: 'https://example.com/spec.pdf',
        pageTitle: 'Spec PDF',
      },
    ])

    expect(artifacts.attachments).toHaveLength(2)
    expect(artifacts.attachments[0].name).toContain('selection-01')
    expect(artifacts.attachments[1].name).toContain('canvas-region')
    expect(artifacts.tunnel.selections).toHaveLength(3)
    expect(artifacts.tunnel.selections[1].selectorKind).toBe('region')
    expect(artifacts.tunnel.selections[1].previewAttachmentName).toBe(
      artifacts.attachments[1].name
    )
    expect(artifacts.tunnel.selections[2].surfaceKind).toBe('pdf')
    expect(artifacts.tunnel.selections[2].pdfPage).toBe(4)
    expect(artifacts.tunnel.selections[2].pdfTextContent).toContain('live preview session')
    expect(artifacts.elementContext).toContain('selector="dom"')
    expect(artifacts.elementContext).toContain('selector="region"')
    expect(artifacts.elementContext).toContain('<pdf-page>4</pdf-page>')
    expect(artifacts.elementContext).toContain('<pdf-text>')
    expect(artifacts.elementContext).toContain('<preview-attachment>')
  })
})
