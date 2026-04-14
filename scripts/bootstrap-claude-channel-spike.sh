#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

SHARED_STATE_DIR="${PIXEL_FORGE_SHARED_STATE_DIR:-$HOME/.pixel-forge}"
CHANNEL_ENV_FILE="${PIXEL_FORGE_CLAUDE_CHANNEL_ENV_FILE:-${SHARED_STATE_DIR}/claude-channel-spike.env}"

mkdir -p "$SHARED_STATE_DIR"
mkdir -p "$(dirname "$CHANNEL_ENV_FILE")"

bash "$SCRIPT_DIR/install-claude-channel-spike-plugin.sh"
bash "$SCRIPT_DIR/enable-claude-channel-spike.sh" > "$CHANNEL_ENV_FILE"
chmod 0644 "$CHANNEL_ENV_FILE"

echo "Bootstrapped Pixel Forge Claude channel spike."
echo "Channel env file: $CHANNEL_ENV_FILE"
echo "Future Agent Deck launches will source this file automatically."
