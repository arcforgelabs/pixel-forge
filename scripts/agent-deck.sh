#!/bin/bash

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
if [[ -f "$SCRIPT_DIR/alpha-env.sh" ]]; then
  # shellcheck disable=SC1091
  source "$SCRIPT_DIR/alpha-env.sh"
fi
CHANNEL_ENV_FILE="${PIXEL_FORGE_CLAUDE_CHANNEL_ENV_FILE:-${PIXEL_FORGE_SHARED_STATE_DIR:-$HOME/.pixel-forge-alpha}/claude-channel-spike.env}"
if [[ -f "$CHANNEL_ENV_FILE" ]]; then
  # shellcheck disable=SC1090
  source "$CHANNEL_ENV_FILE"
fi
FOUNDATION_ROOT="${PIXEL_FORGE_AGENT_DECK_FOUNDATION_ROOT:-$REPO_ROOT/foundations/agent-deck}"
BUILD_DIR="$FOUNDATION_ROOT/build"
DEFAULT_BUILD_BIN="$BUILD_DIR/agent-deck"
FALLBACK_BUNDLED_BIN="$FOUNDATION_ROOT/agent-deck"
BUILD_BIN="${PIXEL_FORGE_AGENT_DECK_BINARY:-$DEFAULT_BUILD_BIN}"
RUN_BIN="$BUILD_BIN"
if [[ -z "${PIXEL_FORGE_AGENT_DECK_BINARY:-}" && ! -x "$RUN_BIN" && -x "$FALLBACK_BUNDLED_BIN" ]]; then
  RUN_BIN="$FALLBACK_BUNDLED_BIN"
fi

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
  echo "alpha Agent Deck foundation is missing at $FOUNDATION_ROOT" >&2
  exit 1
fi

mkdir -p "$PIXEL_FORGE_AGENT_DECK_HOME"

needs_rebuild=0
if [[ "$RUN_BIN" == "$BUILD_BIN" && ! -x "$BUILD_BIN" ]]; then
  needs_rebuild=1
elif [[ "$RUN_BIN" == "$BUILD_BIN" ]] && find "$FOUNDATION_ROOT/cmd" "$FOUNDATION_ROOT/internal" -type f \( -name '*.go' -o -name 'go.mod' -o -name 'go.sum' \) -newer "$BUILD_BIN" -print -quit | grep -q .; then
  needs_rebuild=1
elif [[ "$RUN_BIN" == "$BUILD_BIN" ]] && find "$FOUNDATION_ROOT/internal/web/static" -type f -newer "$BUILD_BIN" -print -quit | grep -q .; then
  needs_rebuild=1
fi

if [[ "$needs_rebuild" == "1" ]]; then
  GO_BIN="${PIXEL_FORGE_GO_BIN:-$(command -v go || true)}"
  if [[ -z "$GO_BIN" ]]; then
    if [[ -x "$FALLBACK_BUNDLED_BIN" ]]; then
      echo "alpha Agent Deck launcher is using the bundled fallback binary because 'go' is unavailable" >&2
      RUN_BIN="$FALLBACK_BUNDLED_BIN"
    elif [[ -x "$BUILD_BIN" ]]; then
      echo "alpha Agent Deck launcher is using the existing build output because 'go' is unavailable" >&2
      RUN_BIN="$BUILD_BIN"
    else
      echo "alpha Agent Deck launcher could not find a bundled binary and 'go' is unavailable to build one" >&2
      exit 1
    fi
  else
    mkdir -p "$BUILD_DIR"
    (
      cd "$FOUNDATION_ROOT"
      "$GO_BIN" build -o "$BUILD_BIN" ./cmd/agent-deck
    )
    RUN_BIN="$BUILD_BIN"
  fi
fi

exec "$RUN_BIN" "$@"
