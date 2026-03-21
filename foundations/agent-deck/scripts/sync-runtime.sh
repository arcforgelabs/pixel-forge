#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"

RUNTIME_DIR="${AGENTDECK_DIR:-${AGENT_DECK_DIR:-${PIXEL_FORGE_AGENT_DECK_HOME:-${HOME}/.agent-deck}}}"
CONDUCTOR_DIR="${RUNTIME_DIR}/conductor"
SYSTEMD_USER_DIR="${HOME}/.config/systemd/user"
RUNTIME_ROOT=""

usage() {
  cat <<'EOF'
Usage: ./scripts/sync-runtime.sh [--runtime-root <path>]

Syncs runtime assets into the active Agent Deck home from either:
  - the repo checkout (default), or
  - a published runtime layer release (--runtime-root)
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --runtime-root)
      [[ $# -ge 2 ]] || { echo "sync-runtime: --runtime-root requires a path" >&2; exit 1; }
      RUNTIME_ROOT="$2"
      shift 2
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "sync-runtime: unknown argument: $1" >&2
      exit 1
      ;;
  esac
done

if [[ -n "${RUNTIME_ROOT}" ]]; then
  SRC_BRIDGE="${RUNTIME_ROOT}/runtime/bridge.py"
else
  SRC_BRIDGE="${REPO_DIR}/conductor/bridge.py"
fi

DST_BRIDGE="${CONDUCTOR_DIR}/bridge.py"

stamp() {
  date +%Y%m%d-%H%M%S
}

install_bridge() {
  if [[ ! -f "${SRC_BRIDGE}" ]]; then
    echo "sync-runtime: source bridge.py missing at ${SRC_BRIDGE}" >&2
    return 1
  fi

  mkdir -p "${CONDUCTOR_DIR}"

  if [[ -f "${DST_BRIDGE}" ]] && ! cmp -s "${SRC_BRIDGE}" "${DST_BRIDGE}"; then
    cp "${DST_BRIDGE}" "${DST_BRIDGE}.pre-sync.$(stamp).bak"
  fi

  install -m 0755 "${SRC_BRIDGE}" "${DST_BRIDGE}"
  echo "sync-runtime: installed bridge.py -> ${DST_BRIDGE}"
}

cleanup_legacy_heartbeat_units() {
  if [[ ! -d "${SYSTEMD_USER_DIR}" ]]; then
    return 0
  fi

  local removed=0
  local unit
  for unit_path in "${SYSTEMD_USER_DIR}"/agent-deck-conductor-heartbeat-*.service "${SYSTEMD_USER_DIR}"/agent-deck-conductor-heartbeat-*.timer; do
    [[ -e "${unit_path}" ]] || continue
    unit="$(basename "${unit_path}")"
    systemctl --user disable --now "${unit}" >/dev/null 2>&1 || true
    rm -f "${unit_path}"
    echo "sync-runtime: removed legacy unit ${unit}"
    removed=1
  done

  if [[ ${removed} -eq 1 ]]; then
    systemctl --user daemon-reload >/dev/null 2>&1 || true
  fi
}

cleanup_legacy_heartbeat_scripts() {
  local removed=0
  local hb
  for hb in "${CONDUCTOR_DIR}"/*/heartbeat.sh; do
    [[ -e "${hb}" ]] || continue
    rm -f "${hb}"
    echo "sync-runtime: removed legacy heartbeat script ${hb}"
    removed=1
  done

  return 0
}

disable_bridge_if_conductor_disabled() {
  local config_path="${RUNTIME_DIR}/config.toml"
  [[ -f "${config_path}" ]] || return 0

  local enabled
  enabled="$(awk '
    /^\[conductor\]/{in_section=1; next}
    /^\[/{if (in_section) exit; next}
    in_section && $1 == "enabled" {print $3; exit}
  ' "${config_path}" | tr -d '"' | tr '[:upper:]' '[:lower:]')"

  if [[ "${enabled}" == "false" ]]; then
    systemctl --user disable --now agent-deck-conductor-bridge.service >/dev/null 2>&1 || true
    echo "sync-runtime: disabled bridge service (conductor.enabled=false)"
  fi
}

restart_transition_notifier() {
  if ! command -v systemctl >/dev/null 2>&1; then
    return 0
  fi

  if systemctl --user status agent-deck-transition-notifier.service >/dev/null 2>&1; then
    systemctl --user restart agent-deck-transition-notifier.service >/dev/null 2>&1 || true
    echo "sync-runtime: restarted transition notifier service"
  fi
}

install_bridge
cleanup_legacy_heartbeat_units
cleanup_legacy_heartbeat_scripts
disable_bridge_if_conductor_disabled
restart_transition_notifier

echo "sync-runtime: complete"
