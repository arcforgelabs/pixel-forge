#!/usr/bin/env bash
# Emit env vars that advertise the Codex MCP channel to Agent Deck / Pixel Forge.
#
# Unlike the Claude spike (which has to toggle --dangerously-load-development-channels
# on the claude CLI), Codex auto-loads the MCP server from ~/.codex/config.toml
# on every invocation. So these vars exist purely as a readiness signal for
# Pixel Forge's event ingest to know which HTTP port to publish channel
# messages against.
set -euo pipefail

export AGENTDECK_CODEX_CHANNEL_ENTRY="${AGENTDECK_CODEX_CHANNEL_ENTRY:-mcp:pixel-forge-channel}"
export PIXEL_FORGE_CODEX_CHANNEL_HOST="${PIXEL_FORGE_CODEX_CHANNEL_HOST:-127.0.0.1}"
export PIXEL_FORGE_CODEX_CHANNEL_PORT="${PIXEL_FORGE_CODEX_CHANNEL_PORT:-8789}"
export PIXEL_FORGE_CODEX_CHANNEL_READY_FILE="${PIXEL_FORGE_CODEX_CHANNEL_READY_FILE:-/tmp/pixel-forge-codex-channel-ready.json}"

printf 'export AGENTDECK_CODEX_CHANNEL_ENTRY=%q\n' "$AGENTDECK_CODEX_CHANNEL_ENTRY"
printf 'export PIXEL_FORGE_CODEX_CHANNEL_HOST=%q\n' "$PIXEL_FORGE_CODEX_CHANNEL_HOST"
printf 'export PIXEL_FORGE_CODEX_CHANNEL_PORT=%q\n' "$PIXEL_FORGE_CODEX_CHANNEL_PORT"
printf 'export PIXEL_FORGE_CODEX_CHANNEL_READY_FILE=%q\n' "$PIXEL_FORGE_CODEX_CHANNEL_READY_FILE"
