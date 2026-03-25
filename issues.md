# Open Issues

## Embedded Chromium Back/Forward Still Inconsistent

- Status: open
- Priority: limiting factor for browser-style preview fidelity

### Current truth

- Browser-tab back/forward no longer falls back to replaying the React URL cursor.
- Desktop preview navigation now uses Chromium/Electron committed navigation state.
- Self-mirror runtime isolation is fixed, so mirror-based debugging is usable again.

### Remaining failure

- Back/forward is still inconsistent across real sites.
- In a Pixel Forge mirror runtime, back/forward worked when navigating between states on `google.com`.
- In the same general flow, back/forward did **not** work correctly on `fielddoc.arcforge.au`.
- Observed behavior on failing targets has included either:
  - no visible navigation change, or
  - apparent reload of the current page instead of returning to the previous page/state.

### Root cause (found 2026-03-25)

- `shell-preload.mjs` (controller context) was missing `goBack` and `goForward` IPC bindings in the `pixelForgeDesktop.preview` bridge.
- `preview-preload.mjs` (mirror context) had them, which is why mirror targets worked.
- In controller mode, `desktopPreviewRef.current?.goBack` evaluated to `undefined`, so the browser navigation branch was skipped and the code fell through to the URL history cursor fallback — which doesn't actually navigate the BrowserView.
- Fix: added `goBack` and `goForward` bindings to `shell-preload.mjs`.

### Remaining concern

- Per-site inconsistency (e.g. google.com vs fielddoc.arcforge.au) may still exist due to different navigation event coverage (`did-navigate` vs `did-navigate-in-page` vs SPA-only state changes). Re-test after the preload fix lands to see if the per-site issue was a consequence of the missing bindings or a separate problem.
