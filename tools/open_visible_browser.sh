#!/bin/bash

set -euo pipefail

URL="${1:-http://pixel-forge.localhost:5173}"
TITLE_PATTERN="${2:-Pixel Forge|pixel-forge.localhost}"

if [ -z "${DISPLAY:-}" ] && [ -z "${WAYLAND_DISPLAY:-}" ]; then
    echo "No GUI display detected; skipping visible browser launch."
    exit 0
fi

BROWSER_CMD=""
for candidate in google-chrome google-chrome-stable chromium chromium-browser; do
    if command -v "$candidate" >/dev/null 2>&1; then
        BROWSER_CMD="$candidate"
        break
    fi
done

if [ -z "$BROWSER_CMD" ]; then
    echo "No supported browser command found; skipping visible browser launch."
    exit 0
fi

"$BROWSER_CMD" --new-window --start-maximized "$URL" >/dev/null 2>&1 &

if command -v xdotool >/dev/null 2>&1 && [ -n "${DISPLAY:-}" ]; then
    for _ in $(seq 1 20); do
        sleep 0.5
        WINDOW_ID="$(xdotool search --onlyvisible --name "$TITLE_PATTERN" 2>/dev/null | tail -n 1 || true)"
        if [ -z "$WINDOW_ID" ]; then
            continue
        fi

        SCREEN_GEOMETRY="$(xdotool getdisplaygeometry)"
        SCREEN_W="${SCREEN_GEOMETRY%% *}"
        SCREEN_H="${SCREEN_GEOMETRY##* }"
        xdotool windowactivate --sync "$WINDOW_ID" >/dev/null 2>&1 || true
        xdotool windowraise "$WINDOW_ID" >/dev/null 2>&1 || true
        xdotool windowmove "$WINDOW_ID" 0 0 >/dev/null 2>&1 || true
        xdotool windowsize "$WINDOW_ID" "$SCREEN_W" "$SCREEN_H" >/dev/null 2>&1 || true
        break
    done
fi

echo "Opened Pixel Forge in a maximized browser window: $URL"
