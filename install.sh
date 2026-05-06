#!/bin/bash
# Install Pixel Forge as a self-contained local app.
# FastAPI serves the built React frontend + API; the desktop shell owns preview UX.
# By default this installs a systemd user service, but the launcher also supports
# a pidfile/log based fallback when systemd is unavailable.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# Reused by the installer and by every generated launcher below so a stale shell
# with retired-lane env overrides (e.g. pixel-forge-alpha, pixel-forge-workstation-v2)
# cannot misroute install or runtime. Override with PIXEL_FORGE_INSTALL_ALLOW_RETIRED_LANE_ENV=1
# only when intentionally reproducing a legacy install for investigation.
RETIRED_LANE_ENV_STRIP_SNIPPET=$(cat <<'RETIRED_LANE_STRIP'
_pf_allow_retired_lane_env="${PIXEL_FORGE_INSTALL_ALLOW_RETIRED_LANE_ENV:-0}"
if [ "$_pf_allow_retired_lane_env" != "1" ]; then
    _pf_lane_markers="${PIXEL_FORGE_INSTALL_NAME:-} ${PIXEL_FORGE_INSTANCE_SLUG:-} ${PIXEL_FORGE_CLI_NAME:-} ${PIXEL_FORGE_SHELL_NAME:-} ${PIXEL_FORGE_INSTALL_DIR:-} ${PIXEL_FORGE_BACKUP_DIR:-} ${PIXEL_FORGE_SERVICE_NAME:-} ${PIXEL_FORGE_SHARED_STATE_DIR:-} ${PIXEL_FORGE_LEGACY_SHARED_STATE_DIR:-} ${PIXEL_FORGE_SKILLS_INSTALL_DIR:-} ${PIXEL_FORGE_DB_PATH:-} ${PIXEL_FORGE_DESKTOP_ENTRY_NAME:-} ${PIXEL_FORGE_DESKTOP_FILE_NAME:-} ${PIXEL_FORGE_DESKTOP_ICON_NAME:-} ${PIXEL_FORGE_DESKTOP_ICON_SOURCE:-} ${PIXEL_FORGE_DESKTOP_WM_CLASS:-} ${PIXEL_FORGE_DESKTOP_ICON_PATH:-} ${PIXEL_FORGE_AGENT_DECK_PROFILE:-} ${PIXEL_FORGE_AGENT_DECK_HOME:-} ${PIXEL_FORGE_AGENT_DECK_FOUNDATION_ROOT:-} ${PIXEL_FORGE_AGENT_DECK_CMD:-} ${PIXEL_FORGE_URL_HOST:-} ${PIXEL_FORGE_WEB_HOST:-} ${PIXEL_FORGE_SHELL_URL:-} ${PIXEL_FORGE_PREVIEW_PARTITION:-} ${PIXEL_FORGE_RUNTIME_DIR:-} ${AGENTDECK_PROFILE:-} ${AGENTDECK_DIR:-} ${AGENT_DECK_DIR:-}"
    case "$_pf_lane_markers" in
        *pixel-forge-alpha*|*pixel-forge-workstation-v2*)
            echo "Ignoring retired Pixel Forge lane env overrides from the current shell." >&2
            for _pf_retired_var in \
                PIXEL_FORGE_INSTALL_NAME \
                PIXEL_FORGE_INSTANCE_SLUG \
                PIXEL_FORGE_CLI_NAME \
                PIXEL_FORGE_SHELL_NAME \
                PIXEL_FORGE_INSTALL_DIR \
                PIXEL_FORGE_BACKUP_DIR \
                PIXEL_FORGE_SERVICE_NAME \
                PIXEL_FORGE_SHARED_STATE_DIR \
                PIXEL_FORGE_LEGACY_SHARED_STATE_DIR \
                PIXEL_FORGE_SKILLS_INSTALL_DIR \
                PIXEL_FORGE_DB_PATH \
                PIXEL_FORGE_DESKTOP_ENTRY_NAME \
                PIXEL_FORGE_DESKTOP_FILE_NAME \
                PIXEL_FORGE_DESKTOP_ICON_NAME \
                PIXEL_FORGE_DESKTOP_ICON_SOURCE \
                PIXEL_FORGE_DESKTOP_WM_CLASS \
                PIXEL_FORGE_DESKTOP_ICON_PATH \
                PIXEL_FORGE_AGENT_DECK_PROFILE \
                PIXEL_FORGE_AGENT_DECK_HOME \
                PIXEL_FORGE_AGENT_DECK_FOUNDATION_ROOT \
                PIXEL_FORGE_AGENT_DECK_CMD \
                PIXEL_FORGE_AGENT_DECK_TUI_TITLE \
                PIXEL_FORGE_AGENT_DECK_TUI_WM_CLASS \
                PIXEL_FORGE_STATE_ROOT_MIGRATION_HELPER \
                PIXEL_FORGE_URL_HOST \
                PIXEL_FORGE_WEB_HOST \
                PIXEL_FORGE_SHELL_URL \
                PIXEL_FORGE_PREVIEW_PARTITION \
                PIXEL_FORGE_RUNTIME_DIR \
                AGENTDECK_PROFILE \
                AGENTDECK_DIR \
                AGENT_DECK_DIR
            do
                unset "$_pf_retired_var"
            done
            ;;
    esac
fi
unset _pf_allow_retired_lane_env _pf_retired_var _pf_lane_markers
RETIRED_LANE_STRIP
)

eval "$RETIRED_LANE_ENV_STRIP_SNIPPET"

INSTALL_NAME="${PIXEL_FORGE_INSTALL_NAME:-pixel-forge}"
INSTANCE_SLUG="${PIXEL_FORGE_INSTANCE_SLUG:-$INSTALL_NAME}"
CLI_NAME="${PIXEL_FORGE_CLI_NAME:-$INSTALL_NAME}"
SHELL_NAME="${PIXEL_FORGE_SHELL_NAME:-${INSTALL_NAME}-shell}"
INSTALL_DIR="${PIXEL_FORGE_INSTALL_DIR:-$HOME/.local/lib/${INSTALL_NAME}}"
BACKUP_DIR="${PIXEL_FORGE_BACKUP_DIR:-$HOME/.local/lib/${INSTALL_NAME}.rollback}"
BIN_DIR="${PIXEL_FORGE_BIN_DIR:-$HOME/.local/bin}"
WEB_DIR="$SCRIPT_DIR/apps/web"
DESKTOP_SOURCE_DIR="$SCRIPT_DIR/apps/desktop"
AGENT_DECK_FOUNDATION_SOURCE_DIR="$SCRIPT_DIR/foundations/agent-deck"
AGENT_DECK_RUNNER_SOURCE="$SCRIPT_DIR/scripts/agent-deck.sh"
CLAUDE_CHANNEL_BOOTSTRAP_SOURCE="$SCRIPT_DIR/scripts/bootstrap-claude-channel-spike.sh"
CODEX_CHANNEL_BOOTSTRAP_SOURCE="$SCRIPT_DIR/scripts/bootstrap-codex-channel.sh"
PORT="${PIXEL_FORGE_PORT:-7201}"
API_PORT="${PIXEL_FORGE_API_PORT:-$PORT}"
WEB_HOST="${PIXEL_FORGE_WEB_HOST:-${PIXEL_FORGE_URL_HOST:-${INSTANCE_SLUG}.localhost}}"
URL_HOST="${PIXEL_FORGE_URL_HOST:-$WEB_HOST}"
SERVICE_NAME="${PIXEL_FORGE_SERVICE_NAME:-${INSTALL_NAME}}"
SYSTEMD_DIR="${PIXEL_FORGE_SYSTEMD_DIR:-$HOME/.config/systemd/user}"
SHARED_STATE_DIR="${PIXEL_FORGE_SHARED_STATE_DIR:-$HOME/.${INSTANCE_SLUG}}"
LEGACY_SHARED_STATE_DIR="${PIXEL_FORGE_LEGACY_SHARED_STATE_DIR:-$HOME/.pixel-forge-alpha}"
SKILLS_INSTALL_DIR="${PIXEL_FORGE_SKILLS_INSTALL_DIR:-${SHARED_STATE_DIR}/skills}"
DB_PATH="${PIXEL_FORGE_DB_PATH:-${SHARED_STATE_DIR}/pixel-forge.db}"
AGENT_DECK_PROFILE="${PIXEL_FORGE_AGENT_DECK_PROFILE:-pixel-forge}"
AGENT_DECK_HOME="${PIXEL_FORGE_AGENT_DECK_HOME:-${SHARED_STATE_DIR}/agent-deck}"
CLAUDE_CHANNEL_ENV_FILE="${PIXEL_FORGE_CLAUDE_CHANNEL_ENV_FILE:-${SHARED_STATE_DIR}/claude-channel-spike.env}"
CODEX_CHANNEL_ENV_FILE="${PIXEL_FORGE_CODEX_CHANNEL_ENV_FILE:-${SHARED_STATE_DIR}/codex-channel.env}"
AGENT_DECK_SURFACE_HOST="${PIXEL_FORGE_AGENT_DECK_SURFACE_HOST:-127.0.0.1}"
AGENT_DECK_SURFACE_PORT="${PIXEL_FORGE_AGENT_DECK_SURFACE_PORT:-8422}"
AGENT_DECK_SURFACE_URL="${PIXEL_FORGE_AGENT_DECK_SURFACE_URL:-http://${AGENT_DECK_SURFACE_HOST}:${AGENT_DECK_SURFACE_PORT}}"
AGENT_DECK_FOUNDATION_INSTALL_DIR="$INSTALL_DIR/foundations/agent-deck"
AGENT_DECK_FOUNDATION_BUILD_DIR="$AGENT_DECK_FOUNDATION_INSTALL_DIR/build"
AGENT_DECK_BUNDLED_BINARY_PATH="$AGENT_DECK_FOUNDATION_BUILD_DIR/agent-deck"
AGENT_DECK_FALLBACK_BUNDLED_BINARY_PATH="$AGENT_DECK_FOUNDATION_INSTALL_DIR/agent-deck"
AGENT_DECK_RUNNER_INSTALL_PATH="$INSTALL_DIR/scripts/agent-deck.sh"
AGENT_DECK_CMD_DEFAULT="$AGENT_DECK_RUNNER_INSTALL_PATH"
STATE_ROOT_MIGRATION_HELPER_INSTALL_PATH="$INSTALL_DIR/ensure_state_root.py"
SHELL_URL="${PIXEL_FORGE_SHELL_URL:-http://${URL_HOST}:${API_PORT}}"
PREVIEW_PARTITION="${PIXEL_FORGE_PREVIEW_PARTITION:-persist:${INSTANCE_SLUG}-preview}"
AGENT_DECK_TUI_LAUNCHER_NAME="${PIXEL_FORGE_AGENT_DECK_TUI_LAUNCHER_NAME:-pixel-forge-agent-deck}"
AGENT_DECK_TUI_TITLE="${PIXEL_FORGE_AGENT_DECK_TUI_TITLE:-Agent Deck}"
AGENT_DECK_TUI_WM_CLASS="${PIXEL_FORGE_AGENT_DECK_TUI_WM_CLASS:-pixel-forge-agent-deck}"
AGENT_DECK_TUI_DESKTOP_ENTRY_NAME="${PIXEL_FORGE_AGENT_DECK_TUI_DESKTOP_ENTRY_NAME:-Agent Deck}"
AGENT_DECK_TUI_DESKTOP_FILE_NAME="${PIXEL_FORGE_AGENT_DECK_TUI_DESKTOP_FILE_NAME:-pixel-forge-agent-deck.desktop}"
AGENT_DECK_TUI_ICON_NAME="${PIXEL_FORGE_AGENT_DECK_TUI_ICON_NAME:-pixel-forge-agent-deck}"
AGENT_DECK_TUI_ICON_SOURCE="${PIXEL_FORGE_AGENT_DECK_TUI_ICON_SOURCE:-$SCRIPT_DIR/apps/web/public/favicon/agent-deck.png}"
SKIP_SYSTEMD="${PIXEL_FORGE_INSTALL_SKIP_SYSTEMD:-0}"
SKIP_DESKTOP_INTEGRATION="${PIXEL_FORGE_INSTALL_SKIP_DESKTOP_INTEGRATION:-0}"
INSTALL_CLAUDE_CHANNEL_SPIKE="${PIXEL_FORGE_INSTALL_CLAUDE_CHANNEL_SPIKE:-1}"
INSTALL_CODEX_CHANNEL="${PIXEL_FORGE_INSTALL_CODEX_CHANNEL:-1}"
DESKTOP_ENTRY_NAME="${PIXEL_FORGE_DESKTOP_ENTRY_NAME:-Pixel Forge}"
DESKTOP_FILE_NAME="${PIXEL_FORGE_DESKTOP_FILE_NAME:-${INSTALL_NAME}.desktop}"
DESKTOP_ICON_NAME="${PIXEL_FORGE_DESKTOP_ICON_NAME:-${INSTALL_NAME}}"
DESKTOP_ICON_SOURCE="${PIXEL_FORGE_DESKTOP_ICON_SOURCE:-$SCRIPT_DIR/apps/web/public/favicon/app.png}"
DESKTOP_WM_CLASS="${PIXEL_FORGE_DESKTOP_WM_CLASS:-${INSTALL_NAME}-desktop}"

# Legacy cleanup: pixel-forge-alpha (the alpha lane that preceded this unified install).
LEGACY_ALPHA_INSTALL_NAME="pixel-forge-alpha"
LEGACY_ALPHA_CLI_NAME="pixel-forge-alpha"
LEGACY_ALPHA_SHELL_NAME="pixel-forge-alpha-shell"
LEGACY_ALPHA_SERVICE_NAME="pixel-forge-alpha"
LEGACY_ALPHA_TUI_NAME="pixel-forge-agent-deck-alpha"
LEGACY_ALPHA_INSTALL_DIR="$HOME/.local/lib/pixel-forge-alpha"
LEGACY_ALPHA_BACKUP_DIR="$HOME/.local/lib/pixel-forge-alpha.rollback"
LEGACY_ALPHA_DESKTOP_FILE_NAME="pixel-forge-alpha.desktop"
LEGACY_ALPHA_TUI_DESKTOP_FILE_NAME="pixel-forge-agent-deck-alpha.desktop"
LEGACY_ALPHA_DESKTOP_ICON_NAME="pixel-forge-alpha"
LEGACY_ALPHA_TUI_ICON_NAME="pixel-forge-agent-deck-alpha"

# Legacy cleanup: pre-alpha workstation-v2 prototype (older than -alpha).
LEGACY_WS_V2_INSTALL_NAME="pixel-forge-workstation-v2"
LEGACY_WS_V2_CLI_NAME="pixel-forge-workstation-v2"
LEGACY_WS_V2_SHELL_NAME="pixel-forge-workstation-v2-shell"
LEGACY_WS_V2_SERVICE_NAME="pixel-forge-workstation-v2"
LEGACY_WS_V2_INSTALL_DIR="$HOME/.local/lib/pixel-forge-workstation-v2"
LEGACY_WS_V2_BACKUP_DIR="$HOME/.local/lib/pixel-forge-workstation-v2.rollback"
LEGACY_WS_V2_DESKTOP_FILE_NAME="pixel-forge-workstation-v2.desktop"
LEGACY_WS_V2_DESKTOP_ICON_NAME="pixel-forge-workstation-v2"

# Ensure pnpm/node are in PATH.
for p in "$HOME/.local/bin" "$HOME/.local/share/pnpm" "$HOME/.nvm/versions/node"/*/bin; do
    [ -d "$p" ] && case ":$PATH:" in *":$p:"*) ;; *) export PATH="$p:$PATH" ;; esac
done

require_command() {
    local command_name="$1"
    local install_hint="$2"
    if ! command -v "$command_name" >/dev/null 2>&1; then
        echo "Error: missing required command '$command_name'. ${install_hint}" >&2
        exit 1
    fi
}

backup_install_dir() {
    if [ ! -d "$INSTALL_DIR" ]; then
        return
    fi

    rm -rf "$BACKUP_DIR"
    mkdir -p "$BACKUP_DIR"
    cp -a "$INSTALL_DIR"/. "$BACKUP_DIR"/
}

find_go_binary() {
    if command -v go >/dev/null 2>&1; then
        command -v go
        return 0
    fi
    local candidate
    for candidate in \
        "$HOME/go-1.21/bin/go" \
        "$HOME/go/bin/go" \
        "/usr/local/go/bin/go" \
        "/opt/go/bin/go" \
        "/snap/bin/go"; do
        if [ -x "$candidate" ]; then
            echo "$candidate"
            return 0
        fi
    done
    return 1
}

install_agent_deck_foundation_binary() {
    if [ ! -d "$AGENT_DECK_FOUNDATION_INSTALL_DIR/cmd/agent-deck" ]; then
        return
    fi

    local prebuilt_build_binary="$AGENT_DECK_BUNDLED_BINARY_PATH"
    local fallback_bundled_binary="$AGENT_DECK_FALLBACK_BUNDLED_BINARY_PATH"

    local go_bin
    if go_bin="$(find_go_binary)"; then
        echo "Building bundled Agent Deck binary with $go_bin..."
        rm -rf "$AGENT_DECK_FOUNDATION_BUILD_DIR"
        mkdir -p "$AGENT_DECK_FOUNDATION_BUILD_DIR"
        (
            cd "$AGENT_DECK_FOUNDATION_INSTALL_DIR"
            "$go_bin" build -o "$AGENT_DECK_BUNDLED_BINARY_PATH" ./cmd/agent-deck
        )
        cp "$AGENT_DECK_BUNDLED_BINARY_PATH" "$fallback_bundled_binary"
        chmod +x "$fallback_bundled_binary"
        return
    fi

    if [ -x "$prebuilt_build_binary" ]; then
        echo "Using prebuilt Agent Deck binary from foundation build output..."
        chmod +x "$prebuilt_build_binary"
        cp "$prebuilt_build_binary" "$fallback_bundled_binary"
        chmod +x "$fallback_bundled_binary"
        return
    fi

    rm -rf "$AGENT_DECK_FOUNDATION_BUILD_DIR"
    mkdir -p "$AGENT_DECK_FOUNDATION_BUILD_DIR"

    if [ -x "$fallback_bundled_binary" ]; then
        echo "Using prebuilt Agent Deck binary from the foundation bundle..."
        cp "$fallback_bundled_binary" "$AGENT_DECK_BUNDLED_BINARY_PATH"
        chmod +x "$AGENT_DECK_BUNDLED_BINARY_PATH"
        return
    fi

    echo "Error: unable to provision the bundled Agent Deck binary. Install Go or provide foundations/agent-deck/agent-deck before running install.sh." >&2
    exit 1
}

terminate_processes_matching() {
    local pattern="$1"
    if ! command -v pgrep >/dev/null 2>&1; then
        return
    fi

    local -a pids=()
    mapfile -t pids < <(pgrep -f "$pattern" 2>/dev/null || true)
    if [ "${#pids[@]}" -eq 0 ]; then
        return
    fi

    kill "${pids[@]}" 2>/dev/null || true
    for _ in $(seq 1 5); do
        sleep 1
        mapfile -t pids < <(pgrep -f "$pattern" 2>/dev/null || true)
        if [ "${#pids[@]}" -eq 0 ]; then
            return
        fi
    done

    kill -9 "${pids[@]}" 2>/dev/null || true
}

cleanup_legacy_alpha_install() {
    if [ "$INSTALL_NAME" = "$LEGACY_ALPHA_INSTALL_NAME" ]; then
        return
    fi

    if command -v systemctl >/dev/null 2>&1; then
        systemctl --user stop "${LEGACY_ALPHA_SERVICE_NAME}.service" 2>/dev/null || true
        systemctl --user disable "${LEGACY_ALPHA_SERVICE_NAME}.service" 2>/dev/null || true
        rm -f "$SYSTEMD_DIR/${LEGACY_ALPHA_SERVICE_NAME}.service"
        systemctl --user daemon-reload 2>/dev/null || true
    fi

    terminate_processes_matching "$LEGACY_ALPHA_INSTALL_DIR"
    rm -f "$BIN_DIR/${LEGACY_ALPHA_CLI_NAME}"
    rm -f "$BIN_DIR/${LEGACY_ALPHA_SHELL_NAME}"
    rm -f "$BIN_DIR/${LEGACY_ALPHA_TUI_NAME}"
    rm -f "$HOME/.local/share/applications/${LEGACY_ALPHA_DESKTOP_FILE_NAME}"
    rm -f "$HOME/.local/share/applications/${LEGACY_ALPHA_TUI_DESKTOP_FILE_NAME}"
    rm -f "$HOME/.local/share/icons/hicolor/256x256/apps/${LEGACY_ALPHA_DESKTOP_ICON_NAME}.png"
    rm -f "$HOME/.local/share/icons/hicolor/256x256/apps/${LEGACY_ALPHA_TUI_ICON_NAME}.png"
    rm -rf "$LEGACY_ALPHA_INSTALL_DIR"
    rm -rf "$LEGACY_ALPHA_BACKUP_DIR"
}

cleanup_legacy_workstation_v2_install() {
    if [ "$INSTALL_NAME" = "$LEGACY_WS_V2_INSTALL_NAME" ]; then
        return
    fi

    if command -v systemctl >/dev/null 2>&1; then
        systemctl --user stop "${LEGACY_WS_V2_SERVICE_NAME}.service" 2>/dev/null || true
        systemctl --user disable "${LEGACY_WS_V2_SERVICE_NAME}.service" 2>/dev/null || true
        rm -f "$SYSTEMD_DIR/${LEGACY_WS_V2_SERVICE_NAME}.service"
        systemctl --user daemon-reload 2>/dev/null || true
    fi

    terminate_processes_matching "$LEGACY_WS_V2_INSTALL_NAME"
    rm -f "$BIN_DIR/${LEGACY_WS_V2_CLI_NAME}"
    rm -f "$BIN_DIR/${LEGACY_WS_V2_SHELL_NAME}"
    rm -f "$HOME/.local/share/applications/${LEGACY_WS_V2_DESKTOP_FILE_NAME}"
    rm -f "$HOME/.local/share/icons/hicolor/256x256/apps/${LEGACY_WS_V2_DESKTOP_ICON_NAME}.png"
    rm -rf "$LEGACY_WS_V2_INSTALL_DIR"
    rm -rf "$LEGACY_WS_V2_BACKUP_DIR"
}

clear_stale_controller_updates() {
    # Per CLAUDE.md: if the install/update lane changes, clear and restage old pending
    # controller updates instead of applying stale snapshots. Controller-update state
    # is always rewritten by later runs, so it is safe to remove on every install.
    # Exception: when install.sh is invoked by the controller-update runner, SCRIPT_DIR
    # is the snapshot currently being applied and is also the runner's cwd. Wiping it
    # mid-flight yanks the cwd out from under the runner so the follow-up `pixel-forge
    # restart` spawn fails with ENOENT. Skip the clear in that case — the runner owns
    # snapshot lifecycle (clearPendingControllerUpdate + launchDetachedSnapshotCleanup).
    case "$SCRIPT_DIR/" in
        "$SHARED_STATE_DIR/controller-updates/"*)
            echo "Skipping stale controller-update cleanup (install.sh launched from snapshot $SCRIPT_DIR)."
            return
            ;;
    esac
    rm -rf "$SHARED_STATE_DIR/controller-updates"
    rm -f "$SHARED_STATE_DIR/pending-preview-updates.json"
    rm -f "$SHARED_STATE_DIR/controller-update-apply-state.json"
    rm -f "$SHARED_STATE_DIR/dismissed-controller-update-id.txt"
}

# ============================================================================
# Content-hash build skip.
#
# Every expensive step (frontend build, desktop npm install, pip install, go
# build, agent-deck foundation copy) hashes its inputs and stores the digest
# under CACHE_DIR. A re-run that produces the same digest AND still has the
# artifact on disk reuses it instead of rebuilding. No-op reinstalls drop from
# ~60s to ~5s while any real source change still rebuilds correctly.
# ============================================================================
CACHE_DIR="${PIXEL_FORGE_INSTALL_CACHE_DIR:-$HOME/.cache/pixel-forge/install-cache/$INSTANCE_SLUG}"
mkdir -p "$CACHE_DIR" 2>/dev/null || true

sha_of_paths() {
    # Hash the content of the given files/directories (missing paths are
    # silently ignored). Deterministic via sorted file list.
    local existing=()
    local p
    for p in "$@"; do
        [ -e "$p" ] && existing+=("$p")
    done
    if [ ${#existing[@]} -eq 0 ]; then
        printf 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855\n'
        return 0
    fi
    find "${existing[@]}" -type f \
        -not -path '*/node_modules/*' \
        -not -path '*/.venv/*' \
        -not -path '*/dist/*' \
        -not -path '*/__pycache__/*' \
        -not -path '*/.git/*' \
        -print0 2>/dev/null \
        | LC_ALL=C sort -z \
        | xargs -0 sha256sum 2>/dev/null \
        | sha256sum \
        | cut -d' ' -f1
}

cache_key_path() {
    printf '%s/%s.sha256' "$CACHE_DIR" "$1"
}

cache_matches() {
    local f; f=$(cache_key_path "$1")
    [ -f "$f" ] && [ "$(cat "$f" 2>/dev/null)" = "$2" ]
}

cache_write() {
    local f; f=$(cache_key_path "$1")
    printf '%s\n' "$2" > "$f" 2>/dev/null || true
}

echo "Installing Pixel Forge..."

require_command "python3" "Install Python 3 and re-run ./install.sh."
require_command "pnpm" "Install pnpm and re-run ./install.sh."
require_command "node" "Install Node.js and re-run ./install.sh."
require_command "npm" "Install Node.js/npm and re-run ./install.sh."
require_command "curl" "Install curl and re-run ./install.sh."

# --- Migrate alpha state dir to pixel-forge state dir if needed ---
if [ ! -d "$SHARED_STATE_DIR" ] && [ -d "$LEGACY_SHARED_STATE_DIR" ]; then
    echo "Migrating state from $LEGACY_SHARED_STATE_DIR to $SHARED_STATE_DIR..."
    mv "$LEGACY_SHARED_STATE_DIR" "$SHARED_STATE_DIR"
fi

# --- Install backend directories ---
mkdir -p "$INSTALL_DIR"
mkdir -p "$BIN_DIR"
mkdir -p "$SKILLS_INSTALL_DIR"
mkdir -p "$AGENT_DECK_HOME"

echo "Backing up current install to $BACKUP_DIR..."
backup_install_dir

echo "Copying API to $INSTALL_DIR..."
# Preserve cached artifacts across reinstalls: .venv, desktop (node_modules),
# foundations (agent-deck binary). Each is managed by its own hash-skip step.
find "$INSTALL_DIR" -mindepth 1 -maxdepth 1 \
    -not -name '.venv' \
    -not -name 'desktop' \
    -not -name 'foundations' \
    -exec rm -rf {} + 2>/dev/null || true
cp -r "$SCRIPT_DIR/apps/api/"* "$INSTALL_DIR/"
if [ -f "$SCRIPT_DIR/VERSION" ]; then
    cp "$SCRIPT_DIR/VERSION" "$INSTALL_DIR/VERSION"
fi

# --- Agent Deck foundation (with hash skip) ---
if [ -d "$AGENT_DECK_FOUNDATION_SOURCE_DIR" ]; then
    AGENT_DECK_FOUNDATION_HASH=$(sha_of_paths "$AGENT_DECK_FOUNDATION_SOURCE_DIR")
    if cache_matches agent_deck_foundation "$AGENT_DECK_FOUNDATION_HASH" \
        && [ -d "$AGENT_DECK_FOUNDATION_INSTALL_DIR" ] \
        && [ -x "$AGENT_DECK_BUNDLED_BINARY_PATH" ]; then
        echo "Agent Deck foundation: cache hit, reusing binary."
    else
        echo "Bundling Agent Deck foundation..."
        mkdir -p "$INSTALL_DIR/foundations"
        rm -rf "$AGENT_DECK_FOUNDATION_INSTALL_DIR"
        cp -r "$AGENT_DECK_FOUNDATION_SOURCE_DIR" "$AGENT_DECK_FOUNDATION_INSTALL_DIR"
        install_agent_deck_foundation_binary
        cache_write agent_deck_foundation "$AGENT_DECK_FOUNDATION_HASH"
    fi
fi

if [ -f "$AGENT_DECK_RUNNER_SOURCE" ]; then
    mkdir -p "$INSTALL_DIR/scripts"
    cp "$AGENT_DECK_RUNNER_SOURCE" "$AGENT_DECK_RUNNER_INSTALL_PATH"
    chmod +x "$AGENT_DECK_RUNNER_INSTALL_PATH"
fi

# --- Parallel build steps (frontend / python / desktop) ---
# Each step reads its own inputs and writes to a disjoint output path, so they
# can run concurrently. Logs interleave but each line is prefixed.
FRONTEND_HASH=$(sha_of_paths \
    "$WEB_DIR/src" \
    "$WEB_DIR/public" \
    "$WEB_DIR/package.json" \
    "$SCRIPT_DIR/pnpm-lock.yaml" \
    "$WEB_DIR/tsconfig.json" \
    "$WEB_DIR/vite.config.ts" \
    "$WEB_DIR/index.html")

build_frontend() {
    if cache_matches frontend "$FRONTEND_HASH" && [ -f "$WEB_DIR/dist/index.html" ]; then
        echo "[frontend] cache hit, skipping build."
        return 0
    fi
    echo "[frontend] building..."
    (
        cd "$WEB_DIR"
        pnpm install --frozen-lockfile
        pnpm build
    )
    cache_write frontend "$FRONTEND_HASH"
    echo "[frontend] built."
}

build_python() {
    if [ ! -d "$INSTALL_DIR/.venv" ]; then
        echo "[python] creating virtual environment..."
        python3 -m venv "$INSTALL_DIR/.venv"
    fi
    local req_hash
    req_hash=$(sha_of_paths "$SCRIPT_DIR/apps/api/requirements.txt")
    if cache_matches python_deps "$req_hash" && [ -x "$INSTALL_DIR/.venv/bin/pip" ]; then
        echo "[python] cache hit, skipping pip install."
        return 0
    fi
    echo "[python] installing dependencies..."
    "$INSTALL_DIR/.venv/bin/pip" install -q --upgrade pip
    "$INSTALL_DIR/.venv/bin/pip" install -q --upgrade -r "$SCRIPT_DIR/apps/api/requirements.txt"
    cache_write python_deps "$req_hash"
    echo "[python] done."
}

write_desktop_identity_metadata() {
    node - "$INSTALL_DIR/desktop/package.json" "$DESKTOP_ENTRY_NAME" "$DESKTOP_FILE_NAME" <<'NODE'
const fs = require('fs')

const [packagePath, productName, desktopName] = process.argv.slice(2)
const payload = JSON.parse(fs.readFileSync(packagePath, 'utf8'))
payload.productName = productName
payload.desktopName = desktopName
fs.writeFileSync(packagePath, `${JSON.stringify(payload, null, 2)}\n`)
NODE
}

build_desktop() {
    if [ ! -f "$DESKTOP_SOURCE_DIR/package.json" ]; then
        echo "Error: missing desktop shell package.json at $DESKTOP_SOURCE_DIR/package.json." >&2
        return 1
    fi
    local pkg_hash
    pkg_hash=$(sha_of_paths "$DESKTOP_SOURCE_DIR/package.json")
    if cache_matches desktop_deps "$pkg_hash" \
        && [ -d "$INSTALL_DIR/desktop/node_modules/electron/dist" ]; then
        echo "[desktop] cache hit, refreshing source files only."
        # Preserve node_modules; replace only source files.
        if [ -d "$INSTALL_DIR/desktop/node_modules" ]; then
            mv "$INSTALL_DIR/desktop/node_modules" "$INSTALL_DIR/.desktop-node_modules.tmp"
        fi
        rm -rf "$INSTALL_DIR/desktop"
        cp -r "$DESKTOP_SOURCE_DIR" "$INSTALL_DIR/desktop"
        if [ -d "$INSTALL_DIR/.desktop-node_modules.tmp" ]; then
            rm -rf "$INSTALL_DIR/desktop/node_modules"
            mv "$INSTALL_DIR/.desktop-node_modules.tmp" "$INSTALL_DIR/desktop/node_modules"
        fi
        write_desktop_identity_metadata
        return 0
    fi
    echo "[desktop] installing electron + source..."
    rm -rf "$INSTALL_DIR/desktop"
    cp -r "$DESKTOP_SOURCE_DIR" "$INSTALL_DIR/desktop"
    write_desktop_identity_metadata
    local electron_spec
    electron_spec="$(node -p "require('$DESKTOP_SOURCE_DIR/package.json').dependencies.electron")"
    (
        cd "$INSTALL_DIR/desktop"
        npm install --no-fund --no-audit "electron@${electron_spec#^}"
    )
    cache_write desktop_deps "$pkg_hash"
    echo "[desktop] done."
}

echo "Starting parallel builds (frontend + python + desktop)..."
PIDS=()
( build_frontend ) & PIDS+=($!)
( build_python )   & PIDS+=($!)
( build_desktop )  & PIDS+=($!)

BUILD_FAIL=0
for pid in "${PIDS[@]}"; do
    if ! wait "$pid"; then
        BUILD_FAIL=1
    fi
done
if [ $BUILD_FAIL -ne 0 ]; then
    echo "One or more parallel build steps failed." >&2
    exit 1
fi

if [ "$INSTALL_CLAUDE_CHANNEL_SPIKE" = "1" ] && [ -f "$CLAUDE_CHANNEL_BOOTSTRAP_SOURCE" ]; then
    if command -v claude >/dev/null 2>&1; then
        echo "Bootstrapping Claude channel spike..."
        PIXEL_FORGE_SHARED_STATE_DIR="$SHARED_STATE_DIR" \
        PIXEL_FORGE_CLAUDE_CHANNEL_ENV_FILE="$CLAUDE_CHANNEL_ENV_FILE" \
        bash "$CLAUDE_CHANNEL_BOOTSTRAP_SOURCE"
    else
        echo "Skipping Claude channel spike bootstrap: 'claude' CLI not on PATH."
        echo "Install Claude Code (npm i -g @anthropic-ai/claude-code), then re-run this install script to wire up the pixel-forge-channel plugin."
    fi
fi

if [ "$INSTALL_CODEX_CHANNEL" = "1" ] && [ -f "$CODEX_CHANNEL_BOOTSTRAP_SOURCE" ]; then
    if command -v codex >/dev/null 2>&1; then
        echo "Bootstrapping Codex MCP channel..."
        PIXEL_FORGE_SHARED_STATE_DIR="$SHARED_STATE_DIR" \
        PIXEL_FORGE_CODEX_CHANNEL_ENV_FILE="$CODEX_CHANNEL_ENV_FILE" \
        bash "$CODEX_CHANNEL_BOOTSTRAP_SOURCE"
    else
        echo "Skipping Codex MCP channel bootstrap: 'codex' CLI not on PATH."
        echo "Install Codex (npm i -g @openai/codex), then re-run this install script to wire up the pixel-forge-channel MCP server."
    fi
fi

# --- Bundle built frontend into install dir ---
if [ ! -f "$WEB_DIR/dist/index.html" ]; then
    echo "Error: missing apps/web/dist/index.html after build." >&2
    exit 1
fi
echo "Bundling built frontend..."
rm -rf "$INSTALL_DIR/frontend"
cp -r "$WEB_DIR/dist" "$INSTALL_DIR/frontend"

# --- Launcher script ---
cat > "$BIN_DIR/${CLI_NAME}" <<LAUNCHER
#!/bin/bash

set -euo pipefail

$RETIRED_LANE_ENV_STRIP_SNIPPET

LAUNCHER_DIR="\$(cd "\$(dirname "\${BASH_SOURCE[0]}")" && pwd)"
INSTALL_NAME="\${PIXEL_FORGE_INSTALL_NAME:-$INSTALL_NAME}"
INSTANCE_SLUG="\${PIXEL_FORGE_INSTANCE_SLUG:-$INSTANCE_SLUG}"
INSTALL_DIR="\${PIXEL_FORGE_INSTALL_DIR:-$INSTALL_DIR}"
BACKUP_DIR="\${PIXEL_FORGE_BACKUP_DIR:-$BACKUP_DIR}"
CLI_NAME="\${PIXEL_FORGE_CLI_NAME:-$CLI_NAME}"
SHELL_NAME="\${PIXEL_FORGE_SHELL_NAME:-$SHELL_NAME}"
SERVICE_NAME="\${PIXEL_FORGE_SERVICE_NAME:-$SERVICE_NAME}"
PORT="\${PIXEL_FORGE_PORT:-$PORT}"
API_PORT="\${PIXEL_FORGE_API_PORT:-$API_PORT}"
URL_HOST="\${PIXEL_FORGE_URL_HOST:-$URL_HOST}"
WEB_HOST="\${PIXEL_FORGE_WEB_HOST:-$WEB_HOST}"
SHELL_URL="\${PIXEL_FORGE_SHELL_URL:-$SHELL_URL}"
PREVIEW_PARTITION="\${PIXEL_FORGE_PREVIEW_PARTITION:-$PREVIEW_PARTITION}"
SHARED_STATE_DIR="\${PIXEL_FORGE_SHARED_STATE_DIR:-$SHARED_STATE_DIR}"
LEGACY_SHARED_STATE_DIR="\${PIXEL_FORGE_LEGACY_SHARED_STATE_DIR:-$LEGACY_SHARED_STATE_DIR}"
RUNTIME_DIR="\${PIXEL_FORGE_RUNTIME_DIR:-\${SHARED_STATE_DIR}/runtime}"
PIXEL_FORGE_DB_PATH="\${PIXEL_FORGE_DB_PATH:-$DB_PATH}"
PIXEL_FORGE_AGENT_DECK_PROFILE="\${PIXEL_FORGE_AGENT_DECK_PROFILE:-$AGENT_DECK_PROFILE}"
PIXEL_FORGE_AGENT_DECK_HOME="\${PIXEL_FORGE_AGENT_DECK_HOME:-$AGENT_DECK_HOME}"
PIXEL_FORGE_AGENT_DECK_SURFACE_HOST="\${PIXEL_FORGE_AGENT_DECK_SURFACE_HOST:-$AGENT_DECK_SURFACE_HOST}"
PIXEL_FORGE_AGENT_DECK_SURFACE_PORT="\${PIXEL_FORGE_AGENT_DECK_SURFACE_PORT:-$AGENT_DECK_SURFACE_PORT}"
PIXEL_FORGE_AGENT_DECK_SURFACE_URL="\${PIXEL_FORGE_AGENT_DECK_SURFACE_URL:-$AGENT_DECK_SURFACE_URL}"
PIXEL_FORGE_AGENT_DECK_FOUNDATION_ROOT="\${PIXEL_FORGE_AGENT_DECK_FOUNDATION_ROOT:-$AGENT_DECK_FOUNDATION_INSTALL_DIR}"
PIXEL_FORGE_AGENT_DECK_CMD="\${PIXEL_FORGE_AGENT_DECK_CMD:-$AGENT_DECK_CMD_DEFAULT}"
PIXEL_FORGE_STATE_ROOT_MIGRATION_HELPER="\${PIXEL_FORGE_STATE_ROOT_MIGRATION_HELPER:-$STATE_ROOT_MIGRATION_HELPER_INSTALL_PATH}"
export PIXEL_FORGE_BIN_DIR="\${PIXEL_FORGE_BIN_DIR:-\$LAUNCHER_DIR}"
export PIXEL_FORGE_SKILLS_INSTALL_DIR="\${PIXEL_FORGE_SKILLS_INSTALL_DIR:-$SKILLS_INSTALL_DIR}"
export PIXEL_FORGE_INSTANCE_SLUG="\$INSTANCE_SLUG"
export PIXEL_FORGE_INSTALL_NAME="\$INSTALL_NAME"
export PIXEL_FORGE_CLI_NAME="\$CLI_NAME"
export PIXEL_FORGE_SHELL_NAME="\$SHELL_NAME"
export PIXEL_FORGE_SERVICE_NAME="\$SERVICE_NAME"
export PIXEL_FORGE_INSTALL_DIR="\$INSTALL_DIR"
export PIXEL_FORGE_BACKUP_DIR="\$BACKUP_DIR"
export PIXEL_FORGE_PORT="\$PORT"
export PIXEL_FORGE_API_PORT="\$API_PORT"
export PIXEL_FORGE_URL_HOST="\$URL_HOST"
export PIXEL_FORGE_WEB_HOST="\$WEB_HOST"
export PIXEL_FORGE_SHELL_URL="\$SHELL_URL"
export PIXEL_FORGE_PREVIEW_PARTITION="\$PREVIEW_PARTITION"
export PIXEL_FORGE_SHARED_STATE_DIR="\$SHARED_STATE_DIR"
export PIXEL_FORGE_LEGACY_SHARED_STATE_DIR="\$LEGACY_SHARED_STATE_DIR"
export PIXEL_FORGE_RUNTIME_DIR="\$RUNTIME_DIR"
export PIXEL_FORGE_DB_PATH
export PIXEL_FORGE_AGENT_DECK_PROFILE
export PIXEL_FORGE_AGENT_DECK_HOME
export PIXEL_FORGE_AGENT_DECK_SURFACE_HOST
export PIXEL_FORGE_AGENT_DECK_SURFACE_PORT
export PIXEL_FORGE_AGENT_DECK_SURFACE_URL
export PIXEL_FORGE_AGENT_DECK_FOUNDATION_ROOT
export PIXEL_FORGE_AGENT_DECK_CMD
export PIXEL_FORGE_STATE_ROOT_MIGRATION_HELPER
export AGENTDECK_PROFILE="\${AGENTDECK_PROFILE:-\$PIXEL_FORGE_AGENT_DECK_PROFILE}"
export AGENTDECK_DIR="\${AGENTDECK_DIR:-\$PIXEL_FORGE_AGENT_DECK_HOME}"
export AGENT_DECK_DIR="\${AGENT_DECK_DIR:-\$PIXEL_FORGE_AGENT_DECK_HOME}"

PYTHON_BIN="\$INSTALL_DIR/.venv/bin/python"
if [ ! -x "\$PYTHON_BIN" ]; then
    PYTHON_BIN="\$(command -v python3)"
fi
if [ -f "\$PIXEL_FORGE_STATE_ROOT_MIGRATION_HELPER" ]; then
    "\$PYTHON_BIN" "\$PIXEL_FORGE_STATE_ROOT_MIGRATION_HELPER" >/dev/null
fi

mkdir -p "\$RUNTIME_DIR"
mkdir -p "\$PIXEL_FORGE_AGENT_DECK_HOME"

exec "\$INSTALL_DIR/.venv/bin/python" "\$INSTALL_DIR/pixel_forge_cli.py" "\$@"
LAUNCHER

chmod +x "$BIN_DIR/${CLI_NAME}"

cat > "$BIN_DIR/${AGENT_DECK_TUI_LAUNCHER_NAME}" <<TUI
#!/bin/bash

set -euo pipefail

$RETIRED_LANE_ENV_STRIP_SNIPPET

LAUNCHER_DIR="\$(cd "\$(dirname "\${BASH_SOURCE[0]}")" && pwd)"
CLI_NAME="\${PIXEL_FORGE_CLI_NAME:-$CLI_NAME}"
INSTALL_DIR="\${PIXEL_FORGE_INSTALL_DIR:-$INSTALL_DIR}"
SHARED_STATE_DIR="\${PIXEL_FORGE_SHARED_STATE_DIR:-$SHARED_STATE_DIR}"
LEGACY_SHARED_STATE_DIR="\${PIXEL_FORGE_LEGACY_SHARED_STATE_DIR:-$LEGACY_SHARED_STATE_DIR}"
PIXEL_FORGE_DB_PATH="\${PIXEL_FORGE_DB_PATH:-$DB_PATH}"
PIXEL_FORGE_AGENT_DECK_PROFILE="\${PIXEL_FORGE_AGENT_DECK_PROFILE:-$AGENT_DECK_PROFILE}"
PIXEL_FORGE_AGENT_DECK_HOME="\${PIXEL_FORGE_AGENT_DECK_HOME:-$AGENT_DECK_HOME}"
PIXEL_FORGE_AGENT_DECK_FOUNDATION_ROOT="\${PIXEL_FORGE_AGENT_DECK_FOUNDATION_ROOT:-$AGENT_DECK_FOUNDATION_INSTALL_DIR}"
PIXEL_FORGE_AGENT_DECK_CMD="\${PIXEL_FORGE_AGENT_DECK_CMD:-$AGENT_DECK_CMD_DEFAULT}"
PIXEL_FORGE_STATE_ROOT_MIGRATION_HELPER="\${PIXEL_FORGE_STATE_ROOT_MIGRATION_HELPER:-$STATE_ROOT_MIGRATION_HELPER_INSTALL_PATH}"
PIXEL_FORGE_AGENT_DECK_TUI_TITLE="\${PIXEL_FORGE_AGENT_DECK_TUI_TITLE:-$AGENT_DECK_TUI_TITLE}"
PIXEL_FORGE_AGENT_DECK_TUI_WM_CLASS="\${PIXEL_FORGE_AGENT_DECK_TUI_WM_CLASS:-$AGENT_DECK_TUI_WM_CLASS}"
export PIXEL_FORGE_INSTALL_DIR="\$INSTALL_DIR"
export PIXEL_FORGE_SHARED_STATE_DIR="\$SHARED_STATE_DIR"
export PIXEL_FORGE_LEGACY_SHARED_STATE_DIR="\$LEGACY_SHARED_STATE_DIR"
export PIXEL_FORGE_DB_PATH
export PIXEL_FORGE_AGENT_DECK_PROFILE
export PIXEL_FORGE_AGENT_DECK_HOME
export PIXEL_FORGE_AGENT_DECK_FOUNDATION_ROOT
export PIXEL_FORGE_AGENT_DECK_CMD
export PIXEL_FORGE_STATE_ROOT_MIGRATION_HELPER
export PIXEL_FORGE_AGENT_DECK_TUI_TITLE
export PIXEL_FORGE_AGENT_DECK_TUI_WM_CLASS
export AGENTDECK_PROFILE="\${AGENTDECK_PROFILE:-\$PIXEL_FORGE_AGENT_DECK_PROFILE}"
export AGENTDECK_DIR="\${AGENTDECK_DIR:-\$PIXEL_FORGE_AGENT_DECK_HOME}"
export AGENT_DECK_DIR="\${AGENT_DECK_DIR:-\$PIXEL_FORGE_AGENT_DECK_HOME}"

if [[ "\${1:-}" == "run" ]]; then
    shift
    exec "\$PIXEL_FORGE_AGENT_DECK_CMD" "\$@"
fi

exec "\$LAUNCHER_DIR/\$CLI_NAME" agent-deck-tui open "\$@"
TUI

chmod +x "$BIN_DIR/${AGENT_DECK_TUI_LAUNCHER_NAME}"

cat > "$BIN_DIR/${SHELL_NAME}" <<SHELL
#!/bin/bash

set -euo pipefail

$RETIRED_LANE_ENV_STRIP_SNIPPET

LAUNCHER_DIR="\$(cd "\$(dirname "\${BASH_SOURCE[0]}")" && pwd)"
INSTALL_NAME="\${PIXEL_FORGE_INSTALL_NAME:-$INSTALL_NAME}"
INSTANCE_SLUG="\${PIXEL_FORGE_INSTANCE_SLUG:-$INSTANCE_SLUG}"
INSTALL_DIR="\${PIXEL_FORGE_INSTALL_DIR:-$INSTALL_DIR}"
BACKUP_DIR="\${PIXEL_FORGE_BACKUP_DIR:-$BACKUP_DIR}"
CLI_NAME="\${PIXEL_FORGE_CLI_NAME:-$CLI_NAME}"
SHELL_NAME="\${PIXEL_FORGE_SHELL_NAME:-$SHELL_NAME}"
DESKTOP_ENTRY_NAME="\${PIXEL_FORGE_DESKTOP_ENTRY_NAME:-$DESKTOP_ENTRY_NAME}"
DESKTOP_FILE_NAME="\${PIXEL_FORGE_DESKTOP_FILE_NAME:-$DESKTOP_FILE_NAME}"
DESKTOP_WM_CLASS="\${PIXEL_FORGE_DESKTOP_WM_CLASS:-$DESKTOP_WM_CLASS}"
DESKTOP_ICON_PATH="\${PIXEL_FORGE_DESKTOP_ICON_PATH:-\$INSTALL_DIR/frontend/favicon/app.png}"
SERVICE="\${PIXEL_FORGE_SERVICE_NAME:-$SERVICE_NAME}"
PORT="\${PIXEL_FORGE_PORT:-$PORT}"
API_PORT="\${PIXEL_FORGE_API_PORT:-$API_PORT}"
URL_HOST="\${PIXEL_FORGE_URL_HOST:-$URL_HOST}"
WEB_HOST="\${PIXEL_FORGE_WEB_HOST:-$WEB_HOST}"
PREVIEW_PARTITION="\${PIXEL_FORGE_PREVIEW_PARTITION:-$PREVIEW_PARTITION}"
URL="\${PIXEL_FORGE_SHELL_URL:-$SHELL_URL}"
SHARED_STATE_DIR="\${PIXEL_FORGE_SHARED_STATE_DIR:-$SHARED_STATE_DIR}"
LEGACY_SHARED_STATE_DIR="\${PIXEL_FORGE_LEGACY_SHARED_STATE_DIR:-$LEGACY_SHARED_STATE_DIR}"
RUNTIME_DIR="\${PIXEL_FORGE_RUNTIME_DIR:-\${SHARED_STATE_DIR}/runtime}"
PIXEL_FORGE_DB_PATH="\${PIXEL_FORGE_DB_PATH:-$DB_PATH}"
PIXEL_FORGE_AGENT_DECK_PROFILE="\${PIXEL_FORGE_AGENT_DECK_PROFILE:-$AGENT_DECK_PROFILE}"
PIXEL_FORGE_AGENT_DECK_HOME="\${PIXEL_FORGE_AGENT_DECK_HOME:-$AGENT_DECK_HOME}"
PIXEL_FORGE_AGENT_DECK_SURFACE_HOST="\${PIXEL_FORGE_AGENT_DECK_SURFACE_HOST:-$AGENT_DECK_SURFACE_HOST}"
PIXEL_FORGE_AGENT_DECK_SURFACE_PORT="\${PIXEL_FORGE_AGENT_DECK_SURFACE_PORT:-$AGENT_DECK_SURFACE_PORT}"
PIXEL_FORGE_AGENT_DECK_SURFACE_URL="\${PIXEL_FORGE_AGENT_DECK_SURFACE_URL:-$AGENT_DECK_SURFACE_URL}"
PIXEL_FORGE_AGENT_DECK_FOUNDATION_ROOT="\${PIXEL_FORGE_AGENT_DECK_FOUNDATION_ROOT:-$AGENT_DECK_FOUNDATION_INSTALL_DIR}"
PIXEL_FORGE_AGENT_DECK_CMD="\${PIXEL_FORGE_AGENT_DECK_CMD:-$AGENT_DECK_CMD_DEFAULT}"
PIXEL_FORGE_STATE_ROOT_MIGRATION_HELPER="\${PIXEL_FORGE_STATE_ROOT_MIGRATION_HELPER:-$STATE_ROOT_MIGRATION_HELPER_INSTALL_PATH}"
ELECTRON_BIN="\$INSTALL_DIR/desktop/node_modules/electron/dist/electron"
if [ ! -x "\$ELECTRON_BIN" ]; then
    ELECTRON_BIN="\$INSTALL_DIR/node_modules/electron/dist/electron"
fi

export PIXEL_FORGE_INSTALL_NAME="\$INSTALL_NAME"
export PIXEL_FORGE_INSTANCE_SLUG="\$INSTANCE_SLUG"
export PIXEL_FORGE_INSTALL_DIR="\$INSTALL_DIR"
export PIXEL_FORGE_BACKUP_DIR="\$BACKUP_DIR"
export PIXEL_FORGE_CLI_NAME="\$CLI_NAME"
export PIXEL_FORGE_SHELL_NAME="\$SHELL_NAME"
export PIXEL_FORGE_DESKTOP_ENTRY_NAME="\$DESKTOP_ENTRY_NAME"
export PIXEL_FORGE_DESKTOP_FILE_NAME="\$DESKTOP_FILE_NAME"
export PIXEL_FORGE_DESKTOP_WM_CLASS="\$DESKTOP_WM_CLASS"
export PIXEL_FORGE_DESKTOP_ICON_PATH="\$DESKTOP_ICON_PATH"
export PIXEL_FORGE_BIN_DIR="\$LAUNCHER_DIR"
export PIXEL_FORGE_SERVICE_NAME="\$SERVICE"
export PIXEL_FORGE_PORT="\$PORT"
export PIXEL_FORGE_API_PORT="\$API_PORT"
export PIXEL_FORGE_URL_HOST="\$URL_HOST"
export PIXEL_FORGE_WEB_HOST="\$WEB_HOST"
export PIXEL_FORGE_SHELL_URL="\$URL"
export PIXEL_FORGE_PREVIEW_PARTITION="\$PREVIEW_PARTITION"
export PIXEL_FORGE_SHARED_STATE_DIR="\$SHARED_STATE_DIR"
export PIXEL_FORGE_LEGACY_SHARED_STATE_DIR="\$LEGACY_SHARED_STATE_DIR"
export PIXEL_FORGE_RUNTIME_DIR="\$RUNTIME_DIR"
export PIXEL_FORGE_DB_PATH
export PIXEL_FORGE_SKILLS_INSTALL_DIR="\${PIXEL_FORGE_SKILLS_INSTALL_DIR:-$SKILLS_INSTALL_DIR}"
export PIXEL_FORGE_AGENT_DECK_PROFILE
export PIXEL_FORGE_AGENT_DECK_HOME
export PIXEL_FORGE_AGENT_DECK_SURFACE_HOST
export PIXEL_FORGE_AGENT_DECK_SURFACE_PORT
export PIXEL_FORGE_AGENT_DECK_SURFACE_URL
export PIXEL_FORGE_AGENT_DECK_FOUNDATION_ROOT
export PIXEL_FORGE_AGENT_DECK_CMD
export PIXEL_FORGE_STATE_ROOT_MIGRATION_HELPER
export AGENTDECK_PROFILE="\${AGENTDECK_PROFILE:-\$PIXEL_FORGE_AGENT_DECK_PROFILE}"
export AGENTDECK_DIR="\${AGENTDECK_DIR:-\$PIXEL_FORGE_AGENT_DECK_HOME}"
export AGENT_DECK_DIR="\${AGENT_DECK_DIR:-\$PIXEL_FORGE_AGENT_DECK_HOME}"

PYTHON_BIN="\$INSTALL_DIR/.venv/bin/python"
if [ ! -x "\$PYTHON_BIN" ]; then
    PYTHON_BIN="\$(command -v python3)"
fi
if [ -f "\$PIXEL_FORGE_STATE_ROOT_MIGRATION_HELPER" ]; then
    "\$PYTHON_BIN" "\$PIXEL_FORGE_STATE_ROOT_MIGRATION_HELPER" >/dev/null
fi

"\$LAUNCHER_DIR/\$CLI_NAME" start >/dev/null

RUNTIME_INFO_URL="\${URL%/}/api/runtime-info"
for _ in \$(seq 1 30); do
    if curl -fsS "\$RUNTIME_INFO_URL" >/dev/null 2>&1; then
        break
    fi
    sleep 1
done
if ! curl -fsS "\$RUNTIME_INFO_URL" >/dev/null 2>&1; then
    echo "Pixel Forge API did not become ready at \$RUNTIME_INFO_URL" >&2
    exit 1
fi

if [ ! -x "\$ELECTRON_BIN" ]; then
    echo "Pixel Forge desktop shell is not installed. Re-run ./install.sh"
    exit 1
fi

export PIXEL_FORGE_SHELL_URL="\$URL"
exec "\$ELECTRON_BIN" --no-sandbox "--class=\$PIXEL_FORGE_DESKTOP_WM_CLASS" "\$INSTALL_DIR/desktop" "\$@"
SHELL

chmod +x "$BIN_DIR/${SHELL_NAME}"

# --- Systemd user service ---
if [ "$SKIP_SYSTEMD" = "1" ]; then
    echo "Skipping systemd user service installation (PIXEL_FORGE_INSTALL_SKIP_SYSTEMD=1)."
elif command -v systemctl >/dev/null 2>&1; then
    mkdir -p "$SYSTEMD_DIR"
    cat > "$SYSTEMD_DIR/${SERVICE_NAME}.service" << UNIT
[Unit]
Description=Pixel Forge - Visual App Editor
After=network.target

[Service]
Type=simple
WorkingDirectory=$INSTALL_DIR
ExecStart=$INSTALL_DIR/.venv/bin/uvicorn main:app --host 0.0.0.0 --port $PORT
Restart=on-failure
RestartSec=3
KillMode=mixed
TimeoutStopSec=8
Environment=PATH=$HOME/.local/bin:/usr/local/bin:/usr/bin:/bin
Environment=PIXEL_FORGE_INSTANCE_SLUG=$INSTANCE_SLUG
Environment=PIXEL_FORGE_INSTALL_NAME=$INSTALL_NAME
Environment=PIXEL_FORGE_CLI_NAME=$CLI_NAME
Environment=PIXEL_FORGE_SHELL_NAME=$SHELL_NAME
Environment=PIXEL_FORGE_SERVICE_NAME=$SERVICE_NAME
Environment=PIXEL_FORGE_PORT=$PORT
Environment=PIXEL_FORGE_API_PORT=$API_PORT
Environment=PIXEL_FORGE_URL_HOST=$URL_HOST
Environment=PIXEL_FORGE_WEB_HOST=$WEB_HOST
Environment=PIXEL_FORGE_SHELL_URL=$SHELL_URL
Environment=PIXEL_FORGE_PREVIEW_PARTITION=$PREVIEW_PARTITION
Environment=PIXEL_FORGE_SHARED_STATE_DIR=$SHARED_STATE_DIR
Environment=PIXEL_FORGE_LEGACY_SHARED_STATE_DIR=$LEGACY_SHARED_STATE_DIR
Environment=PIXEL_FORGE_DB_PATH=$DB_PATH
Environment=PIXEL_FORGE_SKILLS_INSTALL_DIR=$SKILLS_INSTALL_DIR
Environment=PIXEL_FORGE_AGENT_DECK_PROFILE=$AGENT_DECK_PROFILE
Environment=PIXEL_FORGE_AGENT_DECK_HOME=$AGENT_DECK_HOME
Environment=PIXEL_FORGE_AGENT_DECK_SURFACE_HOST=$AGENT_DECK_SURFACE_HOST
Environment=PIXEL_FORGE_AGENT_DECK_SURFACE_PORT=$AGENT_DECK_SURFACE_PORT
Environment=PIXEL_FORGE_AGENT_DECK_SURFACE_URL=$AGENT_DECK_SURFACE_URL
Environment=PIXEL_FORGE_AGENT_DECK_FOUNDATION_ROOT=$AGENT_DECK_FOUNDATION_INSTALL_DIR
Environment=PIXEL_FORGE_AGENT_DECK_CMD=$AGENT_DECK_CMD_DEFAULT
Environment=PIXEL_FORGE_STATE_ROOT_MIGRATION_HELPER=$STATE_ROOT_MIGRATION_HELPER_INSTALL_PATH
Environment=AGENTDECK_PROFILE=$AGENT_DECK_PROFILE
Environment=AGENTDECK_DIR=$AGENT_DECK_HOME
Environment=AGENT_DECK_DIR=$AGENT_DECK_HOME

[Install]
WantedBy=default.target
UNIT

    systemctl --user daemon-reload
    systemctl --user enable "${SERVICE_NAME}.service" 2>/dev/null || true
    if systemctl --user is-active --quiet "${SERVICE_NAME}.service"; then
        systemctl --user restart "${SERVICE_NAME}.service"
        echo "Systemd service restarted."
    else
        if systemctl --user start "${SERVICE_NAME}.service" 2>/dev/null; then
            echo "Systemd service started."
        else
            echo "Systemd service was not running; start attempt failed." >&2
        fi
    fi
    echo "Systemd service installed and enabled."
else
    echo "systemctl not found; the launcher will use the non-systemd background fallback."
fi

# --- Desktop integration ---
if [ "$SKIP_DESKTOP_INTEGRATION" = "1" ]; then
    echo "Skipping desktop integration (PIXEL_FORGE_INSTALL_SKIP_DESKTOP_INTEGRATION=1)."
else
    ICON_DIR="$HOME/.local/share/icons/hicolor/256x256/apps"
    mkdir -p "$ICON_DIR"
    if [ ! -f "$DESKTOP_ICON_SOURCE" ]; then
        echo "Error: desktop icon source missing at $DESKTOP_ICON_SOURCE" >&2
        exit 1
    fi
    cp "$DESKTOP_ICON_SOURCE" "$ICON_DIR/${DESKTOP_ICON_NAME}.png"
    if [ ! -f "$AGENT_DECK_TUI_ICON_SOURCE" ]; then
        echo "Error: Agent Deck icon source missing at $AGENT_DECK_TUI_ICON_SOURCE" >&2
        exit 1
    fi
    cp "$AGENT_DECK_TUI_ICON_SOURCE" "$ICON_DIR/${AGENT_DECK_TUI_ICON_NAME}.png"

    DESKTOP_DIR="$HOME/.local/share/applications"
    mkdir -p "$DESKTOP_DIR"

    cat > "$DESKTOP_DIR/${DESKTOP_FILE_NAME}" << DESKTOP
[Desktop Entry]
Name=${DESKTOP_ENTRY_NAME}
Comment=Visual app editor - screenshot bootstrap and live editing
Exec=bash -lc "exec ${SHELL_NAME}"
Icon=${DESKTOP_ICON_NAME}
Terminal=false
Type=Application
Categories=Development;WebDevelopment;
StartupNotify=true
StartupWMClass=${DESKTOP_WM_CLASS}
DESKTOP

    cat > "$DESKTOP_DIR/${AGENT_DECK_TUI_DESKTOP_FILE_NAME}" << DESKTOP
[Desktop Entry]
Name=${AGENT_DECK_TUI_DESKTOP_ENTRY_NAME}
Comment=Agent Deck terminal app bundled with Pixel Forge
Exec=bash -lc "exec ${AGENT_DECK_TUI_LAUNCHER_NAME}"
Icon=${AGENT_DECK_TUI_ICON_NAME}
Terminal=false
Type=Application
Categories=Development;
Keywords=agent;deck;pixel-forge;terminal;
StartupNotify=true
StartupWMClass=${AGENT_DECK_TUI_WM_CLASS}
DESKTOP

    gtk-update-icon-cache -f -t "$HOME/.local/share/icons/hicolor" 2>/dev/null || true
    update-desktop-database "$DESKTOP_DIR" 2>/dev/null || true
fi

cleanup_legacy_alpha_install
cleanup_legacy_workstation_v2_install
clear_stale_controller_updates

INSTALL_TIMESTAMP="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
cat > "$INSTALL_DIR/runtime-install-metadata.json" <<METADATA
{
  "installedAt": "$INSTALL_TIMESTAMP",
  "skillsInstallDir": "$SKILLS_INSTALL_DIR"
}
METADATA

echo ""
echo "Installation complete!"
echo ""
echo "Usage:"
echo "  ${CLI_NAME} start    # Start the service"
echo "  ${CLI_NAME} run      # Run the service in the foreground"
echo "  ${CLI_NAME} stop     # Stop it"
echo "  ${CLI_NAME} open     # Open the desktop shell"
echo "  ${CLI_NAME} open-web # Open the raw web UI"
echo "  ${CLI_NAME} rollback # Restore the previous installed build"
echo "  ${CLI_NAME} tunnel --project <path> --request <id>"
echo "  ${CLI_NAME} controller-update stage --project \$PWD --git-ref HEAD --summary 'Update ready to load'"
echo "  ${CLI_NAME} controller-update apply"
echo "  ${CLI_NAME} clone promote <session> --into master --commit --push --stage"
echo "  ${CLI_NAME} agent-deck-tui open   # Open Agent Deck in a terminal window"
echo "  ${CLI_NAME} agent-deck-tui run    # Run Agent Deck in the current terminal"
echo "  ${SHELL_NAME}    # Open the desktop shell"
echo "  ${AGENT_DECK_TUI_LAUNCHER_NAME}   # Open Agent Deck"
echo "  ${CLI_NAME} logs     # Tail logs"
echo "  ${CLI_NAME} status   # Check status"
echo ""
echo "Service: ${SERVICE_NAME}   Port: ${PORT}   Install: ${INSTALL_DIR}"
echo ""
echo "For development (hot-reload): ./start-dev.sh"
