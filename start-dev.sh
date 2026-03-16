#!/bin/bash
# pixel-forge Development Startup Script
# Starts all required services for the Live Editor

set -e

# Ensure common tool paths are available (desktop launchers may not source profile)
for p in "$HOME/.local/bin" "$HOME/.local/share/pnpm" "$HOME/.nvm/versions/node"/*/bin; do
    [ -d "$p" ] && case ":$PATH:" in *":$p:"*) ;; *) export PATH="$p:$PATH" ;; esac
done

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
API_DIR="$SCRIPT_DIR/apps/api"
WEB_DIR="$SCRIPT_DIR/apps/web"
API_URL="http://127.0.0.1:7001"
WEB_URL="http://pixel-forge.localhost:5173"
WEB_HEALTH_URL="http://127.0.0.1:5173"

# Kill stale Pixel Forge processes on our ports before starting
for port in 7001 5173; do
    stale_pid=$(ss -tlnp "sport = :$port" 2>/dev/null | grep -oP 'pid=\K[0-9]+' || true)
    if [ -n "$stale_pid" ]; then
        echo -e "${YELLOW}Killing stale process on port $port (PID: $stale_pid)${NC}"
        kill "$stale_pid" 2>/dev/null || true
        sleep 1
    fi
done
OPEN_BROWSER_SCRIPT="$SCRIPT_DIR/tools/open_visible_browser.sh"

# Colors for output
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m' # No Color

# PIDs for cleanup
CLAUDE_PROXY_PID=""
FRONTEND_PID=""

cleanup() {
    echo -e "\n${YELLOW}Shutting down services...${NC}"

    if [ -n "$CLAUDE_PROXY_PID" ] && kill -0 "$CLAUDE_PROXY_PID" 2>/dev/null; then
        echo "Stopping api (PID: $CLAUDE_PROXY_PID)"
        kill "$CLAUDE_PROXY_PID" 2>/dev/null || true
    fi

    if [ -n "$FRONTEND_PID" ] && kill -0 "$FRONTEND_PID" 2>/dev/null; then
        echo "Stopping frontend (PID: $FRONTEND_PID)"
        kill "$FRONTEND_PID" 2>/dev/null || true
    fi

    echo -e "${GREEN}All services stopped.${NC}"
    exit 0
}

trap cleanup SIGINT SIGTERM EXIT

echo -e "${GREEN}╔════════════════════════════════════════╗${NC}"
echo -e "${GREEN}║     pixel-forge Development Server     ║${NC}"
echo -e "${GREEN}╚════════════════════════════════════════╝${NC}"
echo ""

# Check dependencies
if ! command -v claude &> /dev/null; then
    echo -e "${RED}Error: claude CLI not found. Install with: npm install -g @anthropic-ai/claude-code${NC}"
    exit 1
fi

# Start API Backend (port 7001)
echo -e "${YELLOW}Starting Pixel Forge API on port 7001...${NC}"
cd "$API_DIR"

if [ ! -d ".venv" ]; then
    echo "Creating Python venv..."
    python3 -m venv .venv
    .venv/bin/pip install -q fastapi uvicorn httpx pillow moviepy pydantic
fi

.venv/bin/python main.py &
CLAUDE_PROXY_PID=$!
sleep 2

# Verify API started
if ! curl -s "$API_URL/" > /dev/null 2>&1; then
    echo -e "${RED}Failed to start Pixel Forge API${NC}"
    exit 1
fi
echo -e "${GREEN}✓ Pixel Forge API running on ${API_URL}${NC}"

# Start Frontend (port 5173)
echo -e "${YELLOW}Starting Pixel Forge Web on port 5173...${NC}"
cd "$WEB_DIR"

if [ ! -d "node_modules" ]; then
    echo "Installing frontend dependencies..."
    pnpm install
fi

pnpm dev &
FRONTEND_PID=$!
sleep 3

# Verify frontend started (check the process is still alive AND the port responds)
if ! kill -0 "$FRONTEND_PID" 2>/dev/null; then
    echo -e "${RED}Failed to start frontend (process exited)${NC}"
    exit 1
fi
if ! curl -s "$WEB_HEALTH_URL/" > /dev/null 2>&1; then
    echo -e "${RED}Failed to start frontend (port 5173 not responding)${NC}"
    exit 1
fi
echo -e "${GREEN}✓ Pixel Forge Web running on ${WEB_URL}${NC}"

if [ "${PIXEL_FORGE_NO_BROWSER:-0}" != "1" ] && [ -x "$OPEN_BROWSER_SCRIPT" ]; then
    echo -e "${YELLOW}Opening a maximized Pixel Forge browser window...${NC}"
    "$OPEN_BROWSER_SCRIPT" "$WEB_URL" >/dev/null 2>&1 &
fi

echo ""
echo -e "${GREEN}════════════════════════════════════════${NC}"
echo -e "${GREEN}All services started successfully!${NC}"
echo ""
echo -e "  Web:           ${GREEN}${WEB_URL}${NC}"
echo -e "  API:           ${GREEN}${API_URL}${NC}"
echo ""
echo -e "  Live Editor:   ${GREEN}${WEB_URL}${NC} → Live Editor tab"
echo ""
echo -e "${YELLOW}Press Ctrl+C to stop all services${NC}"
echo -e "${GREEN}════════════════════════════════════════${NC}"

# Wait for any process to exit
wait
