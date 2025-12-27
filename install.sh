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

# Copy proxy files (not symlink - survives repo moves)
echo "Copying files to $INSTALL_DIR..."
cp -r "$SCRIPT_DIR/claude-proxy/"* "$INSTALL_DIR/"

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
            echo "Open http://localhost:$PORT/test-harness.html after starting"
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

echo ""
echo "Installation complete!"
echo ""
echo "Usage:"
echo "  pixel-forge              # Start on port 7001"
echo "  pixel-forge --port 8080  # Start on custom port"
echo ""
echo "Then open: http://localhost:7001/test-harness.html"
echo ""
echo "Make sure ~/.local/bin is in your PATH:"
echo "  export PATH=\"\$HOME/.local/bin:\$PATH\""
