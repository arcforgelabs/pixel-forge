#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
echo "warning: scripts/fork-sync-reinstall.sh is deprecated; use scripts/fork-sync-publish.sh" >&2
exec "${SCRIPT_DIR}/fork-sync-publish.sh" "$@"
