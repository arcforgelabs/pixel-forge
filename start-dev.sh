#!/bin/bash
# pixel-forge Development Startup Script
# Starts all required services for the Live Editor

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CLAUDE_PROXY_DIR="$SCRIPT_DIR/claude-proxy"
FRONTEND_DIR="$SCRIPT_DIR/screenshot-to-code/frontend"

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
        echo "Stopping claude-proxy (PID: $CLAUDE_PROXY_PID)"
        kill "$CLAUDE_PROXY_PID" 2>/dev/null || true
    fi

    if [ -n "$FRONTEND_PID" ] && kill -0 "$FRONTEND_PID" 2>/dev/null; then
        echo "Stopping frontend (PID: $FRONTEND_PID)"
        kill "$FRONTEND_PID" 2>/dev/null || true
    fi

    # Kill any remaining processes on our ports
    fuser -k 7001/tcp 2>/dev/null || true
    fuser -k 5173/tcp 2>/dev/null || true

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

# Start Claude Proxy Backend (port 7001)
echo -e "${YELLOW}Starting Claude Proxy Backend on port 7001...${NC}"
cd "$CLAUDE_PROXY_DIR"

if [ ! -d ".venv" ]; then
    echo "Creating Python venv..."
    python3 -m venv .venv
    .venv/bin/pip install -q fastapi uvicorn httpx pillow moviepy pydantic
fi

.venv/bin/python main.py &
CLAUDE_PROXY_PID=$!
sleep 2

# Verify claude-proxy started
if ! curl -s http://localhost:7001/ > /dev/null 2>&1; then
    echo -e "${RED}Failed to start claude-proxy backend${NC}"
    exit 1
fi
echo -e "${GREEN}✓ Claude Proxy running on http://localhost:7001${NC}"

# Start Frontend (port 5173)
echo -e "${YELLOW}Starting Frontend on port 5173...${NC}"
cd "$FRONTEND_DIR"

if [ ! -d "node_modules" ]; then
    echo "Installing frontend dependencies..."
    pnpm install
fi

pnpm dev &
FRONTEND_PID=$!
sleep 3

# Verify frontend started
if ! curl -s http://localhost:5173/ > /dev/null 2>&1; then
    echo -e "${RED}Failed to start frontend${NC}"
    exit 1
fi
echo -e "${GREEN}✓ Frontend running on http://localhost:5173${NC}"

echo ""
echo -e "${GREEN}════════════════════════════════════════${NC}"
echo -e "${GREEN}All services started successfully!${NC}"
echo ""
echo -e "  Frontend:      ${GREEN}http://localhost:5173${NC}"
echo -e "  Claude Proxy:  ${GREEN}http://localhost:7001${NC}"
echo ""
echo -e "  Live Editor:   ${GREEN}http://localhost:5173${NC} → Live Editor tab"
echo ""
echo -e "${YELLOW}Press Ctrl+C to stop all services${NC}"
echo -e "${GREEN}════════════════════════════════════════${NC}"

# Wait for any process to exit
wait
