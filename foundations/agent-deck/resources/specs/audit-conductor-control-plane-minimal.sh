#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT_DIR"

PASS_COUNT=0
FAIL_COUNT=0

pass() {
  printf "PASS  %s\n" "$1"
  PASS_COUNT=$((PASS_COUNT + 1))
}

fail() {
  printf "FAIL  %s\n" "$1"
  FAIL_COUNT=$((FAIL_COUNT + 1))
}

run_expect_no_match() {
  local check_id="$1"
  shift
  local output=""
  local status=0

  set +e
  output="$("$@" 2>&1)"
  status=$?
  set -e

  if [[ $status -eq 1 && -z "$output" ]]; then
    pass "$check_id"
    return
  fi
  if [[ $status -eq 0 && -n "$output" ]]; then
    fail "$check_id (unexpected matches)"
    printf "%s\n" "$output"
    return
  fi
  if [[ $status -eq 0 && -z "$output" ]]; then
    pass "$check_id"
    return
  fi

  fail "$check_id (command error)"
  printf "%s\n" "$output"
}

run_expect_match() {
  local check_id="$1"
  shift
  local output=""
  local status=0

  set +e
  output="$("$@" 2>&1)"
  status=$?
  set -e

  if [[ $status -eq 0 && -n "$output" ]]; then
    pass "$check_id"
    return
  fi
  if [[ $status -eq 1 && -z "$output" ]]; then
    fail "$check_id (no matches)"
    return
  fi

  fail "$check_id (command error)"
  printf "%s\n" "$output"
}

printf "Running AD-CONDUCTOR-MINIMAL-001 audit in %s\n" "$ROOT_DIR"

# R2 automated checks from spec.
run_expect_no_match "R2-C1" rg -n "DispatchBridgeTransitionEvent|RunBridgeHeartbeatTick|RunBridgeManualEscalation" cmd internal
run_expect_no_match "R2-C2" rg -n -- "--dispatch-event|--tick|--escalate" internal/session/conductor.go internal/session/conductor_templates.go
run_expect_match "R2-C3" rg -n "openclaw system event|/hooks/wake|/hooks/agent" cmd internal
run_expect_no_match "R2-C4" rg -n "async def heartbeat_loop|async def run_heartbeat_cycle|select_heartbeat_conductors|dispatch_escalation_notification" internal/session/conductor_templates.go conductor/bridge.py
run_expect_no_match "R2-C5" rg -n "PARK_COMMAND\\s*=|RESUME_COMMAND\\s*=|ACK_COMMAND\\s*=|RESOLVE_COMMAND\\s*=|def autonomous_memory_gate|def load_ownership_document|def save_parked_sessions|CREATE TABLE IF NOT EXISTS escalations" internal/session/conductor_templates.go conductor/bridge.py
run_expect_match "R2-C6" rg -n "def build_signal_payload|def send_to_conductor|transport-only" internal/session/conductor_templates.go conductor/bridge.py
run_expect_no_match "R2-C7" rg -n "slack_bolt|AsyncSocketModeHandler|create_slack_app|/ad-status|/ad-sessions|/ad-restart|/ad-help|user\\.slack" internal/session/conductor_templates.go conductor/bridge.py
run_expect_no_match "R2-C8" rg -n "@dp\\.message\\(Command\\(\"status\"\\)\\)|@dp\\.message\\(Command\\(\"sessions\"\\)\\)|@dp\\.message\\(Command\\(\"restart\"\\)\\)|build_status_response|build_sessions_response|restart_conductor" internal/session/conductor_templates.go conductor/bridge.py
run_expect_no_match "R2-C9" rg -n "case \"conductor\"|Conductor Commands:|conductor setup|conductor teardown|conductor tick|conductor escalate|conductor reconfigure" cmd/agent-deck/main.go
run_expect_no_match "R2-C10" bash -lc "rg --files cmd/agent-deck | rg 'conductor_cmd\\.go|conductor_cmd_test\\.go'"
run_expect_no_match "R2-C11" bash -lc "rg --files conductor | rg -v '^conductor/bridge.py$'"
run_expect_no_match "R2-C12" bash -lc "rg --files internal/conductor/runtime"
run_expect_no_match "R2-C13" bash -lc "rg --files internal/session | rg 'conductor_ownership\\.go'"
run_expect_no_match "R2-C14" bash -lc "rg -n 'InstallHeartbeatDaemon|UninstallHeartbeatDaemon|InstallHeartbeatScript|GenerateHeartbeatPlist|HeartbeatPlistLabel|GenerateSystemdHeartbeatTimer|GenerateSystemdHeartbeatService|SystemdHeartbeatServiceName|SystemdHeartbeatTimerName|SystemdHeartbeatServicePath|SystemdHeartbeatTimerPath|MigrateConductorHeartbeatScripts|SetConductorHeartbeatEnabled|SyncConductorHeartbeatDaemon|conductorHeartbeatScript|conductorHeartbeatPlistTemplate|systemdHeartbeatTimerTemplate|systemdHeartbeatServiceTemplate' internal/session/conductor.go internal/session/conductor_test.go"
run_expect_no_match "R2-C15" rg -n "import argparse|parse_bridge_args|Reserved for compatibility; ignored in daemon mode" internal/session/conductor_templates.go conductor/bridge.py
run_expect_no_match "R2-C16" rg -n "conductor/setup\\.sh|\\./setup\\.sh" README.md skills/agent-deck/SKILL.md
run_expect_no_match "R2-C17" rg -n "Auto-Response Guidelines|Core Rules|Choose AUTO, PARK, or NEED|HEARTBEAT_RULES\\.md|review past patterns" internal/session/conductor_templates.go
run_expect_match "R2-C18" rg -n "Agent Deck is transport plumbing only|~/.openclaw/workspace-conductor/" internal/session/conductor_templates.go
run_expect_match "R2-C19" rg -n "sync-runtime\\.sh.*--runtime-root" scripts/runtime-layers.sh
run_expect_match "R2-C20" rg -n "install -m 0755 .*bridge\\.py|installed bridge\\.py" scripts/sync-runtime.sh
run_expect_match "R2-C21" rg -n "agent-deck-conductor-heartbeat-\\*\\.service|agent-deck-conductor-heartbeat-\\*\\.timer|heartbeat\\.sh" scripts/sync-runtime.sh
run_expect_match "R2-C22" rg -n 'json:"ownership"|json:"managed"|\"ownership\":|\"managed\":' cmd/agent-deck/main.go cmd/agent-deck/session_cmd.go

# R3 static guardrails (runtime replay check remains manual).
run_expect_match "R3-S1 actor field" rg -n 'Actor\s+string\s+`json:"actor,omitempty"`' internal/session/transition_notifier.go
run_expect_match "R3-S2 action field" rg -n 'Action\s+string\s+`json:"action,omitempty"`' internal/session/transition_notifier.go
run_expect_match "R3-S3 reason field" rg -n 'Reason\s+string\s+`json:"reason,omitempty"`' internal/session/transition_notifier.go
run_expect_match "R3-S4 target field" rg -n 'Target\s+string\s+`json:"target,omitempty"`' internal/session/transition_notifier.go
run_expect_match "R3-S5 idempotency field" rg -n 'IdempotencyKey\s+string\s+`json:"idempotency_key,omitempty"`' internal/session/transition_notifier.go
run_expect_match "R3-S6 structured log persistence" rg -n "json.Marshal\\(event\\)" internal/session/transition_notifier.go
run_expect_match "R3-S7 signal envelopes include ts + idempotency" rg -n "\"idempotency_key\"|\"ts\"" internal/session/openclaw_events.go

# R4 static guardrails (runtime restart check remains manual).
run_expect_match "R4-S1 notifier state load/save" rg -n "loadState\\(|saveStateLocked\\(" internal/session/transition_notifier.go
run_expect_match "R4-S2 notifier state path" rg -n "transitionNotifyStatePath\\(" internal/session/transition_notifier.go
run_expect_match "R4-S3 transition path is direct OpenClaw dispatch" rg -n "DispatchOpenClawTransitionEvent\\(" internal/session/transition_notifier.go

printf "\nManual/runtime checks still required:\n"
printf "  - R1-C1: mutate ~/.openclaw/workspace-conductor identity files and verify behavior shifts without Agent Deck identity edits.\n"
printf "  - R3-C1: trigger one Telegram relay + one transition dispatch and verify replayable audit records include ts/actor/action/reason/target/idempotency_key.\n"
printf "  - R4-C1: capture pre-restart state, restart, trigger one transition event, and verify continuity.\n"

printf "\nSummary: %d passed, %d failed\n" "$PASS_COUNT" "$FAIL_COUNT"
if [[ $FAIL_COUNT -ne 0 ]]; then
  exit 1
fi
