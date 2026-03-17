import { contextBridge, ipcRenderer } from 'electron'

ipcRenderer.on('pixel-forge-overlay:list-init', (_event, payload) => {
  window.dispatchEvent(new CustomEvent('pixel-forge-overlay:list-init', { detail: payload }))
})

contextBridge.exposeInMainWorld('pixelForgeOverlay', {
  select: (value) => ipcRenderer.send('pixel-forge-overlay:list-selected', value),
  cancel: () => ipcRenderer.send('pixel-forge-overlay:list-cancel'),
})
