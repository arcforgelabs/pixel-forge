#!/bin/bash

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
CHANNEL_ENV_FILE="${PIXEL_FORGE_CLAUDE_CHANNEL_ENV_FILE:-${PIXEL_FORGE_SHARED_STATE_DIR:-$HOME/.pixel-forge}/claude-channel-spike.env}"
if [[ -f "$CHANNEL_ENV_FILE" ]]; then
  # shellcheck disable=SC1090
  source "$CHANNEL_ENV_FILE"
fi
CODEX_CHANNEL_ENV_FILE="${PIXEL_FORGE_CODEX_CHANNEL_ENV_FILE:-${PIXEL_FORGE_SHARED_STATE_DIR:-$HOME/.pixel-forge}/codex-channel.env}"
if [[ -f "$CODEX_CHANNEL_ENV_FILE" ]]; then
  # shellcheck disable=SC1090
  source "$CODEX_CHANNEL_ENV_FILE"
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

export AGENTDECK_PROFILE="${AGENTDECK_PROFILE:-${PIXEL_FORGE_AGENT_DECK_PROFILE:-pixel-forge}}"
export PIXEL_FORGE_AGENT_DECK_HOME="${PIXEL_FORGE_AGENT_DECK_HOME:-${PIXEL_FORGE_SHARED_STATE_DIR:-$HOME/.pixel-forge}/agent-deck}"
export PIXEL_FORGE_DB_PATH="${PIXEL_FORGE_DB_PATH:-${PIXEL_FORGE_SHARED_STATE_DIR:-$HOME/.pixel-forge}/pixel-forge.db}"
export AGENTDECK_DIR="${AGENTDECK_DIR:-$PIXEL_FORGE_AGENT_DECK_HOME}"
export AGENT_DECK_DIR="${AGENT_DECK_DIR:-$AGENTDECK_DIR}"
export PIXEL_FORGE_AGENT_DECK_TMUX_TMPDIR="${PIXEL_FORGE_AGENT_DECK_TMUX_TMPDIR:-$PIXEL_FORGE_AGENT_DECK_HOME/tmux}"
export TMUX_TMPDIR="${TMUX_TMPDIR:-$PIXEL_FORGE_AGENT_DECK_TMUX_TMPDIR}"
unset TMUX TMUX_PANE
unset npm_config_prefix NPM_CONFIG_PREFIX

STATE_ROOT_MIGRATION_HELPER="${PIXEL_FORGE_STATE_ROOT_MIGRATION_HELPER:-$REPO_ROOT/ensure_state_root.py}"
if [[ ! -f "$STATE_ROOT_MIGRATION_HELPER" ]]; then
  STATE_ROOT_MIGRATION_HELPER="$REPO_ROOT/apps/api/ensure_state_root.py"
fi
if [[ -f "$STATE_ROOT_MIGRATION_HELPER" ]]; then
  python3 "$STATE_ROOT_MIGRATION_HELPER" >/dev/null
fi

if [[ ! -d "$FOUNDATION_ROOT/cmd/agent-deck" ]]; then
  echo "Agent Deck foundation is missing at $FOUNDATION_ROOT" >&2
  exit 1
fi

mkdir -p "$PIXEL_FORGE_AGENT_DECK_HOME" "$TMUX_TMPDIR"

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
      echo "Agent Deck launcher is using the bundled fallback binary because 'go' is unavailable" >&2
      RUN_BIN="$FALLBACK_BUNDLED_BIN"
    elif [[ -x "$BUILD_BIN" ]]; then
      echo "Agent Deck launcher is using the existing build output because 'go' is unavailable" >&2
      RUN_BIN="$BUILD_BIN"
    else
      echo "Agent Deck launcher could not find a bundled binary and 'go' is unavailable to build one" >&2
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

read_effective_memory_bytes() {
  local cgroup_limit=""
  local mem_total=""
  if [[ -r /sys/fs/cgroup/memory.max ]]; then
    cgroup_limit="$(cat /sys/fs/cgroup/memory.max 2>/dev/null || true)"
  fi
  if [[ -r /proc/meminfo ]]; then
    mem_total="$(awk '/^MemTotal:/ { print $2 * 1024 }' /proc/meminfo 2>/dev/null || true)"
  fi
  if [[ "$cgroup_limit" =~ ^[0-9]+$ && "$mem_total" =~ ^[0-9]+$ ]]; then
    if (( cgroup_limit < mem_total )); then
      echo "$cgroup_limit"
    else
      echo "$mem_total"
    fi
  elif [[ "$cgroup_limit" =~ ^[0-9]+$ ]]; then
    echo "$cgroup_limit"
  elif [[ "$mem_total" =~ ^[0-9]+$ ]]; then
    echo "$mem_total"
  else
    echo $((8 * 1024 * 1024 * 1024))
  fi
}

derive_memory_scope_defaults() {
  local gib=$((1024 * 1024 * 1024))
  local mib=$((1024 * 1024))
  local effective="${PIXEL_FORGE_EFFECTIVE_RAM_BYTES:-$(read_effective_memory_bytes)}"
  [[ "$effective" =~ ^[0-9]+$ ]] || effective=$((8 * gib))
  (( effective < 2 * gib )) && effective=$((2 * gib))

  local reserve=$((effective / 5))
  (( reserve < 2 * gib )) && reserve=$((2 * gib))
  local pool=$((effective - reserve))
  (( pool < gib )) && pool=$gib

  local high=$((pool * 75 / 100))
  (( high < 2 * gib )) && high=$((2 * gib))
  local max=$((pool * 90 / 100))
  (( max < high )) && max=$high
  (( max > pool )) && max=$pool
  (( high > max )) && high=$max
  local swap=$((effective / 10))
  (( swap < 512 * mib )) && swap=$((512 * mib))
  (( swap > 2 * gib )) && swap=$((2 * gib))

  export PIXEL_FORGE_AGENT_DECK_MEMORY_HIGH_BYTES="${PIXEL_FORGE_AGENT_DECK_MEMORY_HIGH_BYTES:-${PIXEL_FORGE_AGENT_DECK_MEMORY_HIGH:-$high}}"
  export PIXEL_FORGE_AGENT_DECK_MEMORY_MAX_BYTES="${PIXEL_FORGE_AGENT_DECK_MEMORY_MAX_BYTES:-${PIXEL_FORGE_AGENT_DECK_MEMORY_MAX:-$max}}"
  export PIXEL_FORGE_AGENT_DECK_MEMORY_SWAP_MAX_BYTES="${PIXEL_FORGE_AGENT_DECK_MEMORY_SWAP_MAX_BYTES:-${PIXEL_FORGE_AGENT_DECK_MEMORY_SWAP_MAX:-$swap}}"
}

should_use_memory_scope() {
  case "${PIXEL_FORGE_AGENT_DECK_MEMORY_SCOPE:-1}" in
    0|false|FALSE|no|NO|off|OFF) return 1 ;;
  esac
  case "${1:-}" in
    ""|launch|web-standalone) ;;
    session)
      case "${2:-}" in
        start|restart|fork) ;;
        *) return 1 ;;
      esac
      ;;
    *) return 1 ;;
  esac
  [[ "${PIXEL_FORGE_AGENT_DECK_IN_MEMORY_SCOPE:-}" != "1" ]] || return 1
  command -v systemd-run >/dev/null 2>&1 || return 1
  systemctl --user show-environment >/dev/null 2>&1 || return 1
  return 0
}

if should_use_memory_scope "$@"; then
  derive_memory_scope_defaults
  export PIXEL_FORGE_AGENT_DECK_IN_MEMORY_SCOPE=1
  scope_slice="${PIXEL_FORGE_AGENT_DECK_SLICE:-pixel-forge-agent-deck.slice}"
  preflight_unit="pixel-forge-agent-deck-preflight-$(date +%s%N)"
  if ! systemd-run --user --scope --quiet --collect \
    "--unit=$preflight_unit" \
    "--slice=$scope_slice" \
    -p MemoryAccounting=yes \
    -p "MemoryHigh=$PIXEL_FORGE_AGENT_DECK_MEMORY_HIGH_BYTES" \
    -p "MemoryMax=$PIXEL_FORGE_AGENT_DECK_MEMORY_MAX_BYTES" \
    -p "MemorySwapMax=$PIXEL_FORGE_AGENT_DECK_MEMORY_SWAP_MAX_BYTES" \
    true >/dev/null 2>&1; then
    echo "Agent Deck memory scope unavailable; falling back to unscoped launch" >&2
    exec "$RUN_BIN" "$@"
  fi
  scope_unit="pixel-forge-agent-deck-$(date +%s%N)"
  exec systemd-run --user --scope --quiet --collect \
    "--unit=$scope_unit" \
    "--slice=$scope_slice" \
    -p MemoryAccounting=yes \
    -p "MemoryHigh=$PIXEL_FORGE_AGENT_DECK_MEMORY_HIGH_BYTES" \
    -p "MemoryMax=$PIXEL_FORGE_AGENT_DECK_MEMORY_MAX_BYTES" \
    -p "MemorySwapMax=$PIXEL_FORGE_AGENT_DECK_MEMORY_SWAP_MAX_BYTES" \
    "$RUN_BIN" "$@"
fi

exec "$RUN_BIN" "$@"
