import { ipcRenderer } from 'electron'
import { installSelectionBridge } from './selection-engine.mjs'

function emit(type, data = {}) {
  ipcRenderer.send('pixel-forge-preview:event', { type, data })
}

async function captureRegion(rect) {
  return ipcRenderer.invoke('pixel-forge-preview:capture-region', rect)
}

const bridge = installSelectionBridge({
  emit,
  captureRegion,
})

ipcRenderer.on('pixel-forge-preview:command', async (_event, command) => {
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
