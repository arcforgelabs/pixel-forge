# Conductor Dumb Pass-Through Checklist

Date: 2026-03-05
Spec: `resources/specs/conductor-control-plane-minimal.v1.yaml`

## Removed From Bridge Runtime

- Bridge-owned heartbeat cycle engine (`heartbeat_loop`, `run_heartbeat_cycle`, per-profile heartbeat selection)
- Bridge-owned escalation lifecycle engine/retry sweeps
- Bridge-owned parked/ownership protocol/state-machine (`[PARK]`, `[RESUME]`, `[ACK]`, `[RESOLVE]`)
- Bridge-owned local memory/audit/escalation SQLite lifecycle in Python bridge template/runtime
- Bridge multi-platform/channel complexity (Slack socket mode and Slack slash commands)
- Bridge operator convenience commands (`/status`, `/sessions`, `/restart`)
- Legacy conductor bootstrap/operator assets in repo runtime path (`conductor/setup.sh`, `conductor/teardown.sh`, plist/templates)
- Dormant runtime-adapter package (`internal/conductor/runtime/*`)
- Detached ownership policy engine (`internal/session/conductor_ownership.go`)
- Conductor heartbeat daemon/script generation scaffolding in runtime code (`internal/session/conductor.go`)
- Bridge compatibility parser wrapper (`parse_bridge_args`, compatibility `--json` mode)

## Retained Intentionally

- Single inbound transport adapter (Telegram only)
- Signal-envelope wrapping (`[SIGNAL] {json}`) before forwarding to conductor sessions
- Delivery-only failure reporting to user channels
- Install-time runtime sync that hard-overwrites `~/.agent-deck/conductor/bridge.py` from repo source and removes legacy heartbeat timer/script artifacts

## Transport Contract (Enforced)

- Input: user text from Telegram
- Forward: `agent-deck session send` to one deterministic conductor target with a typed signal envelope
- Output: relay conductor response text back to Telegram (chunked by platform limit)
- Failure semantics: report delivery failure only; no local triage/escalation/ownership/parked decisioning

## Audit Commands

- `./resources/specs/audit-conductor-control-plane-minimal.sh`
- `rg -n "heartbeat_loop|run_heartbeat_cycle|dispatch_escalation_notification|ownership\.json|parked\.json|PARK_COMMAND|RESUME_COMMAND" internal/session/conductor_templates.go conductor/bridge.py`
- `rg -n "def build_signal_payload|def send_to_conductor|transport-only" internal/session/conductor_templates.go conductor/bridge.py`
- `rg -n "slack_bolt|AsyncSocketModeHandler|create_slack_app|/ad-status|/ad-sessions|/ad-restart|/ad-help|user\.slack" internal/session/conductor_templates.go conductor/bridge.py`
- `rg -n "case \"conductor\"|Conductor Commands:|conductor setup|conductor teardown|conductor tick|conductor escalate|conductor reconfigure" cmd/agent-deck/main.go`
- `rg --files cmd/agent-deck | rg "conductor_cmd\.go|conductor_cmd_test\.go"`
- `rg -n "InstallHeartbeatDaemon|InstallHeartbeatScript|GenerateHeartbeatPlist|SystemdHeartbeat|MigrateConductorHeartbeatScripts|SetConductorHeartbeatEnabled|SyncConductorHeartbeatDaemon" internal/session/conductor.go`
- `rg -n "import argparse|parse_bridge_args|Reserved for compatibility; ignored in daemon mode" internal/session/conductor_templates.go conductor/bridge.py`
- `rg -n "conductor/setup\.sh|\./setup\.sh" README.md skills/agent-deck/SKILL.md`
- `rg -n "Auto-Response Guidelines|Core Rules|Choose AUTO, PARK, or NEED|HEARTBEAT_RULES\.md|review past patterns" internal/session/conductor_templates.go`
- `rg -n "Agent Deck is transport plumbing only|~/.openclaw/workspace-conductor/" internal/session/conductor_templates.go`
- `rg -n "scripts/sync-runtime\.sh" dev-install.sh`
- `rg -n "install -m 0755 .*bridge\.py|installed bridge\.py" scripts/sync-runtime.sh`
- `rg -n "agent-deck-conductor-heartbeat-\*\.service|agent-deck-conductor-heartbeat-\*\.timer|heartbeat\.sh" scripts/sync-runtime.sh`

## Follow-Up For Full Cutover

- Validate OpenClaw/Cato consumes relay envelopes as canonical control-plane input in live runtime
- Re-run runtime checks in the spec (`R1-C1`, `R3-C1`, `R4-C1`) against a live conductor environment
