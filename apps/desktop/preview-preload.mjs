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

function shouldExposeDesktopBridge() {
  try {
    const hostname = String(window.location.hostname || '').toLowerCase()
    return hostname.endsWith('.localhost') && hostname.includes('pixel-forge')
  } catch {
    return false
  }
}

if (shouldExposeDesktopBridge()) {
  contextBridge.exposeInMainWorld('pixelForgeDesktop', {
    preview: {
      load: (payload) => ipcRenderer.invoke('pixel-forge-preview:load', payload),
      show: (tabId) => ipcRenderer.invoke('pixel-forge-preview:show', { tabId }),
      activate: (tabId) => ipcRenderer.invoke('pixel-forge-preview:activate', { tabId }),
      focus: (tabId) => ipcRenderer.invoke('pixel-forge-preview:focus', { tabId }),
      refresh: (tabId) => ipcRenderer.invoke('pixel-forge-preview:refresh', { tabId }),
      close: (tabId) => ipcRenderer.invoke('pixel-forge-preview:close', { tabId }),
      setTool: (tabId, tool) =>
        ipcRenderer.invoke('pixel-forge-preview:set-tool', { tabId, tool }),
      setSelectMode: (tabId, enabled) =>
        ipcRenderer.invoke('pixel-forge-preview:set-select-mode', { tabId, enabled }),
      clearSelections: (tabId) =>
        ipcRenderer.invoke('pixel-forge-preview:clear-selections', { tabId }),
      deselect: (tabId, selectionId) =>
        ipcRenderer.invoke('pixel-forge-preview:deselect', { tabId, selectionId }),
      applySelections: (tabId, selections) =>
        ipcRenderer.invoke('pixel-forge-preview:apply-selections', { tabId, selections }),
      setBounds: (bounds) => ipcRenderer.invoke('pixel-forge-preview:set-bounds', bounds),
      hide: () => ipcRenderer.invoke('pixel-forge-preview:hide'),
    },
    app: {
      focusShell: () => ipcRenderer.invoke('pixel-forge-app:focus-shell'),
      getPreviewInputState: () => ipcRenderer.invoke('pixel-forge-app:get-preview-input-state'),
    },
    overlay: {
      pickList: (payload) => ipcRenderer.invoke('pixel-forge-overlay:pick-list', payload),
    },
  })
}

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
        ? command.selections
        : Array.isArray(command.xpaths)
          ? command.xpaths
          : []
    )
  }
})
