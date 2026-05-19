#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"

export DISPLAY="${DISPLAY:-:99}"
export CI=true
export PIXEL_FORGE_INSTALL_SKIP_SYSTEMD="${PIXEL_FORGE_INSTALL_SKIP_SYSTEMD:-1}"
export PIXEL_FORGE_INSTALL_SKIP_DESKTOP_INTEGRATION="${PIXEL_FORGE_INSTALL_SKIP_DESKTOP_INTEGRATION:-0}"

if command -v ubuntu-ui-test-display >/dev/null 2>&1; then
  ubuntu-ui-test-display >/dev/null
fi

node --version
pnpm --version
python3 --version
go version

pnpm install --frozen-lockfile
pnpm check:version
pnpm check:shell
pnpm check:api
pnpm check:desktop
pnpm --dir apps/web test -- --run src/store/session-store.test.ts src/components/live-editor/store/chat-store.test.ts
pnpm smoke:install
pnpm smoke:gui
pnpm smoke:installed-gui-provider-matrix
