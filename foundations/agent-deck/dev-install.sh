#!/usr/bin/env bash
# Build agent-deck from source and publish it into the local layered runtime.
#
# Usage:
#   ./dev-install.sh          # build + publish workstation lane + activate
#   ./dev-install.sh build    # build only (output: ./build/agent-deck)
#   ./dev-install.sh install  # publish existing build + activate

set -euo pipefail

REPO_DIR="$(cd "$(dirname "$0")" && pwd)"
BUILD_DIR="$REPO_DIR/build"
BINARY="agent-deck"

# Resolve Go 1.24+ (required by go.mod)
resolve_go() {
    for candidate in "$HOME/go-1.24/bin/go" "/usr/local/go/bin/go" "$(command -v go 2>/dev/null || true)"; do
        if [[ -n "$candidate" && -x "$candidate" ]]; then
            local ver
            ver=$("$candidate" version 2>/dev/null | grep -oP '1\.\d+' | head -1) || continue
            local minor="${ver#*.}"
            if [[ "$minor" -ge 24 ]] 2>/dev/null; then
                echo "$candidate"
                return 0
            fi
        fi
    done
    echo "ERROR: Go 1.24+ required. Found none." >&2
    echo "Install to ~/go-1.24:" >&2
    echo "  mkdir -p ~/go-1.24" >&2
    echo "  curl -sL https://go.dev/dl/go1.24.0.linux-amd64.tar.gz | tar -C ~/go-1.24 --strip-components=1 -xz" >&2
    return 1
}

do_build() {
    local go_bin
    go_bin=$(resolve_go)
    echo "go: $("$go_bin" version)"

    local version
    version=$(git -C "$REPO_DIR" describe --tags --always --dirty 2>/dev/null || echo "dev")

    mkdir -p "$BUILD_DIR"
    "$go_bin" build -ldflags "-X main.Version=$version" -o "$BUILD_DIR/$BINARY" ./cmd/agent-deck
    echo "built: $BUILD_DIR/$BINARY ($version)"
}

do_install() {
    if [[ ! -f "$BUILD_DIR/$BINARY" ]]; then
        echo "ERROR: no build at $BUILD_DIR/$BINARY — run './dev-install.sh build' first" >&2
        exit 1
    fi

    "$REPO_DIR/scripts/runtime-layers.sh" publish-workstation --activate --from-build "$BUILD_DIR/$BINARY"
    "$HOME/.local/bin/agent-deck" version 2>/dev/null || true
}

cd "$REPO_DIR"

case "${1:-all}" in
    build)   do_build ;;
    install) do_install ;;
    all)     do_build && do_install ;;
    *)       echo "Usage: $0 [build|install|all]" >&2; exit 1 ;;
esac
