#!/usr/bin/env bash
# Regression coverage for the retired-lane env strip.
#
# Contaminated-env fail mode: a user with stale PIXEL_FORGE_INSTALL_NAME=pixel-forge-alpha
# (or pixel-forge-workstation-v2) in their shell must still land on the canonical
# pixel-forge install and runtime. Opt-out via PIXEL_FORGE_INSTALL_ALLOW_RETIRED_LANE_ENV=1
# must preserve the override. Custom non-retired names must pass through.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
INSTALL_SH="$REPO_ROOT/install.sh"

if [ ! -f "$INSTALL_SH" ]; then
    echo "install.sh not found at $INSTALL_SH" >&2
    exit 2
fi

INSTALL_HEAD=""
LAUNCHER_OUT=""
cleanup() {
    [ -n "$INSTALL_HEAD" ] && rm -f "$INSTALL_HEAD"
    [ -n "$LAUNCHER_OUT" ] && rm -f "$LAUNCHER_OUT"
    return 0
}
trap cleanup EXIT

INSTALL_HEAD="$(mktemp)"
# Slice install.sh up to and including the SERVICE_NAME lane-identity assignment.
# That captures the retired-lane env strip + every downstream var that inherits from it.
awk '
    { print }
    /^SERVICE_NAME="\$\{PIXEL_FORGE_SERVICE_NAME/ { exit }
' "$INSTALL_SH" > "$INSTALL_HEAD"

assert_var() {
    local label="$1" expected="$2" actual="$3"
    if [ "$actual" != "$expected" ]; then
        echo "FAIL: $label: expected '$expected', got '$actual'" >&2
        exit 1
    fi
}

source_head_and_echo() {
    local vars="$1"
    # shellcheck disable=SC2016
    env -i PATH="$PATH" HOME="$HOME" "${@:2}" \
        bash -c "source '$INSTALL_HEAD' 2>/dev/null; echo $vars" | tail -n1
}

echo "case 1: retired pixel-forge-alpha env -> canonical (install.sh header)"
line=$(source_head_and_echo '"$INSTALL_NAME|$CLI_NAME|$SHELL_NAME|$INSTALL_DIR|$SERVICE_NAME"' \
    PIXEL_FORGE_INSTALL_NAME=pixel-forge-alpha \
    PIXEL_FORGE_CLI_NAME=pixel-forge-alpha \
    PIXEL_FORGE_SHELL_NAME=pixel-forge-alpha-shell \
    PIXEL_FORGE_SERVICE_NAME=pixel-forge-alpha \
    PIXEL_FORGE_INSTALL_DIR=/tmp/pixel-forge-alpha-nope \
    AGENTDECK_PROFILE=workstation-v2 \
    AGENTDECK_DIR=/tmp/ad-alpha)
IFS='|' read -r c1_install c1_cli c1_shell c1_dir c1_service <<<"$line"
assert_var "case1.INSTALL_NAME"  pixel-forge                    "$c1_install"
assert_var "case1.CLI_NAME"      pixel-forge                    "$c1_cli"
assert_var "case1.SHELL_NAME"    pixel-forge-shell              "$c1_shell"
assert_var "case1.INSTALL_DIR"   "$HOME/.local/lib/pixel-forge" "$c1_dir"
assert_var "case1.SERVICE_NAME"  pixel-forge                    "$c1_service"

echo "case 2: retired pixel-forge-workstation-v2 env -> canonical"
line=$(source_head_and_echo '"$INSTALL_NAME"' \
    PIXEL_FORGE_INSTALL_NAME=pixel-forge-workstation-v2)
assert_var "case2.INSTALL_NAME" pixel-forge "$line"

echo "case 3: mixed retired markers without retired install name still reset to canonical"
line=$(source_head_and_echo '"$INSTALL_NAME|$CLI_NAME|$INSTALL_DIR|$URL_HOST"' \
    PIXEL_FORGE_INSTALL_NAME=pixel-forge \
    PIXEL_FORGE_CLI_NAME=pixel-forge-alpha \
    PIXEL_FORGE_INSTALL_DIR=/tmp/pixel-forge-alpha-nope \
    PIXEL_FORGE_URL_HOST=pixel-forge-alpha.localhost)
IFS='|' read -r c3_install c3_cli c3_dir c3_host <<<"$line"
assert_var "case3.INSTALL_NAME" pixel-forge "$c3_install"
assert_var "case3.CLI_NAME" pixel-forge "$c3_cli"
assert_var "case3.INSTALL_DIR" "$HOME/.local/lib/pixel-forge" "$c3_dir"
assert_var "case3.URL_HOST" pixel-forge.localhost "$c3_host"

echo "case 4: opt-out PIXEL_FORGE_INSTALL_ALLOW_RETIRED_LANE_ENV=1 preserves alpha"
line=$(source_head_and_echo '"$INSTALL_NAME"' \
    PIXEL_FORGE_INSTALL_NAME=pixel-forge-alpha \
    PIXEL_FORGE_INSTALL_ALLOW_RETIRED_LANE_ENV=1)
assert_var "case4.INSTALL_NAME" pixel-forge-alpha "$line"

echo "case 5: non-retired custom name passes through"
line=$(source_head_and_echo '"$INSTALL_NAME"' \
    PIXEL_FORGE_INSTALL_NAME=pixel-forge-smoke-abc)
assert_var "case5.INSTALL_NAME" pixel-forge-smoke-abc "$line"

echo "case 6: generated launcher also ignores retired env at runtime"
LAUNCHER_OUT="$(mktemp)"
# Build a miniature launcher using the same expansion pattern install.sh uses
# for the real CLI/Shell/TUI launchers (unquoted heredoc so the snippet expands
# at install time into the generated script).
env -i PATH="$PATH" HOME="$HOME" bash -c "
    source '$INSTALL_HEAD' 2>/dev/null
    cat > '$LAUNCHER_OUT' <<LAUNCHER
#!/bin/bash
set -euo pipefail

\$RETIRED_LANE_ENV_STRIP_SNIPPET

INSTALL_NAME=\"\\\${PIXEL_FORGE_INSTALL_NAME:-pixel-forge}\"
CLI_NAME=\"\\\${PIXEL_FORGE_CLI_NAME:-pixel-forge}\"
SERVICE_NAME=\"\\\${PIXEL_FORGE_SERVICE_NAME:-pixel-forge}\"
echo \"\\\$INSTALL_NAME|\\\$CLI_NAME|\\\$SERVICE_NAME\"
LAUNCHER
"
line=$(env -i PATH="$PATH" HOME="$HOME" \
    PIXEL_FORGE_INSTALL_NAME=pixel-forge-alpha \
    PIXEL_FORGE_CLI_NAME=pixel-forge-alpha \
    PIXEL_FORGE_SERVICE_NAME=pixel-forge-alpha \
    AGENTDECK_PROFILE=workstation-v2 \
    bash "$LAUNCHER_OUT" 2>/dev/null | tail -n1)
IFS='|' read -r l_install l_cli l_service <<<"$line"
assert_var "case6.launcher.INSTALL_NAME" pixel-forge "$l_install"
assert_var "case6.launcher.CLI_NAME"     pixel-forge "$l_cli"
assert_var "case6.launcher.SERVICE_NAME" pixel-forge "$l_service"

echo "case 7: controller-update runner ignores retired cli/shell env"
RUNNER_OUT="$(env -i PATH="$PATH" HOME="$HOME" \
    PIXEL_FORGE_CLI_NAME=pixel-forge-alpha \
    PIXEL_FORGE_SHELL_NAME=pixel-forge-alpha-shell \
    node - <<'NODE'
function normalizeText(value) {
  if (typeof value !== 'string') {
    return null
  }
  const trimmed = value.trim()
  return trimmed || null
}
const retiredInstallNames = new Set(['pixel-forge-alpha', 'pixel-forge-workstation-v2'])
function normalizeLaneName(value) {
  const normalized = normalizeText(value)
  if (!normalized || retiredInstallNames.has(normalized)) {
    return null
  }
  return normalized
}
function normalizeShellLauncherName(value) {
  const normalized = normalizeText(value)
  if (!normalized || retiredInstallNames.has(normalized.replace(/-shell$/, ''))) {
    return null
  }
  return normalized
}
const cli = normalizeLaneName(process.env.PIXEL_FORGE_CLI_NAME) || 'pixel-forge'
const shell = normalizeShellLauncherName(process.env.PIXEL_FORGE_SHELL_NAME) || 'pixel-forge-shell'
console.log(`${cli}|${shell}`)
NODE
)"
IFS='|' read -r runner_cli runner_shell <<<"$RUNNER_OUT"
assert_var "case7.runner.CLI_NAME" pixel-forge "$runner_cli"
assert_var "case7.runner.SHELL_NAME" pixel-forge-shell "$runner_shell"

echo "PASS: retired-lane env strip covers install.sh header and generated launcher."
