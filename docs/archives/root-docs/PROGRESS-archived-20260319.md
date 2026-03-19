# Progress

## Validated

- Pixel Forge now has one canonical runtime layout: `apps/api` and `apps/web`.
- The nested `screenshot-to-code` product boundary is gone from the runtime path.
- The dead eval UI was removed from `apps/web`.
- Cloud-only Pico surfaces were removed from the local product path.
- The MCP adapter was removed from `packages/` and archived out of the default product surface.
- The backend test harness now uses origin-relative API and WebSocket URLs.

## Current Shape

```text
apps/api
  screenshot bootstrap
  live editor websocket
  app proxy
  save-code endpoint

apps/web
  Screenshot tab
  Live Editor tab
  shared session state
```

## Unvalidated

- Field-specific target profiles and launch helpers are not wired yet.
- The optional adapters under `packages/` still carry some legacy naming and docs.
- The repo has not yet been exercised end-to-end against the Field app itself.

## Next Limiting Factor

Wire Pixel Forge to the Field dev/deployed app and prove the full loop:

`load app -> select element -> send context -> edit code -> watch app update`
