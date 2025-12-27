#!/bin/bash
# Uninstall pixel-forge
# Usage: ./uninstall.sh

set -e

INSTALL_DIR="$HOME/.local/lib/pixel-forge"
BIN_DIR="$HOME/.local/bin"

echo "Uninstalling pixel-forge..."

# Remove launcher
if [ -f "$BIN_DIR/pixel-forge" ]; then
    rm "$BIN_DIR/pixel-forge"
    echo "Removed $BIN_DIR/pixel-forge"
fi

# Remove install directory
if [ -d "$INSTALL_DIR" ]; then
    rm -rf "$INSTALL_DIR"
    echo "Removed $INSTALL_DIR"
fi

echo "Uninstall complete."
