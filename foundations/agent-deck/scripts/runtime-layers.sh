#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
HOST_HOME="${HOME}"

LAYERS_ROOT="${HOST_HOME}/.local/share/agent-deck/layers"
ACTIVE_LINK_PATH="${LAYERS_ROOT}/active"
WRAPPER_PATH="${HOST_HOME}/.local/bin/agent-deck"
LAYERS_WRAPPER_PATH="${HOST_HOME}/.local/bin/agent-deck-layers"
STOCK_WRAPPER_PATH="${HOST_HOME}/.local/bin/agent-deck-stock"
DEFAULT_BUILD_PATH="${REPO_DIR}/build/agent-deck"
OVERLAY_SOURCE_BRIDGE_PATH="${REPO_DIR}/conductor/bridge.py"

UPSTREAM_STOCK_SOURCE_REPO_DEFAULT="${HOST_HOME}/repos/2-areas/agent-deck-base-source"
UPSTREAM_STOCK_SOURCE_REPO="${AGENT_DECK_UPSTREAM_SOURCE_REPO:-${UPSTREAM_STOCK_SOURCE_REPO_DEFAULT}}"
UPSTREAM_STOCK_REMOTE_URL="${AGENT_DECK_UPSTREAM_REMOTE_URL:-https://github.com/asheshgoplani/agent-deck.git}"
UPSTREAM_STOCK_LANE="upstream-stock"
UPSTREAM_STOCK_SANDBOX_ROOT="${HOST_HOME}/.local/share/agent-deck/sandboxes/upstream-stock"
UPSTREAM_STOCK_SANDBOX_BIN="${UPSTREAM_STOCK_SANDBOX_ROOT}/bin"
UPSTREAM_STOCK_SANDBOX_HOME="${UPSTREAM_STOCK_SANDBOX_ROOT}/home"
UPSTREAM_STOCK_TMUX_SOCKET="${AGENT_DECK_STOCK_TMUX_SOCKET:-agentdeck-stock}"
UPSTREAM_STOCK_PROFILE="${AGENT_DECK_STOCK_PROFILE:-upstream-stock}"
UPSTREAM_STOCK_UI_LABEL="${AGENT_DECK_STOCK_UI_LABEL:-UPSTREAM STOCK}"
UPSTREAM_STOCK_DEFAULT_WEB_LISTEN="${AGENT_DECK_STOCK_DEFAULT_WEB_LISTEN:-127.0.0.1:8421}"

usage() {
  cat <<'EOF'
Usage:
  ./scripts/runtime-layers.sh status
  ./scripts/runtime-layers.sh publish-workstation [--activate] [--from-build <path>]
  ./scripts/runtime-layers.sh promote-client-approved [--activate]
  ./scripts/runtime-layers.sh activate <workstation|client-approved>
  ./scripts/runtime-layers.sh sync-upstream-stock-source [--source-repo <path>]
  ./scripts/runtime-layers.sh publish-upstream-stock [--source-repo <path>] [--skip-refresh]

This manages the local layered Agent Deck runtime:
  overlay source checkout -> workstation/client-approved lanes -> active launcher
  upstream base checkout  -> upstream-stock lane             -> agent-deck-stock launcher
EOF
}

log() {
  printf '[runtime-layers] %s\n' "$*" >&2
}

fail() {
  printf '[runtime-layers][error] %s\n' "$*" >&2
  exit 1
}

ensure_dir() {
  mkdir -p "$1"
}

write_executable() {
  local file_path="$1"
  local tmp_path="${file_path}.tmp.$$"
  ensure_dir "$(dirname "${file_path}")"
  cat >"${tmp_path}"
  chmod 0755 "${tmp_path}"
  mv -f "${tmp_path}" "${file_path}"
}

safe_install_file() {
  local src_path="$1"
  local dst_path="$2"
  local mode="$3"
  local tmp_path="${dst_path}.tmp.$$"
  ensure_dir "$(dirname "${dst_path}")"
  cp "${src_path}" "${tmp_path}"
  chmod "${mode}" "${tmp_path}"
  mv -f "${tmp_path}" "${dst_path}"
}

replace_symlink() {
  local link_path="$1"
  local target_path="$2"
  ensure_dir "$(dirname "${link_path}")"
  rm -rf "${link_path}"
  ln -s "${target_path}" "${link_path}"
}

lane_root() {
  printf '%s\n' "${LAYERS_ROOT}/$1"
}

lane_releases_root() {
  printf '%s\n' "$(lane_root "$1")/releases"
}

lane_current_path() {
  printf '%s\n' "$(lane_root "$1")/current"
}

resolve_link_target() {
  local link_path="$1"
  if [[ -L "${link_path}" ]]; then
    readlink "${link_path}"
  fi
}

resolve_lane_current_release() {
  local lane="$1"
  local target_path
  target_path="$(resolve_link_target "$(lane_current_path "${lane}")")"
  [[ -n "${target_path}" && -d "${target_path}" ]] || return 1
  printf '%s\n' "${target_path}"
}

json_string() {
  local file_path="$1"
  local key="$2"
  sed -n "s/^[[:space:]]*\"${key}\": \"\\(.*\\)\",\{0,1\}$/\\1/p" "${file_path}" | head -n 1
}

json_bool() {
  local file_path="$1"
  local key="$2"
  sed -n "s/^[[:space:]]*\"${key}\": \\(true\\|false\\),\{0,1\}$/\\1/p" "${file_path}" | head -n 1
}

git_branch() {
  git -C "$1" branch --show-current
}

git_head() {
  git -C "$1" rev-parse HEAD
}

git_short_head() {
  git -C "$1" rev-parse --short HEAD
}

git_dirty() {
  if [[ -n "$(git -C "$1" status --porcelain)" ]]; then
    printf 'true\n'
  else
    printf 'false\n'
  fi
}

detect_repo_version() {
  local repo_dir="$1"
  local version
  version="$(git -C "${repo_dir}" describe --tags --always --dirty 2>/dev/null || \
    sed -n 's/^const Version = "\(.*\)"/\1/p' "${repo_dir}/cmd/agent-deck/main.go" | head -n 1)"
  printf '%s\n' "${version#v}"
}

detect_binary_version() {
  local binary_path="$1"
  local fallback_repo_dir="$2"
  local version_line
  version_line="$("${binary_path}" version 2>/dev/null | sed -n 's/^Agent Deck\( \[[^]]*\]\)\{0,1\} v//p' | head -n 1 || true)"
  if [[ -n "${version_line}" ]]; then
    printf '%s\n' "${version_line}"
    return 0
  fi
  detect_repo_version "${fallback_repo_dir}"
}

resolve_go() {
  local candidate
  for candidate in "${HOST_HOME}/go-1.24/bin/go" "/usr/local/go/bin/go" "$(command -v go 2>/dev/null || true)"; do
    if [[ -n "${candidate}" && -x "${candidate}" ]]; then
      local ver
      ver="$("${candidate}" version 2>/dev/null | grep -oP '1\.\d+' | head -1)" || continue
      local minor="${ver#*.}"
      if [[ "${minor}" -ge 24 ]] 2>/dev/null; then
        printf '%s\n' "${candidate}"
        return 0
      fi
    fi
  done

  fail "Go 1.24+ required. Install to ~/go-1.24 before publishing runtimes."
}

format_release_id() {
  local short_head="$1"
  local dirty="$2"
  local release_id
  release_id="$(date -u +%Y%m%d-%H%M%Sz)-${short_head}"
  if [[ "${dirty}" == "true" ]]; then
    release_id="${release_id}-dirty"
  fi
  printf '%s\n' "${release_id}"
}

ensure_build_path() {
  local build_path="${1:-}"
  if [[ -z "${build_path}" ]]; then
    log "building overlay source checkout"
    "${REPO_DIR}/dev-install.sh" build
    build_path="${DEFAULT_BUILD_PATH}"
  fi
  [[ -x "${build_path}" ]] || fail "build binary missing at ${build_path}"
  printf '%s\n' "${build_path}"
}

build_repo_binary() {
  local repo_dir="$1"
  local output_path="$2"
  local go_bin version
  go_bin="$(resolve_go)"
  version="$(git -C "${repo_dir}" describe --tags --always --dirty 2>/dev/null || echo "dev")"
  ensure_dir "$(dirname "${output_path}")"
  (
    cd "${repo_dir}"
    "${go_bin}" build -ldflags "-X main.Version=${version}" -o "${output_path}" ./cmd/agent-deck
  )
}

write_release_metadata() {
  local release_dir="$1"
  local lane="$2"
  local installed_at="$3"
  local source_repo_dir="$4"
  local source_branch="$5"
  local source_head="$6"
  local source_short_head="$7"
  local source_dirty="$8"
  local version="$9"
  local release_id
  release_id="$(basename "${release_dir}")"

  cat >"${release_dir}/layer-meta.json" <<EOF
{
  "lane": "${lane}",
  "releaseId": "${release_id}",
  "installedAt": "${installed_at}",
  "binaryPath": "${release_dir}/bin/agent-deck",
  "runtimeRoot": "${release_dir}/runtime",
  "source": {
    "repoPath": "${source_repo_dir}",
    "branch": "${source_branch}",
    "head": "${source_head}",
    "shortHead": "${source_short_head}",
    "dirty": ${source_dirty},
    "version": "${version}"
  }
}
EOF
}

install_build_to_lane() {
  local lane="$1"
  local build_path="$2"
  local source_repo_dir="$3"
  local source_bridge_path="${4:-}"

  local source_branch source_head source_short_head source_dirty version release_id installed_at
  source_branch="$(git_branch "${source_repo_dir}")"
  source_head="$(git_head "${source_repo_dir}")"
  source_short_head="$(git_short_head "${source_repo_dir}")"
  source_dirty="$(git_dirty "${source_repo_dir}")"
  version="$(detect_binary_version "${build_path}" "${source_repo_dir}")"
  release_id="$(format_release_id "${source_short_head}" "${source_dirty}")"
  installed_at="$(date -u +%Y-%m-%dT%H:%M:%SZ)"

  local release_dir
  release_dir="$(lane_releases_root "${lane}")/${release_id}"
  ensure_dir "${release_dir}/bin"
  ensure_dir "${release_dir}/runtime"

  safe_install_file "${build_path}" "${release_dir}/bin/agent-deck" 0755
  if [[ -n "${source_bridge_path}" && -f "${source_bridge_path}" ]]; then
    safe_install_file "${source_bridge_path}" "${release_dir}/runtime/bridge.py" 0755
  fi
  write_release_metadata "${release_dir}" "${lane}" "${installed_at}" "${source_repo_dir}" "${source_branch}" \
    "${source_head}" "${source_short_head}" "${source_dirty}" "${version}"

  replace_symlink "$(lane_current_path "${lane}")" "${release_dir}"
  printf '%s\n' "${release_dir}"
}

copy_release_to_lane() {
  local source_release_dir="$1"
  local lane="$2"
  local meta_path="${source_release_dir}/layer-meta.json"
  [[ -f "${meta_path}" ]] || fail "layer metadata missing at ${meta_path}"

  local source_repo_dir source_branch source_head source_short_head source_dirty version installed_at release_id
  source_repo_dir="$(json_string "${meta_path}" repoPath)"
  source_branch="$(json_string "${meta_path}" branch)"
  source_head="$(json_string "${meta_path}" head)"
  source_short_head="$(json_string "${meta_path}" shortHead)"
  source_dirty="$(json_bool "${meta_path}" dirty)"
  version="$(json_string "${meta_path}" version)"
  installed_at="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  release_id="$(format_release_id "${source_short_head}" "${source_dirty}")"

  local release_dir
  release_dir="$(lane_releases_root "${lane}")/${release_id}"
  ensure_dir "${release_dir}/bin"
  ensure_dir "${release_dir}/runtime"

  safe_install_file "${source_release_dir}/bin/agent-deck" "${release_dir}/bin/agent-deck" 0755
  if [[ -f "${source_release_dir}/runtime/bridge.py" ]]; then
    safe_install_file "${source_release_dir}/runtime/bridge.py" "${release_dir}/runtime/bridge.py" 0755
  fi
  write_release_metadata "${release_dir}" "${lane}" "${installed_at}" "${source_repo_dir}" "${source_branch}" \
    "${source_head}" "${source_short_head}" "${source_dirty}" "${version}"

  replace_symlink "$(lane_current_path "${lane}")" "${release_dir}"
  printf '%s\n' "${release_dir}"
}

install_overlay_wrappers() {
  write_executable "${WRAPPER_PATH}" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
ACTIVE_ROOT="${AGENT_DECK_ACTIVE_LAYER_ROOT:-$HOME/.local/share/agent-deck/layers/active}"
BINARY="${ACTIVE_ROOT}/bin/agent-deck"
if [[ ! -x "${BINARY}" ]]; then
  echo "agent-deck: active layer binary missing at ${BINARY}" >&2
  exit 1
fi
exec "${BINARY}" "$@"
EOF

  write_executable "${LAYERS_WRAPPER_PATH}" <<EOF
#!/usr/bin/env bash
set -euo pipefail
SCRIPT="\${AGENT_DECK_LAYERS_SOURCE:-${REPO_DIR}/scripts/runtime-layers.sh}"
if [[ ! -x "\${SCRIPT}" ]]; then
  echo "agent-deck-layers: source script missing at \${SCRIPT}" >&2
  exit 1
fi
exec "\${SCRIPT}" "\$@"
EOF
}

install_stock_wrapper() {
  local tmux_bin
  tmux_bin="$(command -v tmux 2>/dev/null || true)"
  if [[ -z "${tmux_bin}" ]]; then
    tmux_bin="tmux"
  fi

  write_executable "${UPSTREAM_STOCK_SANDBOX_BIN}/agent-deck" <<EOF
#!/usr/bin/env bash
set -euo pipefail
HOST_HOME="${HOST_HOME}"
STOCK_LAYER_ROOT="\${AGENT_DECK_STOCK_LAYER_ROOT:-${LAYERS_ROOT}/${UPSTREAM_STOCK_LANE}/current}"
STOCK_SANDBOX_ROOT="\${AGENT_DECK_STOCK_SANDBOX_ROOT:-${UPSTREAM_STOCK_SANDBOX_ROOT}}"
STOCK_SANDBOX_HOME="\${STOCK_SANDBOX_ROOT}/home"
STOCK_SANDBOX_BIN="\${STOCK_SANDBOX_ROOT}/bin"
STOCK_BINARY="\${STOCK_LAYER_ROOT}/bin/agent-deck"
REAL_TMUX="\${AGENT_DECK_REAL_TMUX:-${tmux_bin}}"
TMUX_SOCKET="\${AGENT_DECK_STOCK_TMUX_SOCKET:-${UPSTREAM_STOCK_TMUX_SOCKET}}"
STOCK_PROFILE="\${AGENT_DECK_STOCK_PROFILE:-${UPSTREAM_STOCK_PROFILE}}"
UI_LABEL="\${AGENTDECK_UI_LABEL:-${UPSTREAM_STOCK_UI_LABEL}}"
DEFAULT_WEB_LISTEN="\${AGENT_DECK_STOCK_DEFAULT_WEB_LISTEN:-${UPSTREAM_STOCK_DEFAULT_WEB_LISTEN}}"

if [[ ! -x "\${STOCK_BINARY}" ]]; then
  echo "agent-deck-stock: upstream stock binary missing at \${STOCK_BINARY}" >&2
  echo "Publish it with: agent-deck-layers publish-upstream-stock" >&2
  exit 1
fi

mkdir -p "\${STOCK_SANDBOX_HOME}" "\${STOCK_SANDBOX_BIN}" "\${STOCK_SANDBOX_HOME}/.config" \
  "\${STOCK_SANDBOX_HOME}/.local/share" "\${STOCK_SANDBOX_HOME}/.cache" "\${STOCK_SANDBOX_HOME}/.agent-deck"

cat >"\${STOCK_SANDBOX_BIN}/tmux" <<TMUXEOF
#!/usr/bin/env bash
set -euo pipefail
exec "\${REAL_TMUX}" -L "\${TMUX_SOCKET}" "\$@"
TMUXEOF
chmod 0755 "\${STOCK_SANDBOX_BIN}/tmux"

CONFIG_PATH="\${STOCK_SANDBOX_HOME}/.agent-deck/config.toml"
if [[ ! -f "\${CONFIG_PATH}" ]]; then
  cat >"\${CONFIG_PATH}" <<'CFGEOF'
# Auto-generated by agent-deck-stock.
# This sandbox isolates stock upstream Agent Deck state from the main overlay install.

[conductor]
enabled = false

[updates]
check_enabled = false

[mcp_pool]
pool_all = false
CFGEOF
fi

export HOME="\${STOCK_SANDBOX_HOME}"
export XDG_CONFIG_HOME="\${STOCK_SANDBOX_HOME}/.config"
export XDG_DATA_HOME="\${STOCK_SANDBOX_HOME}/.local/share"
export XDG_CACHE_HOME="\${STOCK_SANDBOX_HOME}/.cache"
export AGENTDECK_PROFILE="\${AGENTDECK_PROFILE:-\${STOCK_PROFILE}}"
export AGENTDECK_UI_LABEL="\${UI_LABEL}"
export AGENTDECK_STOCK_SANDBOX=1

case ":\${PATH}:" in
  *":\${STOCK_SANDBOX_BIN}:"*) ;;
  *) export PATH="\${STOCK_SANDBOX_BIN}:\${PATH}" ;;
esac

args=("\$@")
if [[ \${#args[@]} -gt 0 ]]; then
  case "\${args[0]}" in
    version|--version|-v)
      "\${STOCK_BINARY}" "\${args[@]}" | sed '1s/^Agent Deck /Agent Deck [UPSTREAM STOCK] /'
      exit \${PIPESTATUS[0]}
      ;;
    help|--help|-h)
      "\${STOCK_BINARY}" "\${args[@]}" | sed \
        -e '1s/^Agent Deck /Agent Deck [UPSTREAM STOCK] /' \
        -e 's/^Usage: agent-deck /Usage: agent-deck-stock /' \
        -e 's/  agent-deck /  agent-deck-stock /g'
      exit \${PIPESTATUS[0]}
      ;;
  esac
fi

if [[ \${#args[@]} -gt 0 && "\${args[0]}" == "web" ]]; then
  has_listen=0
  for arg in "\${args[@]}"; do
    if [[ "\${arg}" == "--listen" || "\${arg}" == "-listen" || "\${arg}" == "--listen="* || "\${arg}" == "-listen="* ]]; then
      has_listen=1
      break
    fi
  done
  if [[ \${has_listen} -eq 0 ]]; then
    args+=("-listen" "\${DEFAULT_WEB_LISTEN}")
  fi
fi

exec "\${STOCK_BINARY}" "\${args[@]}"
EOF

  write_executable "${STOCK_WRAPPER_PATH}" <<EOF
#!/usr/bin/env bash
set -euo pipefail
exec "${UPSTREAM_STOCK_SANDBOX_BIN}/agent-deck" "\$@"
EOF
}

install_host_wrappers() {
  install_overlay_wrappers
  install_stock_wrapper
}

active_release_path() {
  local target_path
  target_path="$(resolve_link_target "${ACTIVE_LINK_PATH}")"
  [[ -n "${target_path}" && -d "${target_path}" ]] || return 1
  printf '%s\n' "${target_path}"
}

activate_lane() {
  local lane="$1"
  local release_dir
  release_dir="$(resolve_lane_current_release "${lane}")" || fail "lane ${lane} has no current release"
  [[ -x "${release_dir}/bin/agent-deck" ]] || fail "release binary missing at ${release_dir}/bin/agent-deck"
  [[ -f "${release_dir}/runtime/bridge.py" ]] || fail "release bridge missing at ${release_dir}/runtime/bridge.py"

  replace_symlink "${ACTIVE_LINK_PATH}" "${release_dir}"
  install_host_wrappers
  "${REPO_DIR}/scripts/sync-runtime.sh" --runtime-root "${ACTIVE_LINK_PATH}"
}

print_repo_status() {
  local label="$1"
  local repo_dir="$2"
  if [[ ! -d "${repo_dir}/.git" ]]; then
    printf '%s: missing (%s)\n' "${label}" "${repo_dir}"
    return
  fi

  local repo_branch repo_short_head repo_dirty repo_version dirty_suffix=""
  repo_branch="$(git_branch "${repo_dir}")"
  repo_short_head="$(git_short_head "${repo_dir}")"
  repo_dirty="$(git_dirty "${repo_dir}")"
  repo_version="$(detect_repo_version "${repo_dir}")"
  if [[ "${repo_dirty}" == "true" ]]; then
    dirty_suffix=" dirty"
  fi

  printf '%s: %s %s v%s%s (%s)\n' "${label}" "${repo_branch}" "${repo_short_head}" "${repo_version}" "${dirty_suffix}" "${repo_dir}"
}

print_lane_status() {
  local lane="$1"
  local release_dir meta_path release_id branch short_head version dirty active_path active_marker=""
  release_dir="$(resolve_lane_current_release "${lane}" 2>/dev/null || true)"
  if [[ -z "${release_dir}" ]]; then
    printf 'lane:%s: empty\n' "${lane}"
    return
  fi

  meta_path="${release_dir}/layer-meta.json"
  release_id="$(json_string "${meta_path}" releaseId)"
  branch="$(json_string "${meta_path}" branch)"
  short_head="$(json_string "${meta_path}" shortHead)"
  version="$(json_string "${meta_path}" version)"
  dirty="$(json_bool "${meta_path}" dirty)"
  active_path="$(active_release_path 2>/dev/null || true)"
  if [[ "${active_path}" == "${release_dir}" ]]; then
    active_marker=" active"
  fi
  if [[ "${dirty}" == "true" ]]; then
    dirty=" dirty"
  else
    dirty=""
  fi

  printf 'lane:%s: %s source=%s@%s v%s%s%s\n' \
    "${lane}" "${release_id}" "${branch}" "${short_head}" "${version}" "${dirty}" "${active_marker}"
}

status() {
  install_host_wrappers
  print_repo_status "overlay-source" "${REPO_DIR}"
  print_repo_status "base-source" "${UPSTREAM_STOCK_SOURCE_REPO}"
  print_lane_status "workstation"
  print_lane_status "client-approved"
  print_lane_status "${UPSTREAM_STOCK_LANE}"
  if [[ -L "${ACTIVE_LINK_PATH}" ]]; then
    printf 'active: %s\n' "$(readlink "${ACTIVE_LINK_PATH}")"
  else
    printf 'active: empty\n'
  fi
  printf 'wrapper: %s\n' "${WRAPPER_PATH}"
  printf 'layers-wrapper: %s\n' "${LAYERS_WRAPPER_PATH}"
  printf 'stock-wrapper: %s\n' "${STOCK_WRAPPER_PATH}"
  printf 'stock-profile: %s\n' "${UPSTREAM_STOCK_PROFILE}"
  printf 'stock-ui-label: %s\n' "${UPSTREAM_STOCK_UI_LABEL}"
  printf 'stock-sandbox: %s\n' "${UPSTREAM_STOCK_SANDBOX_ROOT}"
  printf 'stock-web-default: %s\n' "${UPSTREAM_STOCK_DEFAULT_WEB_LISTEN}"
}

publish_workstation() {
  local activate=0
  local build_path=""

  while [[ $# -gt 0 ]]; do
    case "$1" in
      --activate)
        activate=1
        shift
        ;;
      --from-build)
        [[ $# -ge 2 ]] || fail "--from-build requires a path"
        build_path="$2"
        shift 2
        ;;
      *)
        fail "unknown publish-workstation argument: $1"
        ;;
    esac
  done

  build_path="$(ensure_build_path "${build_path}")"
  local release_dir
  release_dir="$(install_build_to_lane "workstation" "${build_path}" "${REPO_DIR}" "${OVERLAY_SOURCE_BRIDGE_PATH}")"
  install_host_wrappers
  if [[ ${activate} -eq 1 ]]; then
    activate_lane "workstation"
  fi

  printf 'published workstation release %s\n' "$(basename "${release_dir}")"
}

promote_client_approved() {
  local activate=0
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --activate)
        activate=1
        shift
        ;;
      *)
        fail "unknown promote-client-approved argument: $1"
        ;;
    esac
  done

  local source_release_dir
  source_release_dir="$(resolve_lane_current_release "workstation")" || \
    fail "workstation lane has no current release to promote"

  local release_dir
  release_dir="$(copy_release_to_lane "${source_release_dir}" "client-approved")"
  install_host_wrappers
  if [[ ${activate} -eq 1 ]]; then
    activate_lane "client-approved"
  fi

  printf 'promoted client-approved release %s\n' "$(basename "${release_dir}")"
}

ensure_upstream_stock_source_repo() {
  local source_repo="${1:-${UPSTREAM_STOCK_SOURCE_REPO}}"

  if [[ ! -d "${source_repo}/.git" ]]; then
    ensure_dir "$(dirname "${source_repo}")"
    log "cloning upstream stock source into ${source_repo}"
    git clone "${UPSTREAM_STOCK_REMOTE_URL}" "${source_repo}"
  fi

  [[ -d "${source_repo}/.git" ]] || fail "not a git repo: ${source_repo}"
  printf '%s\n' "${source_repo}"
}

sync_upstream_stock_source() {
  local source_repo="${UPSTREAM_STOCK_SOURCE_REPO}"
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --source-repo)
        [[ $# -ge 2 ]] || fail "--source-repo requires a path"
        source_repo="$2"
        shift 2
        ;;
      *)
        fail "unknown sync-upstream-stock-source argument: $1"
        ;;
    esac
  done

  source_repo="$(ensure_upstream_stock_source_repo "${source_repo}")"
  if [[ -n "$(git -C "${source_repo}" status --porcelain)" ]]; then
    fail "upstream stock source repo is dirty: ${source_repo}"
  fi

  log "syncing upstream stock source in ${source_repo}"
  git -C "${source_repo}" fetch origin main --prune --tags
  git -C "${source_repo}" switch main >/dev/null 2>&1 || git -C "${source_repo}" switch -c main --track origin/main
  git -C "${source_repo}" reset --hard origin/main >/dev/null

  printf 'synced upstream stock source %s\n' "${source_repo}"
}

publish_upstream_stock() {
  local source_repo="${UPSTREAM_STOCK_SOURCE_REPO}"
  local skip_refresh=0

  while [[ $# -gt 0 ]]; do
    case "$1" in
      --source-repo)
        [[ $# -ge 2 ]] || fail "--source-repo requires a path"
        source_repo="$2"
        shift 2
        ;;
      --skip-refresh)
        skip_refresh=1
        shift
        ;;
      *)
        fail "unknown publish-upstream-stock argument: $1"
        ;;
    esac
  done

  source_repo="$(ensure_upstream_stock_source_repo "${source_repo}")"
  if [[ ${skip_refresh} -eq 0 ]]; then
    sync_upstream_stock_source --source-repo "${source_repo}" >/dev/null
  elif [[ -n "$(git -C "${source_repo}" status --porcelain)" ]]; then
    fail "upstream stock source repo is dirty: ${source_repo}"
  fi

  local temp_build_dir build_path bridge_path release_dir
  temp_build_dir="$(mktemp -d)"
  build_path="${temp_build_dir}/agent-deck"
  bridge_path="${source_repo}/conductor/bridge.py"

  log "building upstream stock source from ${source_repo}"
  build_repo_binary "${source_repo}" "${build_path}"
  release_dir="$(install_build_to_lane "${UPSTREAM_STOCK_LANE}" "${build_path}" "${source_repo}" "${bridge_path}")"
  rm -rf "${temp_build_dir}"

  install_host_wrappers
  printf 'published upstream stock release %s\n' "$(basename "${release_dir}")"
}

main() {
  local command="${1:-}"
  if [[ -z "${command}" || "${command}" == "-h" || "${command}" == "--help" ]]; then
    usage
    [[ -n "${command}" ]] && exit 0
    exit 2
  fi
  shift || true

  case "${command}" in
    status)
      status
      ;;
    publish-workstation)
      publish_workstation "$@"
      ;;
    promote-client-approved)
      promote_client_approved "$@"
      ;;
    activate)
      [[ $# -eq 1 ]] || fail "activate requires one lane name"
      case "$1" in
        workstation|client-approved) ;;
        *) fail "activate requires one of: workstation, client-approved" ;;
      esac
      activate_lane "$1"
      printf 'activated %s\n' "$1"
      ;;
    sync-upstream-stock-source)
      sync_upstream_stock_source "$@"
      ;;
    publish-upstream-stock)
      publish_upstream_stock "$@"
      ;;
    *)
      fail "unknown command: ${command}"
      ;;
  esac
}

main "$@"
