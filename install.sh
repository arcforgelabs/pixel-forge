#!/bin/bash
# Install pixel-forge as a local command
# Usage: ./install.sh

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
INSTALL_DIR="$HOME/.local/lib/pixel-forge"
BIN_DIR="$HOME/.local/bin"

echo "Installing pixel-forge..."

# Create directories
mkdir -p "$INSTALL_DIR"
mkdir -p "$BIN_DIR"

# Copy API files (not symlink - survives repo moves)
echo "Copying files to $INSTALL_DIR..."
cp -r "$SCRIPT_DIR/apps/api/"* "$INSTALL_DIR/"

# Create virtual environment if needed
if [ ! -d "$INSTALL_DIR/.venv" ]; then
    echo "Creating virtual environment..."
    python3 -m venv "$INSTALL_DIR/.venv"
fi

# Install dependencies
echo "Installing dependencies..."
"$INSTALL_DIR/.venv/bin/pip" install -q --upgrade pip
"$INSTALL_DIR/.venv/bin/pip" install -q -r "$INSTALL_DIR/requirements.txt"

# Create launcher script
cat > "$BIN_DIR/pixel-forge" << 'EOF'
#!/bin/bash
# pixel-forge launcher

INSTALL_DIR="$HOME/.local/lib/pixel-forge"

# Parse arguments
PORT="${PIXEL_FORGE_PORT:-7001}"
while [[ $# -gt 0 ]]; do
    case $1 in
        --port|-p)
            PORT="$2"
            shift 2
            ;;
        --help|-h)
            echo "Usage: pixel-forge [OPTIONS]"
            echo ""
            echo "Options:"
            echo "  -p, --port PORT    Port to run on (default: 7001)"
            echo "  -h, --help         Show this help"
            echo ""
            echo "Open http://127.0.0.1:$PORT/test-harness.html after starting"
            exit 0
            ;;
        *)
            echo "Unknown option: $1"
            exit 1
            ;;
    esac
done

cd "$INSTALL_DIR"
exec "$INSTALL_DIR/.venv/bin/python" -m uvicorn main:app --host 0.0.0.0 --port "$PORT"
EOF

chmod +x "$BIN_DIR/pixel-forge"

# Install icon
ICON_DIR="$HOME/.local/share/icons/hicolor/256x256/apps"
mkdir -p "$ICON_DIR"
cp "$SCRIPT_DIR/apps/web/public/favicon/main.png" "$ICON_DIR/pixel-forge.png"
echo "Icon installed to $ICON_DIR/pixel-forge.png"

# Install desktop entry
DESKTOP_DIR="$HOME/.local/share/applications"
mkdir -p "$DESKTOP_DIR"
cp "$SCRIPT_DIR/pixel-forge.desktop" "$DESKTOP_DIR/pixel-forge.desktop"
echo "Desktop entry installed to $DESKTOP_DIR/pixel-forge.desktop"

# Refresh icon cache and desktop database (if available)
gtk-update-icon-cache -f -t "$HOME/.local/share/icons/hicolor" 2>/dev/null || true
update-desktop-database "$DESKTOP_DIR" 2>/dev/null || true

echo ""
echo "Installation complete!"
echo ""
echo "Usage:"
echo "  pixel-forge              # Start backend on port 7001"
echo "  pixel-forge --port 8080  # Start on custom port"
echo ""
echo "Full UI (backend + frontend):"
echo "  Launch 'Pixel Forge' from your app menu, or run:"
echo "  $SCRIPT_DIR/start-dev.sh"
echo ""
echo "Make sure ~/.local/bin is in your PATH:"
echo "  export PATH=\"\$HOME/.local/bin:\$PATH\""
