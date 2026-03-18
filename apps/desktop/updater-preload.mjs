import { contextBridge, ipcRenderer } from 'electron'

contextBridge.exposeInMainWorld('pixelForgeUpdater', {
  getState: () => ipcRenderer.invoke('pixel-forge-updater:get-state'),
})
