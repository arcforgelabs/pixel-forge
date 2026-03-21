#!/bin/bash

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
FOUNDATION_ROOT="${PIXEL_FORGE_AGENT_DECK_FOUNDATION_ROOT:-$REPO_ROOT/foundations/agent-deck}"
BUILD_DIR="$FOUNDATION_ROOT/build"
BUILD_BIN="${PIXEL_FORGE_AGENT_DECK_BINARY:-$BUILD_DIR/agent-deck}"

export AGENTDECK_PROFILE="${AGENTDECK_PROFILE:-${PIXEL_FORGE_AGENT_DECK_PROFILE:-workstation-v2}}"

if [[ ! -d "$FOUNDATION_ROOT/cmd/agent-deck" ]]; then
  echo "workstation-v2 Agent Deck foundation is missing at $FOUNDATION_ROOT" >&2
  exit 1
fi

if [[ ! -x "$BUILD_BIN" ]]; then
  mkdir -p "$BUILD_DIR"
  (
    cd "$FOUNDATION_ROOT"
    go build -o "$BUILD_BIN" ./cmd/agent-deck
  )
fi

exec "$BUILD_BIN" "$@"
