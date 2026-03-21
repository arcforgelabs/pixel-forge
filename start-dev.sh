#!/bin/bash
# pixel-forge Development Startup Script
# Starts all required services for the Live Editor
# Both backend and frontend auto-reload on code changes.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
if [ -f "$SCRIPT_DIR/scripts/workstation-v2-env.sh" ]; then
    # This clone is the dedicated workstation-v2 lane. Apply isolated defaults
    # unless the operator explicitly overrides them in the environment.
    # shellcheck disable=SC1091
    source "$SCRIPT_DIR/scripts/workstation-v2-env.sh"
fi

# Ensure common tool paths are available (desktop launchers may not source profile)
for p in "$HOME/.local/bin" "$HOME/.local/share/pnpm" "$HOME/.nvm/versions/node"/*/bin; do
    [ -d "$p" ] && case ":$PATH:" in *":$p:"*) ;; *) export PATH="$p:$PATH" ;; esac
done

API_DIR="$SCRIPT_DIR/apps/api"
WEB_DIR="$SCRIPT_DIR/apps/web"
INSTANCE_SLUG="${PIXEL_FORGE_INSTANCE_SLUG:-pixel-forge}"
API_PORT="${PIXEL_FORGE_API_PORT:-7001}"
WEB_PORT="${PIXEL_FORGE_WEB_PORT:-5173}"
WEB_HOST="${PIXEL_FORGE_WEB_HOST:-${INSTANCE_SLUG}.localhost}"
LOG_DIR="${PIXEL_FORGE_LOG_DIR:-$SCRIPT_DIR/.pixel-forge/logs}"
API_URL="http://127.0.0.1:${API_PORT}"
WEB_URL="http://${WEB_HOST}:${WEB_PORT}"
WEB_HEALTH_URL="http://127.0.0.1:${WEB_PORT}"
OPEN_BROWSER_SCRIPT="$SCRIPT_DIR/tools/open_visible_browser.sh"
DESKTOP_DIR="$SCRIPT_DIR/apps/desktop"
KILL_STALE="${PIXEL_FORGE_KILL_STALE:-0}"
USE_DESKTOP_SHELL="${PIXEL_FORGE_USE_DESKTOP_SHELL:-1}"
REQUIREMENTS_HASH_FILE="${PIXEL_FORGE_REQUIREMENTS_HASH_FILE:-$SCRIPT_DIR/.pixel-forge/api-requirements.sha256}"

mkdir -p "$LOG_DIR"

export PIXEL_FORGE_INSTANCE_SLUG="$INSTANCE_SLUG"
export PIXEL_FORGE_API_PORT="$API_PORT"
export PIXEL_FORGE_WEB_PORT="$WEB_PORT"
export PIXEL_FORGE_WEB_HOST="$WEB_HOST"
export VITE_PIXEL_FORGE_TARGET_MODE="${VITE_PIXEL_FORGE_TARGET_MODE:-${PIXEL_FORGE_TARGET_MODE:-0}}"
export VITE_PIXEL_FORGE_TARGET_PROJECT_PATH="${VITE_PIXEL_FORGE_TARGET_PROJECT_PATH:-${PIXEL_FORGE_TARGET_PROJECT_PATH:-}}"

# Colors for output
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m'

require_command() {
    local command_name="$1"
    local install_hint="$2"
    if ! command -v "$command_name" >/dev/null 2>&1; then
        echo -e "${RED}Error: missing required command '$command_name'. ${install_hint}${NC}"
        exit 1
    fi
}

find_listening_pids() {
    local port="$1"

    if command -v lsof >/dev/null 2>&1; then
        lsof -nP -tiTCP:"$port" -sTCP:LISTEN 2>/dev/null | sort -u
        return 0
    fi

    if command -v ss >/dev/null 2>&1; then
        ss -H -tlnp "sport = :$port" 2>/dev/null | sed -n 's/.*pid=\([0-9][0-9]*\).*/\1/p' | sort -u
    fi
}

ensure_port_available() {
    local port="$1"
    local label="$2"
    local pids

    pids="$(find_listening_pids "$port" || true)"
    if [ -z "$pids" ]; then
        return 0
    fi

    if [ "$KILL_STALE" != "1" ]; then
        echo -e "${RED}Error: ${label} port ${port} is already in use by PID(s): $(echo "$pids" | tr '\n' ' ' | xargs).${NC}"
        echo -e "${YELLOW}Set PIXEL_FORGE_KILL_STALE=1 to terminate those processes explicitly, or pick different ports.${NC}"
        exit 1
    fi

    while IFS= read -r pid; do
        [ -n "$pid" ] || continue
        echo -e "${YELLOW}Killing stale process on port $port (PID: $pid)${NC}"
        kill "$pid" 2>/dev/null || true
    done <<< "$pids"

    sleep 1
}

hash_file() {
    local file_path="$1"
    python3 - "$file_path" <<'PY'
from __future__ import annotations

import hashlib
import pathlib
import sys

path = pathlib.Path(sys.argv[1])
print(hashlib.sha256(path.read_bytes()).hexdigest())
PY
}

sync_api_dependencies() {
    local requirements_hash=""
    local previous_hash=""

    requirements_hash="$(hash_file "$API_DIR/requirements.txt")"
    previous_hash="$(cat "$REQUIREMENTS_HASH_FILE" 2>/dev/null || true)"

    if [ ! -d ".venv" ]; then
        echo "Creating Python venv..."
        python3 -m venv .venv
    fi

    if [ ! -x ".venv/bin/uvicorn" ] || [ "$requirements_hash" != "$previous_hash" ]; then
        echo "Syncing API Python dependencies..."
        .venv/bin/pip install -q --upgrade -r "$API_DIR/requirements.txt"
        mkdir -p "$(dirname "$REQUIREMENTS_HASH_FILE")"
        printf '%s\n' "$requirements_hash" > "$REQUIREMENTS_HASH_FILE"
        return
    fi

    echo "API Python dependencies unchanged."
}

# PIDs for cleanup
API_PID=""
FRONTEND_PID=""

cleanup() {
    echo -e "\n${YELLOW}Shutting down services...${NC}"
    [ -n "$API_PID" ] && kill "$API_PID" 2>/dev/null || true
    [ -n "$FRONTEND_PID" ] && kill "$FRONTEND_PID" 2>/dev/null || true
    echo -e "${GREEN}All services stopped.${NC}"
    exit 0
}

trap cleanup SIGINT SIGTERM EXIT

# Check dependencies
require_command "python3" "Install Python 3 and re-run ./start-dev.sh."
require_command "pnpm" "Install pnpm and re-run ./start-dev.sh."
require_command "curl" "Install curl and re-run ./start-dev.sh."
if ! command -v claude &> /dev/null; then
    if [ "${PIXEL_FORGE_TARGET_MODE:-0}" = "1" ]; then
        echo -e "${YELLOW}Warning: claude CLI not found. Target runtime will boot, but agent-backed flows will not work inside it.${NC}"
    else
        echo -e "${RED}Error: claude CLI not found. Install with: npm install -g @anthropic-ai/claude-code${NC}"
        exit 1
    fi
fi

ensure_port_available "$API_PORT" "API"
ensure_port_available "$WEB_PORT" "Frontend"

# --- API Backend with auto-reload ---
cd "$API_DIR"

sync_api_dependencies

echo -e "${YELLOW}Starting API (auto-reload)...${NC}"
.venv/bin/uvicorn main:app --host 0.0.0.0 --port "$API_PORT" --reload \
    --reload-dir "$API_DIR" \
    > "$LOG_DIR/api.log" 2>&1 &
API_PID=$!

# Wait for API to be ready
for i in $(seq 1 10); do
    if curl -s "$API_URL/" > /dev/null 2>&1; then break; fi
    sleep 1
done
if ! curl -s "$API_URL/" > /dev/null 2>&1; then
    echo -e "${RED}Failed to start API. Check $LOG_DIR/api.log${NC}"
    cat "$LOG_DIR/api.log"
    exit 1
fi
echo -e "${GREEN}✓ API on ${API_URL} (auto-reload)${NC}"

# --- Frontend with Vite HMR ---
cd "$WEB_DIR"

if [ ! -d "node_modules" ]; then
    echo "Installing frontend dependencies..."
    pnpm install
fi

echo -e "${YELLOW}Starting frontend (HMR)...${NC}"
pnpm dev > "$LOG_DIR/web.log" 2>&1 &
FRONTEND_PID=$!

for i in $(seq 1 10); do
    if curl -s "$WEB_HEALTH_URL/" > /dev/null 2>&1; then break; fi
    sleep 1
done
if ! kill -0 "$FRONTEND_PID" 2>/dev/null; then
    echo -e "${RED}Failed to start frontend. Check $LOG_DIR/web.log${NC}"
    cat "$LOG_DIR/web.log"
    exit 1
fi
if ! curl -s "$WEB_HEALTH_URL/" > /dev/null 2>&1; then
    echo -e "${RED}Frontend not responding. Check $LOG_DIR/web.log${NC}"
    exit 1
fi
echo -e "${GREEN}✓ Frontend on ${WEB_URL} (HMR)${NC}"

# --- Open browser or desktop shell ---
if [ "${PIXEL_FORGE_NO_BROWSER:-0}" != "1" ]; then
    if [ "$USE_DESKTOP_SHELL" = "1" ] && { [ -n "${DISPLAY:-}" ] || [ -n "${WAYLAND_DISPLAY:-}" ]; }; then
        if [ ! -d "$DESKTOP_DIR/node_modules" ]; then
            echo "Installing desktop shell dependencies..."
            pnpm --dir "$DESKTOP_DIR" install
        fi
        PIXEL_FORGE_SHELL_URL="$WEB_URL" pnpm --dir "$DESKTOP_DIR" start >/dev/null 2>&1 &
    elif [ -x "$OPEN_BROWSER_SCRIPT" ]; then
        "$OPEN_BROWSER_SCRIPT" "$WEB_URL" >/dev/null 2>&1 &
    fi
fi

echo ""
echo -e "${GREEN}Pixel Forge running.${NC} Logs: $LOG_DIR/"
echo -e "  Web: ${GREEN}${WEB_URL}${NC}   API: ${GREEN}${API_URL}${NC}"
echo -e "  ${YELLOW}Both services auto-reload on file changes.${NC}"
echo -e "  Press Ctrl+C to stop."

wait
