#!/usr/bin/env bash
# Register the shared pixel-forge-channel MCP server as a Codex MCP client.
#
# Codex reads ~/.codex/config.toml on every session; any [mcp_servers.X]
# entry is auto-spawned and attached. This script copies the same server.mjs
# that the Claude plugin uses into a stable per-user location, installs its
# node dependencies, and merges a managed [mcp_servers.pixel-forge-channel]
# section into ~/.codex/config.toml (idempotent via BEGIN/END markers).
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PLUGIN_SRC="${REPO_ROOT}/tools/claude-channel-spike"

SHARED_STATE_DIR="${PIXEL_FORGE_SHARED_STATE_DIR:-${HOME}/.pixel-forge}"
CODEX_CHANNEL_DIR="${PIXEL_FORGE_CODEX_CHANNEL_DIR:-${SHARED_STATE_DIR}/codex-channel}"
CODEX_CONFIG_DIR="${PIXEL_FORGE_CODEX_CONFIG_DIR:-${HOME}/.codex}"
CODEX_CONFIG_FILE="${CODEX_CONFIG_DIR}/config.toml"
CODEX_CHANNEL_PORT="${PIXEL_FORGE_CODEX_CHANNEL_PORT:-8789}"
CODEX_CHANNEL_HOST="${PIXEL_FORGE_CODEX_CHANNEL_HOST:-127.0.0.1}"
CODEX_CHANNEL_READY_FILE="${PIXEL_FORGE_CODEX_CHANNEL_READY_FILE:-/tmp/pixel-forge-codex-channel-ready.json}"

if [ ! -d "${PLUGIN_SRC}" ]; then
    echo "error: MCP plugin source not found at ${PLUGIN_SRC}" >&2
    exit 1
fi

mkdir -p "${CODEX_CHANNEL_DIR}"
mkdir -p "${CODEX_CONFIG_DIR}"

# Stage the MCP server + package.json into the stable location.
if command -v rsync >/dev/null 2>&1; then
    rsync -a --delete \
        --exclude node_modules \
        "${PLUGIN_SRC}/" "${CODEX_CHANNEL_DIR}/"
else
    # Fallback: rm + cp; loses node_modules preservation but we rebuild anyway.
    rm -rf "${CODEX_CHANNEL_DIR}"
    mkdir -p "${CODEX_CHANNEL_DIR}"
    cp -a "${PLUGIN_SRC}/." "${CODEX_CHANNEL_DIR}/"
    rm -rf "${CODEX_CHANNEL_DIR}/node_modules"
fi

# Install MCP SDK dependency so Codex can spawn the server without a lazy install.
if command -v npm >/dev/null 2>&1; then
    ( cd "${CODEX_CHANNEL_DIR}" && npm install --no-fund --no-audit --silent )
else
    echo "warn: npm not found on PATH; Codex will fail to spawn the MCP server until node_modules is populated at ${CODEX_CHANNEL_DIR}." >&2
fi

SERVER_JS="${CODEX_CHANNEL_DIR}/server.mjs"
NODE_BIN="$(command -v node || true)"
if [ -z "${NODE_BIN}" ]; then
    echo "error: node not on PATH; cannot register Codex MCP server." >&2
    exit 1
fi

BEGIN_MARKER="# BEGIN pixel-forge-channel (managed by Pixel Forge install)"
END_MARKER="# END pixel-forge-channel"

TOML_BLOCK="${BEGIN_MARKER}
[mcp_servers.pixel-forge-channel]
command = \"${NODE_BIN}\"
args = [\"${SERVER_JS}\"]

[mcp_servers.pixel-forge-channel.env]
PIXEL_FORGE_CLAUDE_CHANNEL_HOST = \"${CODEX_CHANNEL_HOST}\"
PIXEL_FORGE_CLAUDE_CHANNEL_PORT = \"${CODEX_CHANNEL_PORT}\"
PIXEL_FORGE_CLAUDE_CHANNEL_READY_FILE = \"${CODEX_CHANNEL_READY_FILE}\"
${END_MARKER}
"

python3 - "${CODEX_CONFIG_FILE}" "${BEGIN_MARKER}" "${END_MARKER}" <<PY
import pathlib
import sys

path = pathlib.Path(sys.argv[1])
begin = sys.argv[2]
end = sys.argv[3]
block = """${TOML_BLOCK}"""

text = path.read_text() if path.exists() else ""

start = text.find(begin)
if start != -1:
    stop = text.find(end, start)
    if stop == -1:
        # Corrupt / partial marker; bail loudly rather than silently duplicate.
        print(f"error: found BEGIN marker but no END marker in {path}", file=sys.stderr)
        sys.exit(1)
    stop_end = stop + len(end)
    # Swallow the trailing newline after the end marker if present.
    if stop_end < len(text) and text[stop_end] == "\n":
        stop_end += 1
    text = text[:start] + text[stop_end:]

# Ensure there is a separating blank line before the block if file is non-empty.
if text and not text.endswith("\n\n"):
    if text.endswith("\n"):
        text += "\n"
    else:
        text += "\n\n"

text += block

path.write_text(text)
PY

echo "Registered [mcp_servers.pixel-forge-channel] in ${CODEX_CONFIG_FILE}"
echo "Codex MCP server staged at ${CODEX_CHANNEL_DIR}"
echo "Channel HTTP ingress: http://${CODEX_CHANNEL_HOST}:${CODEX_CHANNEL_PORT}"
