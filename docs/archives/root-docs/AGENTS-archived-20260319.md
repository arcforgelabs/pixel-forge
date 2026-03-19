# Pixel Forge - Agent Notes

- When proving or inspecting the live UI in a visible browser, launch Pixel Forge in a maximized window sized to the current display. Fixed demo-sized browser windows are misleading because they clip the shell layout.
- `./start-dev.sh` is the canonical launcher. It now auto-opens the Pixel Forge desktop shell when a GUI display is available. Set `PIXEL_FORGE_USE_DESKTOP_SHELL=0` to force the raw browser path for debugging, or `PIXEL_FORGE_NO_BROWSER=1` to suppress auto-open entirely.
- `pnpm verify` is the canonical proof lane. It checks version sync, shell syntax, API/desktop/web health, isolated install smoke, and staged controller-update apply/rollback smoke.
- `SPECS.md` is the active repo truth. If runtime/docs drift, update the spec first.
- Live Editor is Agent Deck-backed. Each request is written to `.pixel-forge/requests/<request-id>/...` inside the target project, and the browser UI should treat the returned Live Editor thread ID as a Pixel Forge broker handle, not as a raw Claude session ID.
- If the install/update lane changes, do not apply stale pending controller-update snapshots created by an older controller build. Clear and restage them from the current repo truth instead.
- See `CLAUDE.md` for the rest of the repo-specific operating context.
