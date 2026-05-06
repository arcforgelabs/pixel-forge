# Open Issues

## Agent-Opened Browser Tabs Are Not Operator-Visible

- Status: patch added locally; needs release/controller update validation
- Priority: workflow blocker for agent-prepared local previews
- Reported: 2026-05-07

### Current truth

- The browser broker can open a local dev server from an agent command:
  - `pixel-forge browser open http://127.0.0.1:8017/ --project "/home/samuel/repos/2-areas/arc-forge-website" --chat "chat-66dd2bfd1455"`
- The command returns a real resident tab that agents can inspect and screenshot:
  - `tab_id`: `broker-chat-66dd2bfd1455-moup2f8h-a9ade2`
  - `project_path`: `/home/samuel/repos/2-areas/arc-forge-website`
  - `chat_id`: `chat-66dd2bfd1455`
  - `url`: `http://127.0.0.1:8017/`
  - `title`: `Arc Forge | Websites, Agents, Software`
- `pixel-forge browser tabs` shows that tab with `owner_kind: agent`.
- The operator did not see that tab in the normal Pixel Forge UI, while operator-owned tabs for the same project/chat were visible.

### Root cause

- `apps/api/pixel_forge_cli.py` hard-codes `owner_kind: "agent"` in `_command_browser_open`.
- `apps/desktop/main.mjs` accepts `owner_kind` / `ownerKind`, defaulting to `agent` when none is supplied.
- UI-created preview tabs use `ownerKind: 'operator'` in `apps/web/src/components/live-editor/LiveEditorPane.tsx`.
- The CLI has no `--owner` / `--owner-kind` flag, and there is no obvious promotion path from an agent-owned broker tab to an operator-visible tab.

### Desired behavior

- Agents should be able to start a localhost dev server and open it as a normal operator-visible Pixel Forge preview tab for the current project/chat.
- The operator should be able to find that tab without knowing the broker tab id.
- The resulting tab should be active by default unless `--background` is passed.

### Proposed design

- Add an explicit CLI option:
  - `pixel-forge browser open <url> --project <path> --chat <chat-id> --owner operator`
- Restrict accepted owner values to `agent` and `operator`.
- Keep the current default as `agent` if needed for backward compatibility, but make operator-visible open available.
- Surface an event/toast in the Pixel Forge UI when an agent opens an operator-visible tab, including the URL and project/chat binding.

### Local patch

- Added `--owner-kind` / `--owner` to `apps/api/pixel_forge_cli.py` for `pixel-forge browser open`.
- Added regression coverage in `apps/api/test_pixel_forge_cli.py`.
- Validated with the repo-local wrapper:
  - `/home/samuel/repos/3-resources/pixel-forge/pixel-forge browser open http://127.0.0.1:8017/ --project "/home/samuel/repos/2-areas/arc-forge-website" --chat "chat-66dd2bfd1455" --owner operator --tab-id preview-arcforge-local-8017`
  - Broker returned `owner_kind: operator`, `active: true`, title `Arc Forge | Websites, Agents, Software`.

### Acceptance criteria

- Running the command with `--owner operator` creates or focuses a tab visible in the Pixel Forge UI for the specified project/chat.
- `pixel-forge browser tabs` reports `owner_kind: operator` for that tab.
- The tab can still be inspected, screenshotted, clicked, typed into, and navigated by tab id.
- If the project/chat scope is invalid or no operator shell is available, the CLI fails with a clear error instead of silently creating a hidden agent tab.

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
