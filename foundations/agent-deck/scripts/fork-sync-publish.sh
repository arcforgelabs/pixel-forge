#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'USAGE'
Usage: ./scripts/fork-sync-publish.sh [options]

Sync workflow:
  1) Fast-forward local main from upstream/main
  2) Merge main into custom branch (keeps custom branch current)
  3) Run validation gates
  4) Publish workstation runtime layer and activate it

Options:
  --custom-branch <name>   Custom branch to keep all fork changes (default: current branch if not main)
  --main-branch <name>     Upstream-tracking branch (default: main)
  --deploy-main            Also merge custom branch back into main for local deployment workflows
  --no-tests               Skip go test + conductor audit checks
  --no-install             Skip ./dev-install.sh
  --skip-fetch             Skip git fetch from remotes
  -h, --help               Show this help
USAGE
}

die() {
  echo "ERROR: $*" >&2
  exit 1
}

require_clean_tree() {
  if [[ -n "$(git status --porcelain)" ]]; then
    die "working tree is not clean. Commit/stash changes first."
  fi
}

require_local_branch() {
  local branch="$1"
  if ! git show-ref --verify --quiet "refs/heads/${branch}"; then
    die "local branch '${branch}' not found"
  fi
}

require_remote_branch() {
  local remote="$1"
  local branch="$2"
  if ! git show-ref --verify --quiet "refs/remotes/${remote}/${branch}"; then
    die "remote branch '${remote}/${branch}' not found (run fetch or verify remote)"
  fi
}

MAIN_BRANCH="main"
CUSTOM_BRANCH=""
DEPLOY_MAIN=0
RUN_TESTS=1
RUN_INSTALL=1
SKIP_FETCH=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    --custom-branch)
      [[ $# -ge 2 ]] || die "--custom-branch requires a value"
      CUSTOM_BRANCH="$2"
      shift 2
      ;;
    --main-branch)
      [[ $# -ge 2 ]] || die "--main-branch requires a value"
      MAIN_BRANCH="$2"
      shift 2
      ;;
    --deploy-main)
      DEPLOY_MAIN=1
      shift
      ;;
    --no-tests)
      RUN_TESTS=0
      shift
      ;;
    --no-install)
      RUN_INSTALL=0
      shift
      ;;
    --skip-fetch)
      SKIP_FETCH=1
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      die "unknown option: $1"
      ;;
  esac
done

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
cd "$REPO_DIR"

if ! git rev-parse --git-dir >/dev/null 2>&1; then
  die "not inside a git repository"
fi

START_BRANCH="$(git rev-parse --abbrev-ref HEAD)"
if [[ -z "$CUSTOM_BRANCH" ]]; then
  if [[ "$START_BRANCH" == "$MAIN_BRANCH" ]]; then
    die "on ${MAIN_BRANCH}; pass --custom-branch explicitly"
  fi
  CUSTOM_BRANCH="$START_BRANCH"
fi

[[ "$CUSTOM_BRANCH" != "$MAIN_BRANCH" ]] || die "custom branch cannot be the same as main branch"

require_clean_tree
require_local_branch "$MAIN_BRANCH"
require_local_branch "$CUSTOM_BRANCH"

if [[ $SKIP_FETCH -eq 0 ]]; then
  git fetch upstream "$MAIN_BRANCH"
  git fetch origin "$MAIN_BRANCH" || true
fi

require_remote_branch "upstream" "$MAIN_BRANCH"

echo "==> Syncing ${MAIN_BRANCH} with upstream/${MAIN_BRANCH}"
git switch "$MAIN_BRANCH"
git merge --ff-only "upstream/${MAIN_BRANCH}"

echo "==> Merging ${MAIN_BRANCH} into ${CUSTOM_BRANCH}"
git switch "$CUSTOM_BRANCH"
git merge --no-edit "$MAIN_BRANCH"

if [[ $RUN_TESTS -eq 1 ]]; then
  echo "==> Running tests"
  go test ./internal/session ./internal/update ./cmd/agent-deck
  ./resources/specs/audit-conductor-control-plane-minimal.sh
fi

if [[ $RUN_INSTALL -eq 1 ]]; then
  echo "==> Publishing workstation runtime layer"
  ./dev-install.sh
fi

if [[ $DEPLOY_MAIN -eq 1 ]]; then
  echo "==> Merging ${CUSTOM_BRANCH} into ${MAIN_BRANCH} (--deploy-main)"
  git switch "$MAIN_BRANCH"
  git merge --no-ff --no-edit "$CUSTOM_BRANCH"
fi

git switch "$START_BRANCH" >/dev/null 2>&1 || true

echo ""
echo "Sync complete"
echo "  main branch:   ${MAIN_BRANCH}"
echo "  custom branch: ${CUSTOM_BRANCH}"
if [[ $DEPLOY_MAIN -eq 1 ]]; then
  echo "  deployment:    ${MAIN_BRANCH} includes ${CUSTOM_BRANCH}"
else
  echo "  deployment:    workstation layer published from ${CUSTOM_BRANCH}"
fi
echo ""
echo "Next steps (optional):"
echo "  git push origin ${MAIN_BRANCH}"
echo "  git push origin ${CUSTOM_BRANCH}"
echo "  agent-deck-layers status"
