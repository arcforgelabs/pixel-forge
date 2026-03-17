#!/bin/bash
# pixel-forge Development Startup Script
# Starts all required services for the Live Editor
# Both backend and frontend auto-reload on code changes.

set -e

# Ensure common tool paths are available (desktop launchers may not source profile)
for p in "$HOME/.local/bin" "$HOME/.local/share/pnpm" "$HOME/.nvm/versions/node"/*/bin; do
    [ -d "$p" ] && case ":$PATH:" in *":$p:"*) ;; *) export PATH="$p:$PATH" ;; esac
done

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
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
KILL_STALE="${PIXEL_FORGE_KILL_STALE:-1}"
USE_DESKTOP_SHELL="${PIXEL_FORGE_USE_DESKTOP_SHELL:-1}"

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

if [ "$KILL_STALE" = "1" ]; then
    # Kill stale Pixel Forge processes on our configured ports before starting
    for port in "$API_PORT" "$WEB_PORT"; do
        stale_pid=$(ss -tlnp "sport = :$port" 2>/dev/null | grep -oP 'pid=\K[0-9]+' || true)
        if [ -n "$stale_pid" ]; then
            echo -e "${YELLOW}Killing stale process on port $port (PID: $stale_pid)${NC}"
            kill "$stale_pid" 2>/dev/null || true
            sleep 1
        fi
    done
fi

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
if ! command -v claude &> /dev/null; then
    if [ "${PIXEL_FORGE_TARGET_MODE:-0}" = "1" ]; then
        echo -e "${YELLOW}Warning: claude CLI not found. Target runtime will boot, but agent-backed flows will not work inside it.${NC}"
    else
        echo -e "${RED}Error: claude CLI not found. Install with: npm install -g @anthropic-ai/claude-code${NC}"
        exit 1
    fi
fi

# --- API Backend with auto-reload ---
cd "$API_DIR"

if [ ! -d ".venv" ]; then
    echo "Creating Python venv..."
    python3 -m venv .venv
fi

echo "Syncing API Python dependencies..."
.venv/bin/pip install -q --upgrade -r "$API_DIR/requirements.txt"

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
