#!/bin/bash
# Install Pixel Forge as a self-contained local app.
# FastAPI serves the built React frontend + API; the desktop shell owns preview UX.
# By default this installs a systemd user service, but the launcher also supports
# a pidfile/log based fallback when systemd is unavailable.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

INSTALL_NAME="${PIXEL_FORGE_INSTALL_NAME:-pixel-forge}"
INSTALL_DIR="${PIXEL_FORGE_INSTALL_DIR:-$HOME/.local/lib/${INSTALL_NAME}}"
BACKUP_DIR="${PIXEL_FORGE_BACKUP_DIR:-$HOME/.local/lib/${INSTALL_NAME}.rollback}"
BIN_DIR="${PIXEL_FORGE_BIN_DIR:-$HOME/.local/bin}"
WEB_DIR="$SCRIPT_DIR/apps/web"
DESKTOP_SOURCE_DIR="$SCRIPT_DIR/apps/desktop"
PORT="${PIXEL_FORGE_PORT:-7001}"
URL_HOST="${PIXEL_FORGE_URL_HOST:-pixel-forge.localhost}"
SERVICE_NAME="${PIXEL_FORGE_SERVICE_NAME:-${INSTALL_NAME}}"
SYSTEMD_DIR="${PIXEL_FORGE_SYSTEMD_DIR:-$HOME/.config/systemd/user}"
SHARED_STATE_DIR="${PIXEL_FORGE_SHARED_STATE_DIR:-$HOME/.pixel-forge}"
SKIP_SYSTEMD="${PIXEL_FORGE_INSTALL_SKIP_SYSTEMD:-0}"
SKIP_DESKTOP_INTEGRATION="${PIXEL_FORGE_INSTALL_SKIP_DESKTOP_INTEGRATION:-0}"

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

echo "Backing up current install to $BACKUP_DIR..."
backup_install_dir

echo "Copying API to $INSTALL_DIR..."
# Clean old files but preserve .venv.
find "$INSTALL_DIR" -mindepth 1 -maxdepth 1 -not -name '.venv' -exec rm -rf {} + 2>/dev/null || true
cp -r "$SCRIPT_DIR/apps/api/"* "$INSTALL_DIR/"
if [ -f "$SCRIPT_DIR/VERSION" ]; then
    cp "$SCRIPT_DIR/VERSION" "$INSTALL_DIR/VERSION"
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
cat > "$BIN_DIR/pixel-forge" << 'LAUNCHER'
#!/bin/bash

set -euo pipefail

LAUNCHER_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
INSTALL_NAME="${PIXEL_FORGE_INSTALL_NAME:-pixel-forge}"
INSTALL_DIR="${PIXEL_FORGE_INSTALL_DIR:-$HOME/.local/lib/${INSTALL_NAME}}"
BACKUP_DIR="${PIXEL_FORGE_BACKUP_DIR:-$HOME/.local/lib/${INSTALL_NAME}.rollback}"
SHARED_STATE_DIR="${PIXEL_FORGE_SHARED_STATE_DIR:-$HOME/.pixel-forge}"
RUNTIME_DIR="${PIXEL_FORGE_RUNTIME_DIR:-${SHARED_STATE_DIR}/runtime}"
export PIXEL_FORGE_BIN_DIR="${PIXEL_FORGE_BIN_DIR:-$LAUNCHER_DIR}"

mkdir -p "$RUNTIME_DIR"

exec "$INSTALL_DIR/.venv/bin/python" "$INSTALL_DIR/pixel_forge_cli.py" "$@"
LAUNCHER

chmod +x "$BIN_DIR/pixel-forge"

cat > "$BIN_DIR/pixel-forge-shell" << 'SHELL'
#!/bin/bash

set -euo pipefail

LAUNCHER_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
INSTALL_NAME="${PIXEL_FORGE_INSTALL_NAME:-pixel-forge}"
INSTALL_DIR="${PIXEL_FORGE_INSTALL_DIR:-$HOME/.local/lib/${INSTALL_NAME}}"
BACKUP_DIR="${PIXEL_FORGE_BACKUP_DIR:-$HOME/.local/lib/${INSTALL_NAME}.rollback}"
SERVICE="${PIXEL_FORGE_SERVICE_NAME:-${INSTALL_NAME}}"
PORT="${PIXEL_FORGE_PORT:-7001}"
URL_HOST="${PIXEL_FORGE_URL_HOST:-pixel-forge.localhost}"
URL="http://${URL_HOST}:${PORT}"
SHARED_STATE_DIR="${PIXEL_FORGE_SHARED_STATE_DIR:-$HOME/.pixel-forge}"
RUNTIME_DIR="${PIXEL_FORGE_RUNTIME_DIR:-${SHARED_STATE_DIR}/runtime}"
ELECTRON_BIN="$INSTALL_DIR/node_modules/electron/dist/electron"

export PIXEL_FORGE_INSTALL_NAME="$INSTALL_NAME"
export PIXEL_FORGE_INSTALL_DIR="$INSTALL_DIR"
export PIXEL_FORGE_BACKUP_DIR="$BACKUP_DIR"
export PIXEL_FORGE_BIN_DIR="$LAUNCHER_DIR"
export PIXEL_FORGE_SERVICE_NAME="$SERVICE"
export PIXEL_FORGE_PORT="$PORT"
export PIXEL_FORGE_URL_HOST="$URL_HOST"
export PIXEL_FORGE_SHARED_STATE_DIR="$SHARED_STATE_DIR"
export PIXEL_FORGE_RUNTIME_DIR="$RUNTIME_DIR"

"$LAUNCHER_DIR/pixel-forge" start >/dev/null 2>&1 || true

for _ in $(seq 1 30); do
    if curl -fsS "$URL" >/dev/null 2>&1; then
        break
    fi
    sleep 1
done

if [ ! -x "$ELECTRON_BIN" ]; then
    echo "Pixel Forge desktop shell is not installed. Re-run ./install.sh"
    exit 1
fi

export PIXEL_FORGE_SHELL_URL="$URL"
exec "$ELECTRON_BIN" --no-sandbox "$INSTALL_DIR/desktop" "$@"
SHELL

chmod +x "$BIN_DIR/pixel-forge-shell"

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

[Install]
WantedBy=default.target
UNIT

    systemctl --user daemon-reload
    systemctl --user enable "${SERVICE_NAME}.service" 2>/dev/null || true
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
    cp "$SCRIPT_DIR/apps/web/public/favicon/main.png" "$ICON_DIR/pixel-forge.png"

    DESKTOP_DIR="$HOME/.local/share/applications"
    mkdir -p "$DESKTOP_DIR"

    cat > "$DESKTOP_DIR/pixel-forge.desktop" << 'DESKTOP'
[Desktop Entry]
Name=Pixel Forge
Comment=Visual app editor - screenshot bootstrap and live editing
Exec=bash -lc 'exec pixel-forge-shell'
Icon=pixel-forge
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
  "installedAt": "$INSTALL_TIMESTAMP"
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
echo "  pixel-forge-shell    # Open the desktop shell"
echo "  pixel-forge logs     # Tail logs"
echo "  pixel-forge status   # Check status"
echo ""
echo "Service: ${SERVICE_NAME}   Port: ${PORT}   Install: ${INSTALL_DIR}"
echo ""
echo "For development (hot-reload): ./start-dev.sh"
