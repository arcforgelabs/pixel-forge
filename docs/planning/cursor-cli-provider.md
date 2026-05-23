# Cursor CLI Provider Integration Plan

Status: implemented in source, installed-runtime smoke pending
Created: 2026-05-24
Owner: Pixel Forge

## Why This Exists

Pixel Forge already routes agent turns through provider-neutral bindings:
`agent-deck`, `codex-cli`, and `claude-cli`. Cursor CLI should use that same
direct-provider boundary so the operator can choose Cursor from Settings and
send Live Editor turns directly to `cursor-agent` without Agent Deck.

The goal is not to embed the Cursor IDE. The goal is a native Pixel Forge
provider that launches and resumes Cursor CLI chats, parses CLI events for
Pixel Forge-owned turns, and preserves provider-neutral chat/session metadata.

## Current Cursor CLI Facts

Observed locally on 2026-05-24:

- `cursor-agent` is installed at `~/.local/bin/cursor-agent`.
- `cursor-agent --version` reports `2026.05.20-2b5dd59`.
- `cursor-agent status` reports an authenticated account.
- `cursor-agent models` exposes `composer-2.5` and `composer-2.5-fast`, with
  `composer-2.5-fast` marked as the default.

Official Cursor documentation and product pages currently establish:

- Cursor CLI is installed with `curl https://cursor.com/install -fsS | bash`.
- The command is `cursor-agent`.
- Browser login uses `cursor-agent login`; API-key auth can use
  `CURSOR_API_KEY` or `--api-key`.
- Headless use is `cursor-agent --print ...`.
- Supported headless formats include `text`, `json`, and `stream-json`.
- `json` emits one terminal result object; `stream-json` emits NDJSON events
  including system, user, assistant, tool-call, and result events.
- The CLI reads `.cursor/rules`, root `AGENTS.md`, and root `CLAUDE.md`.
- Global config is `~/.cursor/cli-config.json`; project permission config can
  live at `<project>/.cursor/cli.json`.
- Cursor 2.5 added plugins, sandbox access controls, async subagents, improved
  long-chat behavior, and inline sudo-prompt handling for the CLI agent.
- Composer 2.5 became available on 2026-05-18 and is positioned by Cursor as
  better for sustained long-running coding tasks than Composer 2.

Important integration note: search-indexed docs said the default print output
format was `stream-json`, but the installed CLI help for
`2026.05.20-2b5dd59` says the default is `text`. Pixel Forge must always pass
`--output-format stream-json` explicitly.

Sources:

- https://cursor.com/en-US/cli
- https://cursor.com/docs/cli/installation
- https://cursor.com/docs/cli/using
- https://cursor.com/docs/cli/headless
- https://cursor.com/docs/cli/reference/authentication
- https://cursor.com/docs/cli/reference/parameters
- https://cursor.com/docs/cli/reference/output-format
- https://cursor.com/docs/cli/reference/configuration
- https://cursor.com/docs/cli/reference/permissions
- https://cursor.com/changelog/2-5
- https://cursor.com/changelog/composer-2-5

## Target Shape

Add a first-class direct provider:

- Provider id: `cursor-cli`
- Display name: `Cursor CLI`
- Primary agent id: `cursor`
- Default model: `composer-2.5-fast`
- Preferred coding model: `composer-2.5` or `composer-2.5-fast`, selectable in
  the existing model field.
- Config home: `CURSOR_CONFIG_DIR` when set, otherwise `~/.cursor`.
- Command resolution: `PIXEL_FORGE_CURSOR_AGENT_CMD`, then `cursor-agent` on
  `PATH`, then common user binary paths used by the Codex resolver.

Capabilities for the first implementation:

- `launch`: true
- `send`: true
- `observe`: true, from `stream-json` output for Pixel Forge-owned turns
- `open_tui`: true when a provider session id exists
- `list_sessions`: false initially, unless `cursor-agent ls` proves stable and
  machine-readable
- `rename`: false initially
- `delete`: false initially
- `closeout`: false initially

## Transport Design

### Create Session

Preferred path:

```bash
cursor-agent create-chat
```

Use the returned chat id as `provider_session_id`.

Fallback path if `create-chat` is unavailable or fails:

- Start the first headless turn without `--resume`.
- Parse the `session_id` from the `system` or terminal `result` event.
- Persist that id as the provider session id.

### Dispatch Turn

Run headless from the project workspace:

```bash
cursor-agent \
  --print \
  --output-format stream-json \
  --stream-partial-output \
  --trust \
  --force \
  --approve-mcps \
  --workspace "$PROJECT_PATH" \
  --resume "$PROVIDER_SESSION_ID" \
  --model "$MODEL" \
  "$PROMPT"
```

Mapping rules:

- `request.prompt` is the turn body.
- `request.agent_model` maps directly to `--model`.
- `AgentTurnPolicy(no_approval=True)` maps to `--force`, `--trust`, and
  `--approve-mcps`. Pixel Forge Live Editor currently constructs no-approval
  turns, so this keeps the subprocess non-interactive.
- `image_paths` are not a first-class Cursor CLI flag in the observed help.
  Initial support should append local image paths to the prompt as references
  and then verify whether Cursor can inspect them in practice.
- stderr should be retained for failure diagnostics but not streamed as
  assistant output.

### Parse Stream

Consume newline-delimited JSON:

- `system` with `session_id`: bind the chat if no provider session id is stored.
- `assistant`: append text deltas into Pixel Forge turn chunks.
- `tool_call` started/completed: publish compact progress events such as read,
  write, shell, search, and MCP tool activity.
- terminal `result`: mark the turn complete, store `request_id`,
  `duration_ms`, and final result text.
- non-zero exit or missing terminal event: mark the turn failed and surface
  stderr plus the last parsed event type.

Consumers must ignore unknown fields because Cursor documents field additions
as backward-compatible.

### Open TUI

Wire `chat-items/open-tui` for `cursor-cli` to:

```bash
cursor-agent --workspace "$WORKSPACE_PATH" --resume "$PROVIDER_SESSION_ID"
```

Use the existing terminal launcher helper with a `pixel-forge-cursor-cli`
window class. Do not open a Cursor IDE window; this is the CLI/TUI lane.

## Pixel Forge Code Changes

Backend:

- Add `apps/api/agent_provider_plugins/cursor_cli.py`.
- Add `apps/api/agent_providers/cursor_cli.py` as the compatibility re-export.
- Register `CursorCliProvider` in
  `apps/api/agent_providers/registry.py`.
- Extend provider-id validation in `apps/api/main.py` from
  `agent-deck | claude-cli | codex-cli` to include `cursor-cli`.
- Add `_open_cursor_cli_tui_terminal` and route `cursor-cli` in
  `/chat-items/open-tui`.
- Extend `ProjectSessionUpsertRequest`, `AgentDeckSessionRequest` usage, and
  provider fallback checks only where literal unions currently block the new
  provider.
- Add tests in `apps/api/test_agent_providers.py` for command resolution,
  status diagnostics, stream parsing, create-session behavior, dispatch argv,
  and TUI dry-run output.

Frontend:

- Add `cursor-cli` to provider normalization in
  `apps/web/src/store/session-store.ts`.
- Add `cursor` to agent type normalization where needed.
- Add labels in `apps/web/src/lib/agent-labels.ts` and tests.
- Add `cursor: "cursor-cli"` to the Settings direct-provider map.
- Include Cursor in Settings provider cards, default provider selection, model
  defaults, and chat creation payloads.
- Allow `Open TUI` for `cursor-cli` in Settings.
- Add focused tests for default provider persistence, direct-provider draft
  creation, chat-store send payloads, and Open TUI enablement.

Docs:

- Update `docs/agent-runtime-map.md` after the provider is implemented.
- Update `INTENT.md` only after a real installed-runtime Cursor turn passes;
  until then this file remains the planning source.

## Security And Operator Boundaries

- Do not store Cursor API keys in Pixel Forge state. Cursor auth belongs to
  Cursor's own config or the service environment.
- `CURSOR_API_KEY` may be detected as present for diagnostics, but its value
  must never be printed.
- The provider must not install Cursor automatically during normal Pixel Forge
  startup. It can report an install hint in diagnostics.
- `--force`, `--trust`, and `--approve-mcps` are only acceptable because Pixel
  Forge Live Editor turns are already no-approval dispatches. If a future UI
  adds an approval-required mode, the provider should reject non-interactive
  dispatch instead of hanging on prompts.
- Project-level Cursor permissions should be supported through
  `<project>/.cursor/cli.json`, not by mutating user-global
  `~/.cursor/cli-config.json`.

## Validation Plan

Backend unit tests:

- Provider appears in `/api/agent-providers` with config home and command.
- Missing command produces an unavailable provider with an actionable reason.
- `create_session` consumes `create-chat` output.
- `dispatch_turn` sends expected argv and parses `stream-json` events into
  final assistant output.
- Non-zero exit returns stderr in the provider error.
- Open TUI dry-run returns provider id, session id, title, workspace path, and
  command.

Frontend tests:

- Provider labels render `Cursor CLI`.
- Settings can persist `default_agent_provider_id: "cursor-cli"`.
- New chats created with Cursor keep Agent Deck compatibility fields null.
- Live Editor sends `target_provider_id: "cursor-cli"`.
- Open TUI is enabled for bound Cursor chats and disabled for drafts.

Installed smoke:

1. Install or confirm `cursor-agent`.
2. Confirm `cursor-agent status` is authenticated or `CURSOR_API_KEY` is set.
3. Start Pixel Forge with Agent Deck disabled.
4. Confirm `GET /api/agent-providers` shows `cursor-cli` available.
5. Create a Cursor chat draft through Settings or Live Editor.
6. Send a selected-preview request using `cursor-cli`.
7. Verify request pack metadata contains `provider_id=cursor-cli`,
   `provider_session_id=<cursor chat id>`, and no Agent Deck session id.
8. Verify assistant output appears in the Live Editor and the terminal event
   closes with a completed provider turn. Direct-provider live partial
   streaming is a follow-up provider-contract improvement.
9. Use Open TUI and verify it resumes the same Cursor CLI chat.

## Open Questions

- Does `cursor-agent create-chat` always return only a chat id, or can it emit
  additional text in some locales/configurations?
- Is there a supported machine-readable session list for `cursor-agent ls`, or
  should Pixel Forge keep `list_sessions=false`?
- Can Cursor CLI consume image files as local attachments through a hidden or
  newer flag, or must Pixel Forge pass selected images as file-path references?
- Does `--stream-partial-output` materially improve assistant deltas for the
  current CLI, or is standard `stream-json` enough?
- Are project-level `.cursor/cli.json` permission files enough to constrain
  forced headless turns, or should Pixel Forge add an explicit per-provider
  "allow no-approval Cursor dispatch" Settings toggle?
