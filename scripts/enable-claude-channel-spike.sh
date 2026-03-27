#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SERVER_PATH="$ROOT_DIR/tools/claude-channel-spike/server.mjs"
CHANNEL_NAME="${AGENTDECK_CLAUDE_CHANNEL_ENTRY:-plugin:pixel-forge-channel@arc-forge}"
MCP_CONFIG_FILE="${PIXEL_FORGE_CLAUDE_CHANNEL_MCP_CONFIG_FILE:-/tmp/pixel-forge-claude-channel-mcp.json}"

case "$CHANNEL_NAME" in
  server:*)
    node -e 'const fs = require("node:fs"); const path = process.argv[1]; const out = process.argv[2]; fs.writeFileSync(out, JSON.stringify({mcpServers:{"pixel-forge-channel":{command:"node",args:[path]}}}));' "$SERVER_PATH" "$MCP_CONFIG_FILE"
    export AGENTDECK_CLAUDE_CHANNEL_MCP_CONFIG="$MCP_CONFIG_FILE"
    ;;
  plugin:*)
    unset AGENTDECK_CLAUDE_CHANNEL_MCP_CONFIG
    ;;
  *)
    echo "unsupported channel entry: $CHANNEL_NAME" >&2
    return 1 2>/dev/null || exit 1
    ;;
esac

export AGENTDECK_CLAUDE_CHANNEL_ENTRY="$CHANNEL_NAME"
export AGENTDECK_CLAUDE_CHANNEL_DEVELOPMENT="${AGENTDECK_CLAUDE_CHANNEL_DEVELOPMENT:-1}"
export AGENTDECK_CLAUDE_CHANNEL_AUTO_CONFIRM="${AGENTDECK_CLAUDE_CHANNEL_AUTO_CONFIRM:-1}"
export PIXEL_FORGE_CLAUDE_CHANNEL_PORT="${PIXEL_FORGE_CLAUDE_CHANNEL_PORT:-8788}"
export PIXEL_FORGE_CLAUDE_CHANNEL_HOST="${PIXEL_FORGE_CLAUDE_CHANNEL_HOST:-127.0.0.1}"
export PIXEL_FORGE_CLAUDE_CHANNEL_READY_FILE="${PIXEL_FORGE_CLAUDE_CHANNEL_READY_FILE:-/tmp/pixel-forge-claude-channel-ready.json}"

printf 'export AGENTDECK_CLAUDE_CHANNEL_ENTRY=%q\n' "$AGENTDECK_CLAUDE_CHANNEL_ENTRY"
printf 'export AGENTDECK_CLAUDE_CHANNEL_DEVELOPMENT=%q\n' "$AGENTDECK_CLAUDE_CHANNEL_DEVELOPMENT"
printf 'export AGENTDECK_CLAUDE_CHANNEL_AUTO_CONFIRM=%q\n' "$AGENTDECK_CLAUDE_CHANNEL_AUTO_CONFIRM"
if [[ "${AGENTDECK_CLAUDE_CHANNEL_ENTRY}" == server:* ]]; then
  printf 'export AGENTDECK_CLAUDE_CHANNEL_MCP_CONFIG=%q\n' "$AGENTDECK_CLAUDE_CHANNEL_MCP_CONFIG"
fi
printf 'export PIXEL_FORGE_CLAUDE_CHANNEL_MCP_CONFIG_FILE=%q\n' "$MCP_CONFIG_FILE"
printf 'export PIXEL_FORGE_CLAUDE_CHANNEL_PORT=%q\n' "$PIXEL_FORGE_CLAUDE_CHANNEL_PORT"
printf 'export PIXEL_FORGE_CLAUDE_CHANNEL_HOST=%q\n' "$PIXEL_FORGE_CLAUDE_CHANNEL_HOST"
printf 'export PIXEL_FORGE_CLAUDE_CHANNEL_READY_FILE=%q\n' "$PIXEL_FORGE_CLAUDE_CHANNEL_READY_FILE"
