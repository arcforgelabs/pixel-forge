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
  overlay: {
    pickList: (payload) => ipcRenderer.invoke('pixel-forge-overlay:pick-list', payload),
  },
  app: {
    focusShell: () =>
      ipcRenderer.invoke('pixel-forge-app:focus-shell'),
    getPreviewInputState: () =>
      ipcRenderer.invoke('pixel-forge-app:get-preview-input-state'),
    applyControllerUpdate: (payload) =>
      ipcRenderer.invoke('pixel-forge-app:apply-controller-update', payload),
    applyPendingControllerUpdate: (payload) =>
      ipcRenderer.invoke('pixel-forge-app:apply-pending-controller-update', payload),
    startControllerUpdate: (payload) =>
      ipcRenderer.send('pixel-forge-app:start-controller-update', payload),
    startPendingControllerUpdate: (payload) =>
      ipcRenderer.send('pixel-forge-app:start-pending-controller-update', payload),
    consumeBootstrapState: () =>
      ipcRenderer.invoke('pixel-forge-app:consume-bootstrap-state'),
    getPendingControllerUpdate: () =>
      ipcRenderer.invoke('pixel-forge-app:get-pending-controller-update'),
    getRuntimeInfo: () =>
      ipcRenderer.invoke('pixel-forge-app:get-runtime-info'),
    getDismissedControllerUpdateId: () =>
      ipcRenderer.invoke('pixel-forge-app:get-dismissed-controller-update-id'),
    setDismissedControllerUpdateId: (updateId) =>
      ipcRenderer.invoke('pixel-forge-app:set-dismissed-controller-update-id', { updateId }),
    getControllerUpdateApplyState: () =>
      ipcRenderer.invoke('pixel-forge-app:get-controller-update-apply-state'),
    stageControllerUpdate: (payload) =>
      ipcRenderer.invoke('pixel-forge-app:stage-controller-update', payload),
    dismissPendingControllerUpdate: () =>
      ipcRenderer.invoke('pixel-forge-app:dismiss-controller-update'),
  },
})
