#!/bin/bash
# Install Pixel Forge as a self-contained local app.
# FastAPI serves the built React frontend + API; the desktop shell owns preview UX.
# By default this installs a systemd user service, but the launcher also supports
# a pidfile/log based fallback when systemd is unavailable.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
if [ -f "$SCRIPT_DIR/scripts/workstation-v2-env.sh" ]; then
    # shellcheck disable=SC1091
    source "$SCRIPT_DIR/scripts/workstation-v2-env.sh"
fi

INSTALL_NAME="${PIXEL_FORGE_INSTALL_NAME:-pixel-forge}"
CLI_NAME="${PIXEL_FORGE_CLI_NAME:-$INSTALL_NAME}"
SHELL_NAME="${PIXEL_FORGE_SHELL_NAME:-${INSTALL_NAME}-shell}"
INSTALL_DIR="${PIXEL_FORGE_INSTALL_DIR:-$HOME/.local/lib/${INSTALL_NAME}}"
BACKUP_DIR="${PIXEL_FORGE_BACKUP_DIR:-$HOME/.local/lib/${INSTALL_NAME}.rollback}"
BIN_DIR="${PIXEL_FORGE_BIN_DIR:-$HOME/.local/bin}"
WEB_DIR="$SCRIPT_DIR/apps/web"
DESKTOP_SOURCE_DIR="$SCRIPT_DIR/apps/desktop"
AGENT_DECK_FOUNDATION_SOURCE_DIR="$SCRIPT_DIR/foundations/agent-deck"
AGENT_DECK_RUNNER_SOURCE="$SCRIPT_DIR/scripts/agent-deck-workstation-v2.sh"
PORT="${PIXEL_FORGE_PORT:-7001}"
URL_HOST="${PIXEL_FORGE_URL_HOST:-pixel-forge.localhost}"
SERVICE_NAME="${PIXEL_FORGE_SERVICE_NAME:-${INSTALL_NAME}}"
SYSTEMD_DIR="${PIXEL_FORGE_SYSTEMD_DIR:-$HOME/.config/systemd/user}"
SHARED_STATE_DIR="${PIXEL_FORGE_SHARED_STATE_DIR:-$HOME/.pixel-forge}"
SKILLS_INSTALL_DIR="${PIXEL_FORGE_SKILLS_INSTALL_DIR:-${SHARED_STATE_DIR}/skills}"
DB_PATH="${PIXEL_FORGE_DB_PATH:-${SHARED_STATE_DIR}/pixel-forge.db}"
AGENT_DECK_PROFILE="${PIXEL_FORGE_AGENT_DECK_PROFILE:-workstation-v2}"
AGENT_DECK_HOME="${PIXEL_FORGE_AGENT_DECK_HOME:-${SHARED_STATE_DIR}/agent-deck}"
AGENT_DECK_SURFACE_HOST="${PIXEL_FORGE_AGENT_DECK_SURFACE_HOST:-127.0.0.1}"
AGENT_DECK_SURFACE_PORT="${PIXEL_FORGE_AGENT_DECK_SURFACE_PORT:-8422}"
AGENT_DECK_SURFACE_URL="${PIXEL_FORGE_AGENT_DECK_SURFACE_URL:-http://${AGENT_DECK_SURFACE_HOST}:${AGENT_DECK_SURFACE_PORT}}"
AGENT_DECK_FOUNDATION_INSTALL_DIR="$INSTALL_DIR/foundations/agent-deck"
AGENT_DECK_RUNNER_INSTALL_PATH="$INSTALL_DIR/scripts/agent-deck-workstation-v2.sh"
AGENT_DECK_CMD_DEFAULT="$AGENT_DECK_RUNNER_INSTALL_PATH"
SKIP_SYSTEMD="${PIXEL_FORGE_INSTALL_SKIP_SYSTEMD:-0}"
SKIP_DESKTOP_INTEGRATION="${PIXEL_FORGE_INSTALL_SKIP_DESKTOP_INTEGRATION:-0}"
DESKTOP_ENTRY_NAME="${PIXEL_FORGE_DESKTOP_ENTRY_NAME:-Pixel Forge}"
DESKTOP_FILE_NAME="${PIXEL_FORGE_DESKTOP_FILE_NAME:-${INSTALL_NAME}.desktop}"
DESKTOP_ICON_NAME="${PIXEL_FORGE_DESKTOP_ICON_NAME:-${INSTALL_NAME}}"
DESKTOP_ICON_SOURCE="${PIXEL_FORGE_DESKTOP_ICON_SOURCE:-$SCRIPT_DIR/apps/web/public/favicon/alpha.png}"

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

echo "Installing Pixel Forge..."

require_command "python3" "Install Python 3 and re-run ./install.sh."
require_command "pnpm" "Install pnpm and re-run ./install.sh."
require_command "node" "Install Node.js and re-run ./install.sh."
require_command "npm" "Install Node.js/npm and re-run ./install.sh."
require_command "curl" "Install curl and re-run ./install.sh."

# --- Build frontend ---
echo "Building frontend..."
cd "$WEB_DIR"
[ -d "node_modules" ] || pnpm install --frozen-lockfile
pnpm build
echo "Frontend built."

# --- Install backend ---
mkdir -p "$INSTALL_DIR"
mkdir -p "$BIN_DIR"
mkdir -p "$SKILLS_INSTALL_DIR"
mkdir -p "$AGENT_DECK_HOME"

echo "Backing up current install to $BACKUP_DIR..."
backup_install_dir

echo "Copying API to $INSTALL_DIR..."
# Clean old files but preserve .venv.
find "$INSTALL_DIR" -mindepth 1 -maxdepth 1 -not -name '.venv' -exec rm -rf {} + 2>/dev/null || true
cp -r "$SCRIPT_DIR/apps/api/"* "$INSTALL_DIR/"
if [ -f "$SCRIPT_DIR/VERSION" ]; then
    cp "$SCRIPT_DIR/VERSION" "$INSTALL_DIR/VERSION"
fi
if [ -d "$AGENT_DECK_FOUNDATION_SOURCE_DIR" ]; then
    echo "Bundling workstation-v2 Agent Deck foundation..."
    mkdir -p "$INSTALL_DIR/foundations"
    cp -r "$AGENT_DECK_FOUNDATION_SOURCE_DIR" "$AGENT_DECK_FOUNDATION_INSTALL_DIR"
    rm -rf "$AGENT_DECK_FOUNDATION_INSTALL_DIR/build"
fi
if [ -f "$AGENT_DECK_RUNNER_SOURCE" ]; then
    mkdir -p "$INSTALL_DIR/scripts"
    cp "$AGENT_DECK_RUNNER_SOURCE" "$AGENT_DECK_RUNNER_INSTALL_PATH"
    chmod +x "$AGENT_DECK_RUNNER_INSTALL_PATH"
fi

# --- Bundle built frontend ---
if [ ! -f "$WEB_DIR/dist/index.html" ]; then
    echo "Error: missing apps/web/dist/index.html after build." >&2
    exit 1
fi
echo "Bundling built frontend..."
rm -rf "$INSTALL_DIR/frontend"
cp -r "$WEB_DIR/dist" "$INSTALL_DIR/frontend"

# --- Desktop shell ---
if [ ! -f "$DESKTOP_SOURCE_DIR/package.json" ]; then
    echo "Error: missing desktop shell package.json at $DESKTOP_SOURCE_DIR/package.json." >&2
    exit 1
fi

echo "Installing desktop shell..."
rm -rf "$INSTALL_DIR/desktop"
cp -r "$DESKTOP_SOURCE_DIR" "$INSTALL_DIR/desktop"
DESKTOP_ELECTRON_SPEC="$(node -p "require('$DESKTOP_SOURCE_DIR/package.json').dependencies.electron")"
(
    cd "$INSTALL_DIR"
    npm install --no-fund --no-audit "electron@${DESKTOP_ELECTRON_SPEC#^}"
)

# --- Python venv ---
if [ ! -d "$INSTALL_DIR/.venv" ]; then
    echo "Creating virtual environment..."
    python3 -m venv "$INSTALL_DIR/.venv"
fi

echo "Installing Python dependencies..."
"$INSTALL_DIR/.venv/bin/pip" install -q --upgrade pip
"$INSTALL_DIR/.venv/bin/pip" install -q --upgrade -r "$INSTALL_DIR/requirements.txt"

# --- Launcher script ---
cat > "$BIN_DIR/${CLI_NAME}" <<LAUNCHER
#!/bin/bash

set -euo pipefail

LAUNCHER_DIR="\$(cd "\$(dirname "\${BASH_SOURCE[0]}")" && pwd)"
INSTALL_NAME="\${PIXEL_FORGE_INSTALL_NAME:-$INSTALL_NAME}"
INSTALL_DIR="\${PIXEL_FORGE_INSTALL_DIR:-$INSTALL_DIR}"
BACKUP_DIR="\${PIXEL_FORGE_BACKUP_DIR:-$BACKUP_DIR}"
SHARED_STATE_DIR="\${PIXEL_FORGE_SHARED_STATE_DIR:-$SHARED_STATE_DIR}"
RUNTIME_DIR="\${PIXEL_FORGE_RUNTIME_DIR:-\${SHARED_STATE_DIR}/runtime}"
PIXEL_FORGE_DB_PATH="\${PIXEL_FORGE_DB_PATH:-$DB_PATH}"
PIXEL_FORGE_AGENT_DECK_PROFILE="\${PIXEL_FORGE_AGENT_DECK_PROFILE:-$AGENT_DECK_PROFILE}"
PIXEL_FORGE_AGENT_DECK_HOME="\${PIXEL_FORGE_AGENT_DECK_HOME:-$AGENT_DECK_HOME}"
PIXEL_FORGE_AGENT_DECK_SURFACE_HOST="\${PIXEL_FORGE_AGENT_DECK_SURFACE_HOST:-$AGENT_DECK_SURFACE_HOST}"
PIXEL_FORGE_AGENT_DECK_SURFACE_PORT="\${PIXEL_FORGE_AGENT_DECK_SURFACE_PORT:-$AGENT_DECK_SURFACE_PORT}"
PIXEL_FORGE_AGENT_DECK_SURFACE_URL="\${PIXEL_FORGE_AGENT_DECK_SURFACE_URL:-$AGENT_DECK_SURFACE_URL}"
PIXEL_FORGE_AGENT_DECK_FOUNDATION_ROOT="\${PIXEL_FORGE_AGENT_DECK_FOUNDATION_ROOT:-$AGENT_DECK_FOUNDATION_INSTALL_DIR}"
PIXEL_FORGE_AGENT_DECK_CMD="\${PIXEL_FORGE_AGENT_DECK_CMD:-$AGENT_DECK_CMD_DEFAULT}"
export PIXEL_FORGE_BIN_DIR="\${PIXEL_FORGE_BIN_DIR:-\$LAUNCHER_DIR}"
export PIXEL_FORGE_SKILLS_INSTALL_DIR="\${PIXEL_FORGE_SKILLS_INSTALL_DIR:-$SKILLS_INSTALL_DIR}"
export PIXEL_FORGE_INSTALL_NAME="\$INSTALL_NAME"
export PIXEL_FORGE_INSTALL_DIR="\$INSTALL_DIR"
export PIXEL_FORGE_BACKUP_DIR="\$BACKUP_DIR"
export PIXEL_FORGE_SHARED_STATE_DIR="\$SHARED_STATE_DIR"
export PIXEL_FORGE_RUNTIME_DIR="\$RUNTIME_DIR"
export PIXEL_FORGE_DB_PATH
export PIXEL_FORGE_AGENT_DECK_PROFILE
export PIXEL_FORGE_AGENT_DECK_HOME
export PIXEL_FORGE_AGENT_DECK_SURFACE_HOST
export PIXEL_FORGE_AGENT_DECK_SURFACE_PORT
export PIXEL_FORGE_AGENT_DECK_SURFACE_URL
export PIXEL_FORGE_AGENT_DECK_FOUNDATION_ROOT
export PIXEL_FORGE_AGENT_DECK_CMD
export AGENTDECK_PROFILE="\${AGENTDECK_PROFILE:-\$PIXEL_FORGE_AGENT_DECK_PROFILE}"
export AGENTDECK_DIR="\${AGENTDECK_DIR:-\$PIXEL_FORGE_AGENT_DECK_HOME}"
export AGENT_DECK_DIR="\${AGENT_DECK_DIR:-\$PIXEL_FORGE_AGENT_DECK_HOME}"

mkdir -p "\$RUNTIME_DIR"
mkdir -p "\$PIXEL_FORGE_AGENT_DECK_HOME"

exec "\$INSTALL_DIR/.venv/bin/python" "\$INSTALL_DIR/pixel_forge_cli.py" "\$@"
LAUNCHER

chmod +x "$BIN_DIR/${CLI_NAME}"

cat > "$BIN_DIR/${SHELL_NAME}" <<SHELL
#!/bin/bash

set -euo pipefail

LAUNCHER_DIR="\$(cd "\$(dirname "\${BASH_SOURCE[0]}")" && pwd)"
INSTALL_NAME="\${PIXEL_FORGE_INSTALL_NAME:-$INSTALL_NAME}"
INSTALL_DIR="\${PIXEL_FORGE_INSTALL_DIR:-$INSTALL_DIR}"
BACKUP_DIR="\${PIXEL_FORGE_BACKUP_DIR:-$BACKUP_DIR}"
CLI_NAME="\${PIXEL_FORGE_CLI_NAME:-$CLI_NAME}"
SERVICE="\${PIXEL_FORGE_SERVICE_NAME:-$SERVICE_NAME}"
PORT="\${PIXEL_FORGE_PORT:-$PORT}"
URL_HOST="\${PIXEL_FORGE_URL_HOST:-$URL_HOST}"
URL="http://\${URL_HOST}:\${PORT}"
SHARED_STATE_DIR="\${PIXEL_FORGE_SHARED_STATE_DIR:-$SHARED_STATE_DIR}"
RUNTIME_DIR="\${PIXEL_FORGE_RUNTIME_DIR:-\${SHARED_STATE_DIR}/runtime}"
PIXEL_FORGE_DB_PATH="\${PIXEL_FORGE_DB_PATH:-$DB_PATH}"
PIXEL_FORGE_AGENT_DECK_PROFILE="\${PIXEL_FORGE_AGENT_DECK_PROFILE:-$AGENT_DECK_PROFILE}"
PIXEL_FORGE_AGENT_DECK_HOME="\${PIXEL_FORGE_AGENT_DECK_HOME:-$AGENT_DECK_HOME}"
PIXEL_FORGE_AGENT_DECK_SURFACE_HOST="\${PIXEL_FORGE_AGENT_DECK_SURFACE_HOST:-$AGENT_DECK_SURFACE_HOST}"
PIXEL_FORGE_AGENT_DECK_SURFACE_PORT="\${PIXEL_FORGE_AGENT_DECK_SURFACE_PORT:-$AGENT_DECK_SURFACE_PORT}"
PIXEL_FORGE_AGENT_DECK_SURFACE_URL="\${PIXEL_FORGE_AGENT_DECK_SURFACE_URL:-$AGENT_DECK_SURFACE_URL}"
PIXEL_FORGE_AGENT_DECK_FOUNDATION_ROOT="\${PIXEL_FORGE_AGENT_DECK_FOUNDATION_ROOT:-$AGENT_DECK_FOUNDATION_INSTALL_DIR}"
PIXEL_FORGE_AGENT_DECK_CMD="\${PIXEL_FORGE_AGENT_DECK_CMD:-$AGENT_DECK_CMD_DEFAULT}"
ELECTRON_BIN="\$INSTALL_DIR/node_modules/electron/dist/electron"

export PIXEL_FORGE_INSTALL_NAME="\$INSTALL_NAME"
export PIXEL_FORGE_INSTALL_DIR="\$INSTALL_DIR"
export PIXEL_FORGE_BACKUP_DIR="\$BACKUP_DIR"
export PIXEL_FORGE_CLI_NAME="\$CLI_NAME"
export PIXEL_FORGE_BIN_DIR="\$LAUNCHER_DIR"
export PIXEL_FORGE_SERVICE_NAME="\$SERVICE"
export PIXEL_FORGE_PORT="\$PORT"
export PIXEL_FORGE_URL_HOST="\$URL_HOST"
export PIXEL_FORGE_SHARED_STATE_DIR="\$SHARED_STATE_DIR"
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
export AGENTDECK_PROFILE="\${AGENTDECK_PROFILE:-\$PIXEL_FORGE_AGENT_DECK_PROFILE}"
export AGENTDECK_DIR="\${AGENTDECK_DIR:-\$PIXEL_FORGE_AGENT_DECK_HOME}"
export AGENT_DECK_DIR="\${AGENT_DECK_DIR:-\$PIXEL_FORGE_AGENT_DECK_HOME}"

"\$LAUNCHER_DIR/\$CLI_NAME" start >/dev/null 2>&1 || true

for _ in \$(seq 1 30); do
    if curl -fsS "\$URL" >/dev/null 2>&1; then
        break
    fi
    sleep 1
done

if [ ! -x "\$ELECTRON_BIN" ]; then
    echo "Pixel Forge desktop shell is not installed. Re-run ./install.sh"
    exit 1
fi

export PIXEL_FORGE_SHELL_URL="\$URL"
exec "\$ELECTRON_BIN" --no-sandbox "\$INSTALL_DIR/desktop" "\$@"
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
Environment=PIXEL_FORGE_PORT=$PORT
Environment=PIXEL_FORGE_SHARED_STATE_DIR=$SHARED_STATE_DIR
Environment=PIXEL_FORGE_DB_PATH=$DB_PATH
Environment=PIXEL_FORGE_SKILLS_INSTALL_DIR=$SKILLS_INSTALL_DIR
Environment=PIXEL_FORGE_AGENT_DECK_PROFILE=$AGENT_DECK_PROFILE
Environment=PIXEL_FORGE_AGENT_DECK_HOME=$AGENT_DECK_HOME
Environment=PIXEL_FORGE_AGENT_DECK_SURFACE_HOST=$AGENT_DECK_SURFACE_HOST
Environment=PIXEL_FORGE_AGENT_DECK_SURFACE_PORT=$AGENT_DECK_SURFACE_PORT
Environment=PIXEL_FORGE_AGENT_DECK_SURFACE_URL=$AGENT_DECK_SURFACE_URL
Environment=PIXEL_FORGE_AGENT_DECK_FOUNDATION_ROOT=$AGENT_DECK_FOUNDATION_INSTALL_DIR
Environment=PIXEL_FORGE_AGENT_DECK_CMD=$AGENT_DECK_CMD_DEFAULT
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

    DESKTOP_DIR="$HOME/.local/share/applications"
    mkdir -p "$DESKTOP_DIR"

    cat > "$DESKTOP_DIR/${DESKTOP_FILE_NAME}" << DESKTOP
[Desktop Entry]
Name=${DESKTOP_ENTRY_NAME}
Comment=Visual app editor - screenshot bootstrap and live editing
Exec=bash -lc 'exec ${SHELL_NAME}'
Icon=${DESKTOP_ICON_NAME}
Terminal=false
Type=Application
Categories=Development;WebDevelopment;
StartupNotify=true
StartupWMClass=pixel-forge-desktop
DESKTOP

    gtk-update-icon-cache -f -t "$HOME/.local/share/icons/hicolor" 2>/dev/null || true
    update-desktop-database "$DESKTOP_DIR" 2>/dev/null || true
fi

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
echo "  pixel-forge start    # Start the service"
echo "  pixel-forge run      # Run the service in the foreground"
echo "  pixel-forge stop     # Stop it"
echo "  pixel-forge open     # Open the desktop shell"
echo "  pixel-forge open-web # Open the raw web UI"
echo "  pixel-forge rollback # Restore the previous installed build"
echo "  pixel-forge tunnel --project <path> --request <id>"
echo "  pixel-forge controller-update stage --project \$PWD --git-ref HEAD --summary 'Update ready to load'"
echo "  pixel-forge controller-update apply"
echo "  pixel-forge clone promote <session> --into master --commit --push --stage"
echo "  ${SHELL_NAME}    # Open the desktop shell"
echo "  pixel-forge logs     # Tail logs"
echo "  pixel-forge status   # Check status"
echo ""
echo "Service: ${SERVICE_NAME}   Port: ${PORT}   Install: ${INSTALL_DIR}"
echo ""
echo "For development (hot-reload): ./start-dev.sh"
