import { contextBridge, ipcRenderer } from 'electron'

contextBridge.exposeInMainWorld('pixelForgeUpdater', {
  getState: () => ipcRenderer.invoke('pixel-forge-updater:get-state'),
  window: {
    minimize: () => ipcRenderer.invoke('pixel-forge-window:minimize'),
    toggleMaximize: () => ipcRenderer.invoke('pixel-forge-window:toggle-maximize'),
    close: () => ipcRenderer.invoke('pixel-forge-window:close'),
  },
})
