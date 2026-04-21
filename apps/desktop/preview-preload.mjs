import { contextBridge, ipcRenderer } from 'electron'
import { installSelectionBridge } from './selection-engine.mjs'

function emit(type, data = {}) {
  ipcRenderer.send('pixel-forge-preview:event', { type, data })
}

ipcRenderer.on('pixel-forge-preview:event', (_event, payload) => {
  window.dispatchEvent(new CustomEvent('pixel-forge-preview', { detail: payload }))
})

async function captureRegion(rect) {
  return ipcRenderer.invoke('pixel-forge-preview:capture-region', rect)
}

const bridge = installSelectionBridge({
  emit,
  captureRegion,
})

// Preview pages must not receive the full desktop bridge. Pixel Forge can render
// itself as a preview target during self-edit; exposing outer BrowserView control
// there lets the nested app recursively spawn/manage the parent preview surface.
contextBridge.exposeInMainWorld('__pixelForgePreviewBridge', {
  emitEvent: (type, data = {}) => emit(type, data),
  inspectLiveContext: (payload) => bridge.inspectLiveContext(payload),
  readPdfPreviewSource: (payload = {}) => ipcRenderer.invoke('pixel-forge-preview:get-pdf-document', payload),
})

ipcRenderer.on('pixel-forge-preview:command', async (_event, command) => {
  if (command.type === 'set-tool') {
    bridge.setTool(command.tool ?? null)
    return
  }

  if (command.type === 'set-select-mode') {
    bridge.setSelectMode(Boolean(command.enabled))
    return
  }

  if (command.type === 'clear-selections') {
    await bridge.clearSelections()
    return
  }

  if (command.type === 'deselect') {
    await bridge.deselect(
      String(command.selectionId || ''),
      String(command.xpath || '')
    )
    return
  }

  if (command.type === 'apply-selections') {
    await bridge.applySelections(
      Array.isArray(command.selections)
        ? {
            selections: command.selections,
            reveal: Boolean(command.reveal),
          }
        : Array.isArray(command.xpaths)
          ? {
              selections: command.xpaths,
              reveal: Boolean(command.reveal),
            }
          : {
              selections: [],
              reveal: Boolean(command.reveal),
            }
    )
  }
})
