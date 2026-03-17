import { contextBridge, ipcRenderer } from 'electron'

ipcRenderer.on('pixel-forge-preview:event', (_event, payload) => {
  window.dispatchEvent(new CustomEvent('pixel-forge-preview', { detail: payload }))
})

ipcRenderer.on('pixel-forge-app:event', (_event, payload) => {
  window.dispatchEvent(new CustomEvent('pixel-forge-app', { detail: payload }))
})

contextBridge.exposeInMainWorld('pixelForgeDesktop', {
  preview: {
    load: (payload) => ipcRenderer.invoke('pixel-forge-preview:load', payload),
    activate: (tabId) => ipcRenderer.invoke('pixel-forge-preview:activate', { tabId }),
    focus: (tabId) => ipcRenderer.invoke('pixel-forge-preview:focus', { tabId }),
    refresh: (tabId) => ipcRenderer.invoke('pixel-forge-preview:refresh', { tabId }),
    close: (tabId) => ipcRenderer.invoke('pixel-forge-preview:close', { tabId }),
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
  overlay: {
    pickList: (payload) => ipcRenderer.invoke('pixel-forge-overlay:pick-list', payload),
  },
  app: {
    applyControllerUpdate: (payload) =>
      ipcRenderer.invoke('pixel-forge-app:apply-controller-update', payload),
    applyPendingControllerUpdate: (payload) =>
      ipcRenderer.invoke('pixel-forge-app:apply-pending-controller-update', payload),
    consumeBootstrapState: () =>
      ipcRenderer.invoke('pixel-forge-app:consume-bootstrap-state'),
    getPendingControllerUpdate: () =>
      ipcRenderer.invoke('pixel-forge-app:get-pending-controller-update'),
    stageControllerUpdate: (payload) =>
      ipcRenderer.invoke('pixel-forge-app:stage-controller-update', payload),
    dismissPendingControllerUpdate: () =>
      ipcRenderer.invoke('pixel-forge-app:dismiss-controller-update'),
  },
})
