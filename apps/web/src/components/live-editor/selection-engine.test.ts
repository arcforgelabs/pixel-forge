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
    ])

    expect(artifacts.attachments).toHaveLength(2)
    expect(artifacts.attachments[0].name).toContain('selection-01')
    expect(artifacts.attachments[1].name).toContain('canvas-region')
    expect(artifacts.tunnel.selections).toHaveLength(2)
    expect(artifacts.tunnel.selections[1].selectorKind).toBe('region')
    expect(artifacts.tunnel.selections[1].previewAttachmentName).toBe(
      artifacts.attachments[1].name
    )
    expect(artifacts.elementContext).toContain('selector="dom"')
    expect(artifacts.elementContext).toContain('selector="region"')
    expect(artifacts.elementContext).toContain('<preview-attachment>')
  })
})
