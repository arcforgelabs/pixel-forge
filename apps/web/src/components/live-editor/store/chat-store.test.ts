import { beforeEach, describe, expect, it } from 'vitest'

import { type SelectedElement, useLiveEditorStore } from './chat-store'

function createSelection(
  id: string,
  overrides: Partial<Omit<SelectedElement, 'timestamp'>> = {}
) {
  return {
    id,
    selectorKind: 'dom' as const,
    surfaceKind: 'dom' as const,
    pageKey: 'https://example.com/',
    tagName: 'div',
    elementId: id,
    classList: ['card'],
    textContent: `Selection ${id}`,
    xpath: `//*[@id="${id}"]`,
    outerHTML: `<div id="${id}">Selection ${id}</div>`,
    rootXPath: null,
    rootTagName: null,
    rootElementId: null,
    rootClassList: [],
    region: null,
    previewDataUrl: null,
    sourceTabId: 'tab-a',
    sourceTabLabel: 'Example',
    sourceUrl: 'https://example.com/',
    pageTitle: 'Example',
    ...overrides,
  }
}

describe('live editor selection history', () => {
  beforeEach(() => {
    useLiveEditorStore.setState({
      selectedElements: [],
      selectionUndoStack: [],
      selectionRedoStack: [],
    })
  })

  it('preserves selection order through replace, undo, and redo', () => {
    const store = useLiveEditorStore.getState()

    store.addElement(createSelection('one'))
    store.addElement(createSelection('two'))
    store.addElement(createSelection('three'))

    store.replaceElement('two', createSelection('two', {
      elementId: 'promoted',
      xpath: '/html/body/main[1]',
      textContent: 'Promoted container',
      outerHTML: '<main id="promoted">Promoted container</main>',
    }))

    expect(useLiveEditorStore.getState().selectedElements.map((entry) => entry.id)).toEqual([
      'one',
      'two',
      'three',
    ])
    expect(useLiveEditorStore.getState().selectedElements[1]?.xpath).toBe('/html/body/main[1]')

    store.undoSelectionChange()
    expect(useLiveEditorStore.getState().selectedElements[1]?.xpath).toBe('//*[@id="two"]')

    store.redoSelectionChange()
    expect(useLiveEditorStore.getState().selectedElements[1]?.xpath).toBe('/html/body/main[1]')
  })

  it('treats bulk remove and clear as single undo steps', () => {
    const store = useLiveEditorStore.getState()

    store.addElement(createSelection('one'))
    store.addElement(createSelection('two'))
    store.addElement(createSelection('three'))
    store.removeElements(['one', 'three'])

    expect(useLiveEditorStore.getState().selectedElements.map((entry) => entry.id)).toEqual([
      'two',
    ])

    store.undoSelectionChange()
    expect(useLiveEditorStore.getState().selectedElements.map((entry) => entry.id)).toEqual([
      'one',
      'two',
      'three',
    ])

    store.clearElements()
    expect(useLiveEditorStore.getState().selectedElements).toHaveLength(0)

    store.undoSelectionChange()
    expect(useLiveEditorStore.getState().selectedElements.map((entry) => entry.id)).toEqual([
      'one',
      'two',
      'three',
    ])
  })
})
