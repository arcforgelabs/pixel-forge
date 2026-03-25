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

### Why this is likely still happening

- The current implementation is closer to the right architecture, but browser navigation facts are still being observed through multiple event paths.
- Different sites may rely on different navigation mechanisms:
  - full document navigations
  - same-document SPA navigations
  - redirect/auth transitions
  - nested frame transitions
- The current committed-event coverage appears sufficient for some sites and insufficient for others.

### Next debugging target

- Reproduce in a maximized installed alpha shell on:
  - `google.com`
  - `fielddoc.arcforge.au`
- Compare BrowserView event sequences for:
  - `did-navigate`
  - `did-navigate-in-page`
  - `page-title-updated`
  - any frame-level navigation events if needed
- Inspect Electron `navigationHistory` state before and after the failing transition.
- Confirm whether the failing site is navigating in the top frame, a child frame, or only mutating app state without producing the events we currently trust.

### Likely fix direction

- Keep Chromium as the only navigation source of truth.
- Remove or further narrow any remaining duplicate location-reporting paths.
- Expand browser event coverage only where real failing sites prove it is required.
- Do not reintroduce React/browser-history replay as a fallback for embedded browser tabs.
