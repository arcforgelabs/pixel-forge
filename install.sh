#!/bin/bash
# Install pixel-forge as a self-contained local app
# Single process: FastAPI serves the built React frontend + API + proxy
# Managed by a systemd user service — survives terminal close.
# Usage: ./install.sh

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
INSTALL_DIR="$HOME/.local/lib/pixel-forge"
BIN_DIR="$HOME/.local/bin"
WEB_DIR="$SCRIPT_DIR/apps/web"
DESKTOP_SOURCE_DIR="$SCRIPT_DIR/apps/desktop"

# Ensure pnpm/node are in PATH
for p in "$HOME/.local/bin" "$HOME/.local/share/pnpm" "$HOME/.nvm/versions/node"/*/bin; do
    [ -d "$p" ] && case ":$PATH:" in *":$p:"*) ;; *) export PATH="$p:$PATH" ;; esac
done

echo "Installing pixel-forge..."

# --- Build frontend ---
if command -v pnpm &>/dev/null; then
    echo "Building frontend..."
    cd "$WEB_DIR"
    [ -d "node_modules" ] || pnpm install --frozen-lockfile
    pnpm build
    echo "Frontend built."
else
    echo "Warning: pnpm not found — skipping frontend build."
    echo "  Install pnpm and re-run, or run 'pnpm build' in apps/web/ manually."
fi

# --- Install backend ---
mkdir -p "$INSTALL_DIR"
mkdir -p "$BIN_DIR"

echo "Copying API to $INSTALL_DIR..."
# Clean old files but preserve .venv
find "$INSTALL_DIR" -maxdepth 1 -not -name '.venv' -not -name "$(basename "$INSTALL_DIR")" -exec rm -rf {} + 2>/dev/null || true
cp -r "$SCRIPT_DIR/apps/api/"* "$INSTALL_DIR/"

# --- Bundle built frontend ---
if [ -f "$WEB_DIR/dist/index.html" ]; then
    echo "Bundling built frontend..."
    rm -rf "$INSTALL_DIR/frontend"
    cp -r "$WEB_DIR/dist" "$INSTALL_DIR/frontend"
fi

# --- Desktop shell ---
if [ -f "$DESKTOP_SOURCE_DIR/package.json" ]; then
    echo "Installing desktop shell..."
    rm -rf "$INSTALL_DIR/desktop"
    cp -r "$DESKTOP_SOURCE_DIR" "$INSTALL_DIR/desktop"
    if command -v npm &>/dev/null; then
        DESKTOP_ELECTRON_SPEC="$(node -p "require('$DESKTOP_SOURCE_DIR/package.json').dependencies.electron")"
        (
            cd "$INSTALL_DIR"
            npm install "electron@${DESKTOP_ELECTRON_SPEC#^}" --no-fund --no-audit
        )
    else
        echo "Warning: npm not found — desktop shell dependencies were not installed."
    fi
fi

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
# pixel-forge — start or manage the Pixel Forge service

INSTALL_DIR="$HOME/.local/lib/pixel-forge"
SERVICE="pixel-forge"
PORT="${PIXEL_FORGE_PORT:-7001}"
URL="http://pixel-forge.localhost:$PORT"

case "${1:-start}" in
    start)
        # Start via systemd if available, otherwise foreground
        if systemctl --user cat "$SERVICE" &>/dev/null; then
            systemctl --user start "$SERVICE"
            echo "Pixel Forge started (systemd). Open: $URL"
        else
            echo "Starting Pixel Forge on port $PORT..."
            cd "$INSTALL_DIR"
            exec "$INSTALL_DIR/.venv/bin/uvicorn" main:app --host 0.0.0.0 --port "$PORT"
        fi
        ;;
    stop)
        if systemctl --user cat "$SERVICE" &>/dev/null; then
            systemctl --user stop "$SERVICE"
            echo "Pixel Forge stopped."
        else
            echo "No systemd service found. Kill the process manually."
        fi
        ;;
    restart)
        "$0" stop
        sleep 1
        "$0" start
        ;;
    status)
        if systemctl --user cat "$SERVICE" &>/dev/null; then
            systemctl --user status "$SERVICE" --no-pager
        else
            echo "No systemd service. Checking port $PORT..."
            ss -tlnp "sport = :$PORT" 2>/dev/null || echo "Not running."
        fi
        ;;
    logs)
        if systemctl --user cat "$SERVICE" &>/dev/null; then
            journalctl --user -u "$SERVICE" -f --no-pager
        else
            echo "No systemd service logs available."
        fi
        ;;
    open)
        xdg-open "$URL" 2>/dev/null || echo "Open: $URL"
        ;;
    --help|-h)
        echo "Usage: pixel-forge [start|stop|restart|status|logs|open]"
        echo ""
        echo "Commands:"
        echo "  start     Start the service (default)"
        echo "  stop      Stop the service"
        echo "  restart   Restart the service"
        echo "  status    Show service status"
        echo "  logs      Tail service logs"
        echo "  open      Open in browser"
        echo ""
        echo "Environment:"
        echo "  PIXEL_FORGE_PORT  Port (default: 7001)"
        ;;
    *)
        echo "Unknown command: $1 (try: pixel-forge --help)"
        exit 1
        ;;
esac
LAUNCHER

chmod +x "$BIN_DIR/pixel-forge"

cat > "$BIN_DIR/pixel-forge-shell" << 'SHELL'
#!/bin/bash

INSTALL_DIR="$HOME/.local/lib/pixel-forge"
PORT="${PIXEL_FORGE_PORT:-7001}"
URL="http://pixel-forge.localhost:$PORT"
ELECTRON_BIN="$INSTALL_DIR/node_modules/electron/dist/electron"

pixel-forge start >/dev/null 2>&1 || true

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
exec "$ELECTRON_BIN" --no-sandbox "$INSTALL_DIR/desktop"
SHELL

chmod +x "$BIN_DIR/pixel-forge-shell"

# --- Systemd user service ---
SYSTEMD_DIR="$HOME/.config/systemd/user"
mkdir -p "$SYSTEMD_DIR"

cat > "$SYSTEMD_DIR/pixel-forge.service" << UNIT
[Unit]
Description=Pixel Forge — Visual App Editor
After=network.target

[Service]
Type=simple
WorkingDirectory=$INSTALL_DIR
ExecStart=$INSTALL_DIR/.venv/bin/uvicorn main:app --host 0.0.0.0 --port 7001
Restart=on-failure
RestartSec=3
Environment=PATH=$HOME/.local/bin:/usr/local/bin:/usr/bin:/bin

[Install]
WantedBy=default.target
UNIT

systemctl --user daemon-reload
systemctl --user enable pixel-forge.service 2>/dev/null || true
echo "Systemd service installed and enabled."

# --- Icon ---
ICON_DIR="$HOME/.local/share/icons/hicolor/256x256/apps"
mkdir -p "$ICON_DIR"
cp "$SCRIPT_DIR/apps/web/public/favicon/main.png" "$ICON_DIR/pixel-forge.png"

# --- Desktop entry ---
DESKTOP_DIR="$HOME/.local/share/applications"
mkdir -p "$DESKTOP_DIR"

cat > "$DESKTOP_DIR/pixel-forge.desktop" << 'DESKTOP'
[Desktop Entry]
Name=Pixel Forge
Comment=Visual app editor — screenshot bootstrap and live editing
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

echo ""
echo "Installation complete!"
echo ""
echo "Usage:"
echo "  pixel-forge start    # Start the service"
echo "  pixel-forge stop     # Stop it"
echo "  pixel-forge open     # Open in browser"
echo "  pixel-forge-shell    # Open the desktop shell"
echo "  pixel-forge logs     # Tail logs"
echo "  pixel-forge status   # Check status"
echo ""
echo "Or click 'Pixel Forge' in your app menu."
echo ""
echo "For development (hot-reload): ./start-dev.sh"
