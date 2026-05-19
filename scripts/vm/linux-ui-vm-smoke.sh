#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
LOCAL_VM_LAB_ROOT="${LOCAL_VM_LAB_ROOT:-$HOME/repos/local-vm-lab}"
VM_SCRIPT="$LOCAL_VM_LAB_ROOT/scripts/ubuntu-ui-test.sh"
REMOTE_ROOT="${REMOTE_ROOT:-/opt/workspaces/pixel-forge}"

if [[ ! -x "$VM_SCRIPT" ]]; then
  echo "error: missing local-vm-lab Ubuntu UI VM manager at $VM_SCRIPT" >&2
  exit 1
fi

"$VM_SCRIPT" start
"$VM_SCRIPT" wait
"$VM_SCRIPT" sync "$ROOT" "$REMOTE_ROOT"
"$VM_SCRIPT" run "cd '$REMOTE_ROOT' && bash scripts/vm/run-linux-release-smoke.sh"
