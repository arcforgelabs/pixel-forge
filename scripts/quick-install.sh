#!/usr/bin/env bash
# One-command installer for Pixel Forge on Ubuntu.
#
# Usage:
#   curl -fsSL https://raw.githubusercontent.com/IAMSamuelRodda/pixel-forge/master/scripts/quick-install.sh | bash
#
# Environment:
#   PIXEL_FORGE_SRC        Clone target (default: $HOME/.local/src/pixel-forge).
#   PIXEL_FORGE_REF        Git ref to check out after clone (default: master).
#   PIXEL_FORGE_UNATTENDED If 1, skip all prompts and install missing prereqs automatically.
#   PIXEL_FORGE_SKIP_APP_INSTALL  If 1, only clone + bootstrap prereqs; do not run install.sh.

set -euo pipefail

REPO_URL="${PIXEL_FORGE_REPO_URL:-https://github.com/IAMSamuelRodda/pixel-forge.git}"
REF="${PIXEL_FORGE_REF:-master}"
SRC_DIR="${PIXEL_FORGE_SRC:-$HOME/.local/src/pixel-forge}"
UNATTENDED="${PIXEL_FORGE_UNATTENDED:-0}"

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

info()  { echo -e "${GREEN}==>${NC} $*"; }
warn()  { echo -e "${YELLOW}!!${NC}  $*"; }
error() { echo -e "${RED}error:${NC} $*" >&2; }

require_ubuntu() {
    if [ ! -r /etc/os-release ]; then
        error "Cannot read /etc/os-release. This installer supports Ubuntu only."
        exit 1
    fi
    # shellcheck disable=SC1091
    . /etc/os-release
    if [ "${ID:-}" != "ubuntu" ] && [[ "${ID_LIKE:-}" != *ubuntu* ]]; then
        error "This installer supports Ubuntu only. Detected: ID=${ID:-unknown} (${PRETTY_NAME:-unknown})."
        exit 1
    fi
}

confirm() {
    local prompt="$1"
    if [ "$UNATTENDED" = "1" ]; then
        info "(unattended) $prompt"
        return 0
    fi
    printf '%s [Y/n] ' "$prompt"
    read -r answer
    case "${answer:-y}" in
        y|Y|yes|YES) return 0 ;;
        *) return 1 ;;
    esac
}

sudo_cmd() {
    if [ "$(id -u)" = "0" ]; then
        "$@"
    else
        sudo "$@"
    fi
}

apt_install() {
    local pkgs=("$@")
    sudo_cmd apt-get update -y
    sudo_cmd apt-get install -y "${pkgs[@]}"
}

# --- Prereq: Node >= 20 ---
ensure_node() {
    if command -v node >/dev/null 2>&1; then
        local major
        major="$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)"
        if [ "$major" -ge 20 ] 2>/dev/null; then
            info "node $(node -v) OK"
            return 0
        fi
        warn "node $(node -v) is too old; need >= 20."
    else
        warn "node not found."
    fi

    if ! confirm "Install Node.js 20 via NodeSource apt?"; then
        error "Aborting: node is required."
        exit 1
    fi

    curl -fsSL https://deb.nodesource.com/setup_20.x | sudo_cmd -E bash -
    apt_install nodejs

    info "node $(node -v) installed"
}

# --- Prereq: Python 3.11+ with venv ---
ensure_python() {
    if command -v python3 >/dev/null 2>&1; then
        local ver
        ver="$(python3 -c 'import sys; print(f"{sys.version_info.major}.{sys.version_info.minor}")' 2>/dev/null || echo 0.0)"
        local major="${ver%%.*}"
        local minor="${ver#*.}"
        if [ "$major" -ge 3 ] 2>/dev/null && [ "$minor" -ge 11 ] 2>/dev/null; then
            info "python3 ${ver} OK"
            # still need venv support
            if ! python3 -m venv --help >/dev/null 2>&1; then
                warn "python3-venv missing; installing."
                if confirm "Install python3-venv via apt?"; then
                    apt_install "python${ver}-venv" || apt_install python3-venv
                fi
            fi
            return 0
        fi
        warn "python3 ${ver} is too old; need >= 3.11."
    else
        warn "python3 not found."
    fi

    if ! confirm "Install python3.11 and python3.11-venv via apt?"; then
        error "Aborting: python3 >= 3.11 is required."
        exit 1
    fi
    apt_install python3.11 python3.11-venv python3-pip
    sudo_cmd update-alternatives --install /usr/bin/python3 python3 /usr/bin/python3.11 1 2>/dev/null || true
    info "python3 $(python3 --version) installed"
}

# --- Prereq: pnpm ---
ensure_pnpm() {
    if command -v pnpm >/dev/null 2>&1; then
        info "pnpm $(pnpm --version) OK"
        return 0
    fi
    warn "pnpm not found."
    if ! confirm "Install pnpm via the official installer?"; then
        error "Aborting: pnpm is required."
        exit 1
    fi
    curl -fsSL https://get.pnpm.io/install.sh | SHELL="${SHELL:-/bin/bash}" bash -
    # shellcheck disable=SC1090,SC1091
    [ -f "$HOME/.bashrc" ] && . "$HOME/.bashrc" 2>/dev/null || true
    export PATH="$HOME/.local/share/pnpm:$PATH"
    if ! command -v pnpm >/dev/null 2>&1; then
        error "pnpm install finished but the binary is not on PATH yet."
        error "Open a new shell (to pick up ~/.local/share/pnpm on PATH) and re-run this installer."
        exit 1
    fi
    info "pnpm $(pnpm --version) installed"
}

# --- Prereq: uv ---
ensure_uv() {
    if command -v uv >/dev/null 2>&1; then
        info "uv $(uv --version) OK"
        return 0
    fi
    warn "uv not found."
    if ! confirm "Install uv via the Astral installer?"; then
        error "Aborting: uv is required."
        exit 1
    fi
    curl -LsSf https://astral.sh/uv/install.sh | sh
    export PATH="$HOME/.cargo/bin:$HOME/.local/bin:$PATH"
    if ! command -v uv >/dev/null 2>&1; then
        error "uv install finished but the binary is not on PATH yet."
        error "Open a new shell and re-run this installer."
        exit 1
    fi
    info "uv $(uv --version) installed"
}

# --- Prereq: Go >= 1.24 (for bundled Agent Deck build) ---
# apt often lags, so install from go.dev tarball to guarantee the version.
GO_MIN_MAJOR=1
GO_MIN_MINOR=24
GO_TARBALL_VERSION="1.24.2"

ensure_go() {
    if command -v go >/dev/null 2>&1; then
        local ver major minor
        ver="$(go version | awk '{print $3}' | sed 's/^go//')"
        major="${ver%%.*}"
        minor="$(echo "$ver" | awk -F. '{print $2}')"
        if [ "$major" -ge "$GO_MIN_MAJOR" ] 2>/dev/null && [ "$minor" -ge "$GO_MIN_MINOR" ] 2>/dev/null; then
            info "go ${ver} OK"
            return 0
        fi
        warn "go ${ver} is too old; need >= ${GO_MIN_MAJOR}.${GO_MIN_MINOR}."
    else
        warn "go not found (needed to build the bundled Agent Deck binary)."
    fi

    if ! confirm "Install Go ${GO_TARBALL_VERSION} from go.dev into ~/.local/go?"; then
        error "Aborting: Go >= ${GO_MIN_MAJOR}.${GO_MIN_MINOR} is required to build the Agent Deck binary."
        exit 1
    fi

    local arch
    case "$(uname -m)" in
        x86_64)  arch="amd64" ;;
        aarch64) arch="arm64" ;;
        *) error "Unsupported architecture $(uname -m) for Go install."; exit 1 ;;
    esac
    local tarball="go${GO_TARBALL_VERSION}.linux-${arch}.tar.gz"
    local url="https://go.dev/dl/${tarball}"
    local tmp
    tmp="$(mktemp -d)"
    info "Downloading ${url}"
    curl -fsSL -o "${tmp}/${tarball}" "$url"
    rm -rf "$HOME/.local/go"
    mkdir -p "$HOME/.local"
    tar -C "$HOME/.local" -xzf "${tmp}/${tarball}"
    rm -rf "$tmp"
    export PATH="$HOME/.local/go/bin:$PATH"
    if ! command -v go >/dev/null 2>&1; then
        error "Go tarball extracted but 'go' is not on PATH. Check $HOME/.local/go/bin."
        exit 1
    fi
    info "go $(go version | awk '{print $3}') installed to ~/.local/go"
    warn "Add ~/.local/go/bin to your PATH in your shell rc to use 'go' in new shells."
}

# --- Prereq: Claude Code + Codex CLIs ---
# Pixel Forge talks to Claude Code sessions via the pixel-forge-channel plugin,
# which install.sh registers into ~/.claude. Codex loads the same MCP server
# from ~/.codex/config.toml (mcp_servers). Both transports require their
# respective CLI binaries on PATH, so we install them here when missing.
ensure_claude_code() {
    if command -v claude >/dev/null 2>&1; then
        info "claude $(claude --version 2>/dev/null | head -n1) OK"
        return 0
    fi
    warn "claude (Claude Code CLI) not found."
    if ! confirm "Install Claude Code globally via npm (@anthropic-ai/claude-code)?"; then
        warn "Skipping Claude Code install; the pixel-forge-channel plugin will be registered but inert until you install it yourself."
        return 0
    fi
    sudo_cmd npm install -g @anthropic-ai/claude-code
    if ! command -v claude >/dev/null 2>&1; then
        error "npm install finished but 'claude' is not on PATH. Check your npm global prefix."
        exit 1
    fi
    info "claude $(claude --version 2>/dev/null | head -n1) installed"
}

ensure_codex() {
    if command -v codex >/dev/null 2>&1; then
        info "codex $(codex --version 2>/dev/null | head -n1) OK"
        return 0
    fi
    warn "codex (OpenAI Codex CLI) not found."
    if ! confirm "Install Codex globally via npm (@openai/codex)?"; then
        warn "Skipping Codex install; the pixel-forge-channel MCP entry will be registered but inert until you install it yourself."
        return 0
    fi
    sudo_cmd npm install -g @openai/codex
    if ! command -v codex >/dev/null 2>&1; then
        error "npm install finished but 'codex' is not on PATH. Check your npm global prefix."
        exit 1
    fi
    info "codex $(codex --version 2>/dev/null | head -n1) installed"
}

# --- Prereq: git + curl + build tools ---
ensure_base_tools() {
    local missing=()
    for t in git curl build-essential; do
        case "$t" in
            build-essential)
                # apt-only concept; check for cc
                command -v cc >/dev/null 2>&1 || missing+=("build-essential")
                ;;
            *)
                command -v "$t" >/dev/null 2>&1 || missing+=("$t")
                ;;
        esac
    done
    if [ "${#missing[@]}" -eq 0 ]; then
        info "git/curl/build tools OK"
        return 0
    fi
    warn "missing: ${missing[*]}"
    if ! confirm "Install ${missing[*]} via apt?"; then
        error "Aborting: ${missing[*]} required."
        exit 1
    fi
    apt_install "${missing[@]}"
}

# --- Clone repo ---
clone_repo() {
    if [ -d "$SRC_DIR/.git" ]; then
        info "Repo already cloned at $SRC_DIR; fetching latest."
        git -C "$SRC_DIR" fetch origin
        git -C "$SRC_DIR" checkout "$REF"
        git -C "$SRC_DIR" pull --ff-only origin "$REF"
        return 0
    fi
    if [ -e "$SRC_DIR" ]; then
        error "$SRC_DIR exists and is not a git clone. Move it aside or set PIXEL_FORGE_SRC."
        exit 1
    fi
    mkdir -p "$(dirname "$SRC_DIR")"
    info "Cloning $REPO_URL -> $SRC_DIR (ref: $REF)"
    git clone --branch "$REF" "$REPO_URL" "$SRC_DIR"
}

# --- Run the repo install.sh ---
run_install() {
    if [ "${PIXEL_FORGE_SKIP_APP_INSTALL:-0}" = "1" ]; then
        info "PIXEL_FORGE_SKIP_APP_INSTALL=1; stopping before ./install.sh."
        return 0
    fi
    info "Running ./install.sh in $SRC_DIR"
    ( cd "$SRC_DIR" && ./install.sh )
}

main() {
    info "Pixel Forge quick-install"
    require_ubuntu
    ensure_base_tools
    ensure_node
    ensure_python
    ensure_pnpm
    ensure_uv
    ensure_go
    ensure_claude_code
    ensure_codex
    clone_repo
    run_install
    cat <<EOF

${GREEN}Done.${NC}
Launch:
  ${GREEN}pixel-forge${NC}          # control the service (start/stop/open/status/logs)
  ${GREEN}pixel-forge-shell${NC}    # open the desktop shell
  ${GREEN}pixel-forge-agent-deck${NC}  # open the Agent Deck terminal
Repo checkout: ${SRC_DIR}
EOF
}

main "$@"
