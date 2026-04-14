#!/usr/bin/env bash
# Uninstall Pixel Forge.
#
# Usage: ./uninstall.sh [--remove-state] [--yes] [--keep-legacy]
#
#   --remove-state   Also delete ~/.pixel-forge (DB, instances, managed browser, skills).
#                    Default: preserve state so reinstall resumes where you left off.
#   --yes            Skip interactive confirmation for the state-dir prompt.
#   --keep-legacy    Skip cleanup of legacy -alpha binaries/services/state.
#                    Default: remove any surviving -alpha artifacts.

set -u

REMOVE_STATE=0
ASSUME_YES=0
KEEP_LEGACY=0
for arg in "$@"; do
    case "$arg" in
        --remove-state) REMOVE_STATE=1 ;;
        --yes|-y)       ASSUME_YES=1 ;;
        --keep-legacy)  KEEP_LEGACY=1 ;;
        -h|--help)
            sed -n '2,10p' "$0"
            exit 0
            ;;
        *) echo "uninstall: unknown flag: $arg" >&2; exit 2 ;;
    esac
done

BIN_DIR="$HOME/.local/bin"
LIB_DIR="$HOME/.local/lib"
APPS_DIR="$HOME/.local/share/applications"
SYSD_DIR="$HOME/.config/systemd/user"
STATE_DIR="$HOME/.pixel-forge"

CURRENT_BINS=(pixel-forge pixel-forge-shell pixel-forge-agent-deck)
CURRENT_DESKTOPS=(pixel-forge.desktop pixel-forge-agent-deck.desktop)
CURRENT_UNIT="pixel-forge.service"

LEGACY_BINS=(pixel-forge-alpha pixel-forge-alpha-shell pixel-forge-agent-deck-alpha)
LEGACY_DESKTOPS=(pixel-forge-alpha.desktop pixel-forge-agent-deck-alpha.desktop)
LEGACY_UNIT="pixel-forge-alpha.service"
LEGACY_STATE="$HOME/.pixel-forge-alpha"

removed_any=0

stop_unit() {
    local unit="$1"
    if systemctl --user list-unit-files "$unit" 2>/dev/null | grep -q "^$unit"; then
        systemctl --user stop "$unit" 2>/dev/null || true
        systemctl --user disable "$unit" 2>/dev/null || true
        rm -f "$SYSD_DIR/$unit"
        echo "removed systemd unit: $unit"
        removed_any=1
    fi
}

remove_file() {
    if [ -e "$1" ] || [ -L "$1" ]; then
        rm -f "$1"
        echo "removed: $1"
        removed_any=1
    fi
}

remove_dir() {
    if [ -d "$1" ]; then
        rm -rf "$1"
        echo "removed: $1/"
        removed_any=1
    fi
}

echo "==> stopping services"
stop_unit "$CURRENT_UNIT"
[ "$KEEP_LEGACY" = "0" ] && stop_unit "$LEGACY_UNIT"

echo "==> removing binaries"
for bin in "${CURRENT_BINS[@]}"; do remove_file "$BIN_DIR/$bin"; done
if [ "$KEEP_LEGACY" = "0" ]; then
    for bin in "${LEGACY_BINS[@]}"; do remove_file "$BIN_DIR/$bin"; done
fi

echo "==> removing desktop entries"
for d in "${CURRENT_DESKTOPS[@]}"; do remove_file "$APPS_DIR/$d"; done
if [ "$KEEP_LEGACY" = "0" ]; then
    for d in "${LEGACY_DESKTOPS[@]}"; do remove_file "$APPS_DIR/$d"; done
fi

echo "==> removing install directories"
remove_dir "$LIB_DIR/pixel-forge"
if [ "$KEEP_LEGACY" = "0" ]; then
    remove_dir "$LIB_DIR/pixel-forge-alpha"
    remove_dir "$LIB_DIR/pixel-forge-alpha.rollback"
fi

systemctl --user daemon-reload 2>/dev/null || true

if [ "$REMOVE_STATE" = "1" ]; then
    if [ -d "$STATE_DIR" ]; then
        if [ "$ASSUME_YES" != "1" ]; then
            size=$(du -sh "$STATE_DIR" 2>/dev/null | cut -f1)
            printf "Delete state dir %s (%s)? [y/N] " "$STATE_DIR" "$size"
            read -r answer
            case "$answer" in
                y|Y|yes|YES) ;;
                *) echo "keeping state dir."; STATE_SKIPPED=1 ;;
            esac
        fi
        if [ "${STATE_SKIPPED:-0}" != "1" ]; then
            rm -rf "$STATE_DIR"
            echo "removed state: $STATE_DIR"
            removed_any=1
        fi
    fi
    if [ "$KEEP_LEGACY" = "0" ] && [ -d "$LEGACY_STATE" ]; then
        rm -rf "$LEGACY_STATE"
        echo "removed legacy state: $LEGACY_STATE"
        removed_any=1
    fi
fi

if [ "$removed_any" = "0" ]; then
    echo "nothing to uninstall."
else
    echo "uninstall complete."
    [ "$REMOVE_STATE" = "0" ] && [ -d "$STATE_DIR" ] && echo "state dir preserved at $STATE_DIR — pass --remove-state to delete."
fi
