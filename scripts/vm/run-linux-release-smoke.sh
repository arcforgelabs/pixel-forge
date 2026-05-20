#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"

export CI=true
export PIXEL_FORGE_INSTALL_SKIP_SYSTEMD="${PIXEL_FORGE_INSTALL_SKIP_SYSTEMD:-1}"
export PIXEL_FORGE_INSTALL_SKIP_DESKTOP_INTEGRATION="${PIXEL_FORGE_INSTALL_SKIP_DESKTOP_INTEGRATION:-0}"
export PIXEL_FORGE_SMOKE_GUI_LAUNCH="${PIXEL_FORGE_SMOKE_GUI_LAUNCH:-1}"
export PIXEL_FORGE_SMOKE_UI_WAIT_MS="${PIXEL_FORGE_SMOKE_UI_WAIT_MS:-60000}"
export PUPPETEER_SKIP_DOWNLOAD="${PUPPETEER_SKIP_DOWNLOAD:-true}"
export PUPPETEER_SKIP_CHROME_DOWNLOAD="${PUPPETEER_SKIP_CHROME_DOWNLOAD:-true}"

ARTIFACT_DIR="${PIXEL_FORGE_VM_SMOKE_ARTIFACT_DIR:-$ROOT/state/vm-smoke-artifacts/$(date -u +%Y%m%dT%H%M%SZ)}"
mkdir -p "$ARTIFACT_DIR"

capture_screenshot() {
  local name="$1"
  if command -v scrot >/dev/null 2>&1 && [[ -n "${DISPLAY:-}" ]]; then
    scrot "$ARTIFACT_DIR/$name.png" >/dev/null 2>&1 || true
  fi
}

finish() {
  local status=$?
  capture_screenshot "final"
  printf '[pixel-forge-vm-smoke] artifacts: %s\n' "$ARTIFACT_DIR"
  exit "$status"
}
trap finish EXIT

if [[ "${PIXEL_FORGE_VM_HEADLESS:-0}" == "1" ]]; then
  export DISPLAY="${DISPLAY:-:99}"
  if command -v ubuntu-ui-test-display >/dev/null 2>&1; then
    ubuntu-ui-test-display >/dev/null
  fi
elif [[ -r /run/user/1000/gdm/Xauthority ]]; then
  export DISPLAY="${DISPLAY:-:0}"
  export XAUTHORITY="${XAUTHORITY:-/run/user/1000/gdm/Xauthority}"
  export DBUS_SESSION_BUS_ADDRESS="${DBUS_SESSION_BUS_ADDRESS:-unix:path=/run/user/1000/bus}"
  if command -v ubuntu-ui-test-resize >/dev/null 2>&1; then
    ubuntu-ui-test-resize "${PIXEL_FORGE_VM_DESKTOP_MODE:-1920x1080}" || true
  fi
else
  export DISPLAY="${DISPLAY:-:99}"
  if command -v ubuntu-ui-test-display >/dev/null 2>&1; then
    ubuntu-ui-test-display >/dev/null
  fi
fi

node --version
pnpm --version
python3 --version
go version

if ! command -v rg >/dev/null 2>&1; then
  sudo env DEBIAN_FRONTEND=noninteractive apt-get update
  sudo env DEBIAN_FRONTEND=noninteractive apt-get install -y ripgrep
fi

capture_screenshot "00-desktop-ready"

pnpm install --frozen-lockfile
pnpm check:version
pnpm check:shell
pnpm check:api
pnpm check:desktop
pnpm --dir apps/web test -- --run src/store/session-store.test.ts src/components/live-editor/store/chat-store.test.ts
pnpm smoke:install
pnpm smoke:gui
capture_screenshot "10-after-gui-smoke"
pnpm smoke:installed-gui-provider-matrix
capture_screenshot "20-after-provider-matrix"
