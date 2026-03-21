#!/bin/bash

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
if [[ -f "$SCRIPT_DIR/workstation-v2-env.sh" ]]; then
  # shellcheck disable=SC1091
  source "$SCRIPT_DIR/workstation-v2-env.sh"
fi
FOUNDATION_ROOT="${PIXEL_FORGE_AGENT_DECK_FOUNDATION_ROOT:-$REPO_ROOT/foundations/agent-deck}"
BUILD_DIR="$FOUNDATION_ROOT/build"
BUILD_BIN="${PIXEL_FORGE_AGENT_DECK_BINARY:-$BUILD_DIR/agent-deck}"

export AGENTDECK_PROFILE="${AGENTDECK_PROFILE:-${PIXEL_FORGE_AGENT_DECK_PROFILE:-alpha}}"
export PIXEL_FORGE_AGENT_DECK_HOME="${PIXEL_FORGE_AGENT_DECK_HOME:-${PIXEL_FORGE_SHARED_STATE_DIR:-$HOME/.pixel-forge-alpha}/agent-deck}"
export PIXEL_FORGE_DB_PATH="${PIXEL_FORGE_DB_PATH:-${PIXEL_FORGE_SHARED_STATE_DIR:-$HOME/.pixel-forge-alpha}/pixel-forge.db}"
export AGENTDECK_DIR="${AGENTDECK_DIR:-$PIXEL_FORGE_AGENT_DECK_HOME}"
export AGENT_DECK_DIR="${AGENT_DECK_DIR:-$AGENTDECK_DIR}"

STATE_ROOT_MIGRATION_HELPER="${PIXEL_FORGE_STATE_ROOT_MIGRATION_HELPER:-$REPO_ROOT/ensure_alpha_state_root.py}"
if [[ ! -f "$STATE_ROOT_MIGRATION_HELPER" ]]; then
  STATE_ROOT_MIGRATION_HELPER="$REPO_ROOT/apps/api/ensure_alpha_state_root.py"
fi
if [[ -f "$STATE_ROOT_MIGRATION_HELPER" ]]; then
  python3 "$STATE_ROOT_MIGRATION_HELPER" >/dev/null
fi

if [[ ! -d "$FOUNDATION_ROOT/cmd/agent-deck" ]]; then
  echo "workstation-v2 Agent Deck foundation is missing at $FOUNDATION_ROOT" >&2
  exit 1
fi

mkdir -p "$PIXEL_FORGE_AGENT_DECK_HOME"

needs_rebuild=0
if [[ ! -x "$BUILD_BIN" ]]; then
  needs_rebuild=1
elif find "$FOUNDATION_ROOT/cmd" "$FOUNDATION_ROOT/internal" -type f \( -name '*.go' -o -name 'go.mod' -o -name 'go.sum' \) -newer "$BUILD_BIN" -print -quit | grep -q .; then
  needs_rebuild=1
elif find "$FOUNDATION_ROOT/internal/web/static" -type f -newer "$BUILD_BIN" -print -quit | grep -q .; then
  needs_rebuild=1
fi

if [[ "$needs_rebuild" == "1" ]]; then
  mkdir -p "$BUILD_DIR"
  (
    cd "$FOUNDATION_ROOT"
    go build -o "$BUILD_BIN" ./cmd/agent-deck
  )
fi

exec "$BUILD_BIN" "$@"
