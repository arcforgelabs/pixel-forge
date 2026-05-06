import { contextBridge, ipcRenderer } from 'electron'
import { installSelectionBridge } from './selection-engine.mjs'

function emit(type, data = {}) {
  ipcRenderer.send('pixel-forge-preview:event', { type, data })
}

function installWebglFailureDiagnostics() {
  if (
    process.env.PIXEL_FORGE_PREVIEW_WEBGL_DIAGNOSTICS === '0'
    || typeof HTMLCanvasElement === 'undefined'
    || !HTMLCanvasElement.prototype?.getContext
  ) {
    return
  }

  window.addEventListener('message', (event) => {
    const payload = event.data?.__pixelForgeWebglDiagnostic
    if (payload && typeof payload === 'object') {
      emit('webgl-diagnostic', payload)
    }
  })

  const source = `(() => {
    if (window.__pixelForgeWebglDiagnosticInstalled) return;
    window.__pixelForgeWebglDiagnosticInstalled = true;
    const webglTypes = new Set(['webgl', 'webgl2', 'experimental-webgl']);
    const states = new WeakMap();
    const originalGetContext = HTMLCanvasElement.prototype.getContext;
    function describe(canvas) {
      const rect = canvas.getBoundingClientRect?.();
      return {
        className: typeof canvas.className === 'string' ? canvas.className : '',
        id: typeof canvas.id === 'string' ? canvas.id : '',
        width: canvas.width ?? null,
        height: canvas.height ?? null,
        clientWidth: rect?.width ?? null,
        clientHeight: rect?.height ?? null,
      };
    }
    HTMLCanvasElement.prototype.getContext = function(type, ...args) {
      const normalizedType = String(type || '').toLowerCase();
      const result = originalGetContext.call(this, type, ...args);
      if (!webglTypes.has(normalizedType)) return result;
      const current = states.get(this) || { succeeded: false, reported: false, failedTypes: [] };
      if (result) {
        current.succeeded = true;
        states.set(this, current);
        return result;
      }
      if (!current.failedTypes.includes(normalizedType)) current.failedTypes.push(normalizedType);
      states.set(this, current);
      window.setTimeout(() => {
        const latest = states.get(this);
        if (!latest || latest.succeeded || latest.reported) return;
        latest.reported = true;
        states.set(this, latest);
        const payload = {
          reason: 'context-null',
          requestedTypes: latest.failedTypes,
          url: window.location.href,
          canvas: describe(this),
          fallbackClassPresent: document.documentElement.classList.contains('webgl-hero-fallback'),
        };
        console.warn('[pixel-forge] Preview WebGL context creation failed', payload);
        window.postMessage({ __pixelForgeWebglDiagnostic: payload }, '*');
      }, 0);
      return result;
    };
  })();`

  const inject = () => {
    const script = document.createElement('script')
    script.textContent = source
    ;(document.documentElement || document.head || document.body)?.appendChild(script)
    script.remove()
  }

  if (document.documentElement || document.head || document.body) {
    inject()
  } else {
    window.addEventListener('DOMContentLoaded', inject, { once: true })
  }
}

installWebglFailureDiagnostics()

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
