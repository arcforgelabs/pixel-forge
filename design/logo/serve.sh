#!/usr/bin/env bash
# Serve the Tromino Forge editor from repo root so its <script> tags can reach
# packages/logo-forge-core/index.js. The editor imports its algorithm from the
# package, so a design/logo/-scoped server will 404 on the core script.
#
# Usage: ./design/logo/serve.sh [PORT]
#   PORT defaults to 8923 to match the existing Pixel Forge preview alias.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${HERE}/../.." && pwd)"
PORT="${1:-8923}"

cd "${REPO_ROOT}"
echo "Tromino Forge editor: http://localhost:${PORT}/design/logo/tromino-forge.html"
exec python3 -m http.server "${PORT}"
