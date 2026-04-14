#!/usr/bin/env bash
# Bootstrap the Pixel Forge <-> Codex MCP channel.
#
# Thin wrapper that mirrors bootstrap-claude-channel-spike.sh: stages the
# shared MCP server into the Codex user directory, then emits a sourceable
# env file so Agent Deck knows Codex is wired on subsequent launches.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

SHARED_STATE_DIR="${PIXEL_FORGE_SHARED_STATE_DIR:-$HOME/.pixel-forge}"
CODEX_ENV_FILE="${PIXEL_FORGE_CODEX_CHANNEL_ENV_FILE:-${SHARED_STATE_DIR}/codex-channel.env}"

mkdir -p "$SHARED_STATE_DIR"
mkdir -p "$(dirname "$CODEX_ENV_FILE")"

bash "$SCRIPT_DIR/install-codex-channel.sh"
bash "$SCRIPT_DIR/enable-codex-channel.sh" > "$CODEX_ENV_FILE"
chmod 0644 "$CODEX_ENV_FILE"

echo "Bootstrapped Pixel Forge Codex channel."
echo "Codex env file: $CODEX_ENV_FILE"
echo "Future Agent Deck launches will source this file automatically."
