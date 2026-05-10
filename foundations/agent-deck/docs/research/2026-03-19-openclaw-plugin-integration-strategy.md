# OpenClaw Plugin-First Integration Strategy

Date: 2026-03-19
Status: Research note
Scope: Agent Deck custom integration with OpenClaw and ACP/`acpx`

## Why this exists

We reviewed:

- the upstream `acpx` project
- the local OpenClaw fork in `~/repos/openclaw`
- the current Agent Deck integration surfaces in this repo

The question was not "what can we replace today?" The real question was:

- where should future OpenClaw-specific customization live?
- what can eventually move out of fork patches?
- what should stay in Agent Deck because it is actually Agent Deck behavior?

## Bottom line

- Do not refactor the current working integration just because a cleaner architecture exists.
- For new OpenClaw-side functionality, default to native OpenClaw plugins instead of custom core patches.
- Use stock OpenClaw ACP plus the shipped `acpx` plugin for structured headless ACP control instead of rebuilding ACP runtime behavior in Agent Deck.
- Keep Agent Deck-specific tmux/TUI/conductor behavior outside OpenClaw plugins.

This is a hardening direction, not an immediate rewrite.

## What OpenClaw plugins actually support

OpenClaw's native plugin system is real runtime infrastructure, not just a skill loader.

Native plugins can register:

- gateway RPC methods
- gateway HTTP routes
- agent tools
- CLI commands
- background services
- context engines
- provider auth flows and provider runtime hooks
- interactive handlers
- auto-reply commands
- skills declared from plugin-owned directories

Key local references:

- `docs/tools/plugin.md`
- `src/plugins/types.ts`
- `src/plugins/registry.ts`
- `VISION.md`

Important boundary:

- Native OpenClaw plugins execute runtime code in-process.
- Compatible bundles (`.codex-plugin`, `.claude-plugin`, `.cursor-plugin`) are mostly capability packs and do not run arbitrary runtime code in-process.

That means our integration use case belongs in native plugins, not bundle-only packaging.

## What `acpx` is in practice

`acpx` is not a replacement for Agent Deck. It is a structured ACP backend/client.

The useful part:

- persistent ACP sessions
- queue ownership
- structured prompt/send/cancel/config flows
- machine-readable status and event handling
- multi-harness support

In the local OpenClaw fork, `acpx` is already part of the normal build as a bundled extension/plugin capability:

- `extensions/acpx/openclaw.plugin.json`
- `extensions/acpx/index.ts`
- `extensions/acpx/src/service.ts`
- `src/config/plugin-auto-enable.ts`
- `src/acp/runtime/registry.ts`

Important distinction:

- `acpx` is integrated and effectively the default ACP backend path
- `acpx` is not the same thing as "OpenClaw core always depends on acpx for everything"

So the right reading is:

- OpenClaw core owns the ACP control plane
- `acpx` is the current runtime/backend implementation seam

## Good overlap with Agent Deck

These are the parts that should eventually stop being custom Agent Deck runtime logic:

- ACP session persistence
- ACP queue ownership
- structured send/cancel/status behavior
- ACP stream/event normalization
- ACP backend health and structured runtime status

This is where stock OpenClaw ACP plus `acpx` has real leverage.

## Bad overlap with Agent Deck

These are not solved by `acpx` and should not be forced into OpenClaw plugins just because plugins exist:

- Agent Deck tmux lifecycle and attach behavior
- Agent Deck TUI behavior
- conductor row/protection/ownership semantics
- conductor workspace seeding and identity-pack behavior
- Agent Deck-specific notification routing rules

Those are product behaviors of Agent Deck, not missing ACP transport features.

## Current custom integration surfaces in Agent Deck

Relevant files we inspected:

- `cmd/agent-deck/openclaw_cmd.go`
- `internal/openclaw/bridge.go`
- `internal/session/conductor.go`
- `internal/session/transition_notifier.go`
- `cmd/agent-deck/session_cmd.go`
- `docs/conductor-openclaw-migration-plan.md`
- `SPECS.md`

The main conclusion:

- some current custom code is integration glue that will always exist in some form
- some current custom code is duplicated ACP runtime behavior and is the right future deletion target

So the long-term goal is not "zero custom integration code."

The long-term goal is:

- thin Agent Deck adapter
- stock OpenClaw/OpenClaw-plugin runtime underneath

## Recommended rule set

1. Keep the current working integration until a concrete change is worth the migration cost.
2. Any new OpenClaw-side optional behavior should go into a native OpenClaw plugin first.
3. When touching ACP headless-control paths, prefer replacing duplicated Agent Deck ACP logic with stock OpenClaw ACP plus `acpx`.
4. Do not move Agent Deck-specific control-plane or tmux behaviors into OpenClaw just to reduce local code count.
5. Avoid new core fork patches unless the plugin API genuinely lacks the seam.

## What should move first when the time comes

Best candidates for plugin-first extraction:

- ACP-backed session status and health projection for external consumers
- gateway RPC or HTTP surfaces for Agent Deck to query structured ACP state
- background services that normalize ACP runtime events
- provider/runtime hooks that belong to OpenClaw, not Agent Deck

## What should probably stay where it is

- Agent Deck conductor orchestration policy
- Agent Deck session ownership UI semantics
- tmux-oriented attach/launch behavior
- worktree/session manager concerns that are not OpenClaw runtime behavior

## Decision for now

No immediate rewrite.

Adopt this philosophy instead:

- plugin-first for future OpenClaw-side work
- stock ACP backend before custom ACP duplication
- thin integration layer in Agent Deck
- no refactor without concrete payoff

## Sources used

Local Agent Deck:

- `SPECS.md`
- `docs/conductor-openclaw-migration-plan.md`
- `cmd/agent-deck/session_cmd.go`
- `cmd/agent-deck/openclaw_cmd.go`
- `internal/openclaw/bridge.go`
- `internal/session/conductor.go`
- `internal/session/transition_notifier.go`

Local OpenClaw:

- `VISION.md`
- `docs/tools/plugin.md`
- `docs/tools/acp-agents.md`
- `src/plugins/types.ts`
- `src/plugins/registry.ts`
- `src/acp/runtime/registry.ts`
- `src/config/plugin-auto-enable.ts`
- `extensions/acpx/openclaw.plugin.json`
- `extensions/acpx/index.ts`
- `extensions/acpx/src/service.ts`

Upstream references reviewed during research:

- `https://github.com/openclaw/acpx`
- `https://raw.githubusercontent.com/openclaw/acpx/main/VISION.md`
- `https://docs.openclaw.ai/cli/acp`
- `https://docs.openclaw.ai/tools/acp-agents`
