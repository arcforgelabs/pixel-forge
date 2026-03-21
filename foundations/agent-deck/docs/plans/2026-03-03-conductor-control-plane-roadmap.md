# Conductor Control Plane Roadmap

Generated: 2026-03-03  
Status: Proposed implementation plan for handoff-safe execution

## Goal

Make Conductor a first-class control-plane component in Agent Deck:

1. Always present per profile (auto-ensured on startup).
2. Visually distinct from regular sessions.
3. Protected from accidental deletion/teardown.
4. Reconfigurable runtime backend (`claude`, `codex`, `gemini`, custom command).
5. Architected for eventual OpenClaw-native runtime integration.

## Why This Plan Exists

This roadmap is designed so another agent can resume mid-implementation without re-discovery.  
Each phase includes:

1. Features
2. Touchpoints (files/functions)
3. Acceptance criteria
4. Validation commands
5. Explicit handoff checkpoint

## Current State Snapshot

1. Conductor already exists as named sessions and has command surface under `agent-deck conductor ...`.
2. Conductor group is pinned to top in `internal/session/groups.go`.
3. Conductor sessions are still normal sessions for delete/restart/visual behavior.
4. Group hotkey numbering currently includes the root `conductor` group.
5. Runtime is session-tool driven; no dedicated backend abstraction for conductor runtime selection.

## Scope

In scope:

1. Control-plane lifecycle and UX in Agent Deck.
2. Runtime selection and reconfigure/restart pathways.
3. Guardrails around destructive operations on conductor sessions.
4. Adapter seam for OpenClaw runtime.

Out of scope for this roadmap:

1. Full OpenClaw runtime implementation details beyond adapter contract and integration skeleton.
2. Replacing existing Telegram/Slack bridge behavior in this phase set.
3. Deep OpenClaw UI embedding inside the TUI (future phase).

## Principles

1. Conductor is infrastructure, not “just another worker session.”
2. Backward compatible defaults: existing setups should continue to work.
3. Keep destructive actions behind explicit force flags.
4. Ship in incremental phases with feature flags where needed.
5. Preserve profile boundaries.

## Target UX

1. On Agent Deck startup, a conductor is guaranteed per active profile.
2. Conductor appears as a visually distinct control-plane row/group.
3. Conductor is green-themed and excluded from normal root-group hotkey numbering.
4. Delete on conductor row is blocked by default.
5. Dedicated actions exist for restart and reconfigure backend.
6. Backend can be switched without re-creating conductor identity/state.

## Phase 0: Guardrails and Metadata Foundation

### Features

1. Extend `ConductorMeta` to include runtime backend fields.
2. Introduce conductor protection policy flags.
3. Add internal helpers to classify “protected conductor session.”

### Suggested metadata fields

1. `runtime_tool` (string; `claude|codex|gemini|custom`)
2. `runtime_command` (string; optional custom command)
3. `protected` (bool; default `true`)
4. `control_plane` (bool; default `true`)

### Touchpoints

1. `internal/session/conductor.go` (`ConductorMeta`, load/save defaults)
2. `cmd/agent-deck/conductor_cmd.go` (display/runtime metadata output)
3. `internal/session/conductor_test.go` (meta serialization tests)

### Acceptance Criteria

1. Existing `meta.json` files load without migration failures.
2. New fields get sane defaults for old conductors.
3. CLI list/status shows runtime metadata.

### Validation

1. `go test ./internal/session -run Conductor -count=1`
2. `go test ./cmd/agent-deck -run Conductor -count=1`

### Handoff Checkpoint

1. Add sample upgraded `meta.json` shape to this doc’s “Progress Log” section.

## Phase 1: Always-On Conductor (Per Profile Auto-Ensure)

### Features

1. On app startup, ensure a conductor exists for current profile.
2. If none exists, auto-create default conductor (recommended name: `ops`).
3. If exists but stopped/error, auto-start or recover.
4. Add opt-out config switch for users who explicitly disable auto-ensure.

### Suggested config additions

1. `[conductor] required = true` (default `true`)
2. `[conductor] default_name = "ops"`
3. `[conductor] auto_recover = true`

### Touchpoints

1. `internal/session/userconfig.go` (new config fields/defaults)
2. `internal/session/conductor.go` (ensure helpers)
3. `cmd/agent-deck/main.go` (startup ensure hook)
4. `cmd/agent-deck/conductor_cmd.go` (surface config/runtime state)

### Acceptance Criteria

1. Starting Agent Deck with no conductor auto-creates and registers one.
2. Starting Agent Deck with conductor in error attempts restart.
3. Opt-out config cleanly disables auto-ensure.

### Validation

1. Fresh profile boot test (manual): no conductor -> launch -> conductor appears.
2. Restart test: stopped conductor -> launch -> running conductor.
3. `go test ./internal/session ./cmd/agent-deck -count=1`

### Handoff Checkpoint

1. Document startup flow and fallback behavior in Progress Log.
2. Record exact function entrypoint used for auto-ensure.

## Phase 2: Protected Control-Plane Semantics

### Features

1. Block delete from TUI for protected conductor sessions.
2. Block CLI remove/teardown unless explicit force flag is provided.
3. Keep restart allowed.
4. Add explicit `--force` flow for teardown/remove with warning.

### Touchpoints

1. `internal/ui/home.go` (`ConfirmDeleteSession`, `deleteSession`, key handler path)
2. `cmd/agent-deck/main.go` (session remove command path)
3. `cmd/agent-deck/conductor_cmd.go` (`teardown` force semantics)
4. `internal/session/instance.go` (optional helper: `IsConductorSession()`)

### Acceptance Criteria

1. `d` on conductor row shows protected warning and does not delete.
2. Regular sessions unaffected.
3. CLI delete/teardown requires force for protected conductors.

### Validation

1. TUI manual delete attempt on conductor session.
2. CLI remove attempt without force fails with clear message.
3. CLI remove/teardown with force succeeds.

### Handoff Checkpoint

1. Capture exact UX messages for blocked delete and force path.

## Phase 3: Visual Distinction in TUI

### Features

1. Conductor group/session styling in green.
2. Conductor badge marker in session row.
3. Exclude root `conductor` group from root-group hotkey numbering.
4. Keep conductor pinned at top.

### Touchpoints

1. `internal/ui/styles.go` (new conductor styles)
2. `internal/ui/home.go` (`renderGroupItem`, `renderSessionItem`, root numbering in `rebuildFlatItems`)
3. `internal/session/groups.go` (existing pin behavior remains authoritative)

### Acceptance Criteria

1. Conductor visually distinct from all regular groups/sessions.
2. Root hotkeys for non-conductor groups start from first non-conductor root group.
3. Existing selection and status rendering remains readable in light/dark themes.

### Validation

1. Manual TUI screenshot checks in both themes.
2. Existing UI tests pass.
3. Add targeted tests for root numbering logic excluding conductor.

### Handoff Checkpoint

1. Attach before/after screenshots in PR notes.
2. Record color constants/styles used.

## Phase 4: Reconfigure and Runtime Switching

### Features

1. Add `agent-deck conductor reconfigure <name>` command.
2. Allow runtime switch among `claude`, `codex`, `gemini`, `custom`.
3. Persist runtime config in conductor metadata.
4. Provide one-step reconfigure+restart flow.

### CLI behavior

1. `agent-deck conductor reconfigure ops -runtime=codex`
2. `agent-deck conductor reconfigure ops -runtime=custom -cmd=\"opencode --profile conductor\"`
3. `agent-deck conductor reset ops` remains hard reset command.

### Touchpoints

1. `cmd/agent-deck/conductor_cmd.go` (new subcommand + help text)
2. `internal/session/conductor.go` (runtime config read/write + session command creation)
3. `README.md` conductor section updates

### Acceptance Criteria

1. Runtime changes persist across restart.
2. Conductor restart launches with selected backend command.
3. Bad runtime values fail with explicit validation error.

### Validation

1. Reconfigure claude->codex->gemini round trip.
2. Reconfigure custom command and restart.
3. `agent-deck conductor status/list --json` reflects selected runtime.

### Handoff Checkpoint

1. Provide exact CLI examples used for validation.

## Phase 5: OpenClaw Adapter Seam (No Full Cutover Yet)

### Features

1. Introduce runtime adapter interface for conductor.
2. Keep existing session-backed runtime as default adapter.
3. Add `openclaw` adapter skeleton behind feature flag.
4. Define auth contract for OpenClaw subscription-backed provider routing.

### Suggested abstraction

1. `ConductorRuntime` interface:
   - `Ensure(name, profile, meta) error`
   - `Start(name, profile, meta) error`
   - `Restart(name, profile, meta) error`
   - `Send(name, profile, message) (string, error)`
   - `Status(name, profile) (string, error)`
2. Session adapter implementation lives in Agent Deck.
3. OpenClaw adapter uses integration client boundary (no direct TUI logic coupling).

### Touchpoints

1. `internal/session/conductor.go` (runtime selection and dispatch)
2. `internal/session/conductor_templates.go` (if bridge dispatch needs runtime awareness)
3. New package candidate: `internal/conductor/runtime/`

### Acceptance Criteria

1. Existing behavior unchanged under default adapter.
2. Adapter selection is configuration-driven.
3. OpenClaw adapter can be compiled and selected behind flag without breaking default path.

### Validation

1. Unit tests for adapter selection and fallback behavior.
2. Integration smoke with session adapter.

### Handoff Checkpoint

1. Document selected adapter architecture and interfaces in code comments and this plan.

## Cross-Phase Test Matrix

1. New profile with no conductors.
2. Existing profile with one legacy conductor.
3. Existing profile with multiple conductors.
4. Conductor disabled via config.
5. Protected delete paths (TUI + CLI).
6. Runtime switch persistence across restart.
7. Heartbeat and notify daemon behavior remains functional.

## Risks and Mitigations

1. Risk: Breaking existing multi-conductor flows.
   - Mitigation: Preserve named conductors and profile scoping; auto-ensure only fills missing default.
2. Risk: User confusion about protection semantics.
   - Mitigation: explicit “protected control-plane session” messages and force override.
3. Risk: OpenClaw integration coupling too early.
   - Mitigation: strict adapter seam, no hard dependency in initial phases.

## Progress Log (Update During Execution)

Use this as the handoff ledger. Update after each completed work block.

1. Phase 0:
   - Status: Completed (2026-03-02)
   - Commit(s): Uncommitted workspace changes
   - Notes: Added runtime/protection/control-plane metadata fields with defaulting, plus runtime resolution helpers in `internal/session/conductor.go`.
2. Phase 1:
   - Status: Completed (2026-03-02)
   - Commit(s): Uncommitted workspace changes
   - Notes: Added startup auto-ensure via `session.EnsureConductorForProfile` and wired call in `cmd/agent-deck/main.go`; added config knobs `required`, `default_name`, `auto_recover`.
3. Phase 2:
   - Status: Completed (2026-03-02)
   - Commit(s): Uncommitted workspace changes
   - Notes: Added protected deletion guardrails in TUI (`internal/ui/home.go`), CLI remove (`cmd/agent-deck/main.go`), conductor teardown (`cmd/agent-deck/conductor_cmd.go`), and conductor group delete protection (`cmd/agent-deck/group_cmd.go`).
4. Phase 3:
   - Status: Completed (2026-03-02)
   - Commit(s): Uncommitted workspace changes
   - Notes: Added conductor green styling and `[CTRL]` badge; excluded root `conductor` group from hotkey numbering while keeping it pinned.
5. Phase 4:
   - Status: Completed (2026-03-02)
   - Commit(s): Uncommitted workspace changes
   - Notes: Added `agent-deck conductor reconfigure` subcommand with runtime validation, metadata persistence, and optional restart/start flow.
6. Phase 5:
   - Status: Partial skeleton completed (2026-03-02)
   - Commit(s): Uncommitted workspace changes
   - Notes: Added `internal/conductor/runtime` adapter seam (`session` default adapter + feature-gated `openclaw` skeleton) and selection tests; not yet wired to replace session execution path.

## Resume Protocol for Next Agent

1. Read this file first.
2. Run `git status --short` and identify current phase from Progress Log.
3. Run targeted tests for completed phases before starting next phase.
4. Continue from next unchecked acceptance criterion.
5. Update Progress Log and include validation evidence before handoff.
