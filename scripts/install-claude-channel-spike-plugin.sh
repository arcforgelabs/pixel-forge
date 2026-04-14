#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
plugin_src="${repo_root}/tools/claude-channel-spike"
plugin_cache_root="${HOME}/.claude/plugins/cache/arc-forge/pixel-forge-channel/0.0.1"
plugin_data_root="${HOME}/.claude/plugins/data/pixel-forge-channel-arc-forge"
marketplace_root="${HOME}/.claude/arc-forge-marketplace"
marketplace_plugins_root="${marketplace_root}/plugins"
settings_path="${HOME}/.claude/settings.json"
installed_plugins_path="${HOME}/.claude/plugins/installed_plugins.json"
known_marketplaces_path="${HOME}/.claude/plugins/known_marketplaces.json"

# Controller-update snapshots exclude .git, so fall back when git isn't usable.
# Override with PIXEL_FORGE_INSTALL_GIT_SHA when the caller knows the real commit.
git_sha="${PIXEL_FORGE_INSTALL_GIT_SHA:-$(git -C "${repo_root}" rev-parse HEAD 2>/dev/null || echo "unknown")}"
installed_at="$(date -u +%Y-%m-%dT%H:%M:%S.000Z)"

mkdir -p "${HOME}/.claude/plugins"
mkdir -p "${plugin_cache_root}"
rsync -a --delete "${plugin_src}/" "${plugin_cache_root}/"
mkdir -p "${plugin_data_root}"
mkdir -p "${marketplace_plugins_root}"

mkdir -p "${marketplace_plugins_root}/pixel-forge-channel"
rsync -a --delete "${plugin_cache_root}/" "${marketplace_plugins_root}/pixel-forge-channel/"

mkdir -p "${marketplace_root}/.claude-plugin"
python3 - "${marketplace_root}/.claude-plugin/marketplace.json" <<'PY'
import json
import pathlib
import sys

marketplace_json = pathlib.Path(sys.argv[1])
if marketplace_json.exists():
    data = json.loads(marketplace_json.read_text())
else:
    data = {
        "name": "arc-forge",
        "owner": {"name": "Samuel Rodda"},
        "plugins": [],
    }

plugins = data.setdefault("plugins", [])
plugins = [p for p in plugins if p.get("name") != "pixel-forge-channel"]
plugins.append(
    {
        "name": "pixel-forge-channel",
        "version": "0.0.1",
        "source": "./plugins/pixel-forge-channel",
        "category": "development",
        "description": "Local Pixel Forge channel ingress spike plugin.",
    }
)
data["plugins"] = plugins
marketplace_json.write_text(json.dumps(data, indent=2) + "\n")
PY

python3 - "${known_marketplaces_path}" "${marketplace_root}" "${installed_at}" <<'PY'
import json
import pathlib
import sys

known_marketplaces_path = pathlib.Path(sys.argv[1])
marketplace_root = sys.argv[2]
installed_at = sys.argv[3]

if known_marketplaces_path.exists():
    data = json.loads(known_marketplaces_path.read_text())
else:
    data = {}

data["arc-forge"] = {
    "source": {
        "source": "directory",
        "path": marketplace_root,
    },
    "installLocation": marketplace_root,
    "lastUpdated": installed_at,
    "autoUpdate": True,
}

known_marketplaces_path.write_text(json.dumps(data, indent=2) + "\n")
PY

python3 - "${settings_path}" <<'PY'
import json
import pathlib
import sys

settings_path = pathlib.Path(sys.argv[1])
if settings_path.exists():
    data = json.loads(settings_path.read_text())
else:
    data = {}
enabled = data.setdefault("enabledPlugins", {})
enabled["pixel-forge-channel@arc-forge"] = True
settings_path.write_text(json.dumps(data, indent=2) + "\n")
PY

python3 - "${installed_plugins_path}" "${plugin_cache_root}" "${installed_at}" "${git_sha}" <<'PY'
import json
import pathlib
import sys

installed_plugins_path = pathlib.Path(sys.argv[1])
install_path = sys.argv[2]
installed_at = sys.argv[3]
git_sha = sys.argv[4]

if installed_plugins_path.exists():
    data = json.loads(installed_plugins_path.read_text())
else:
    data = {"version": 1, "plugins": {}}
plugins = data.setdefault("plugins", {})
plugins["pixel-forge-channel@arc-forge"] = [
    {
        "scope": "user",
        "installPath": install_path,
        "version": "0.0.1",
        "installedAt": installed_at,
        "lastUpdated": installed_at,
        "gitCommitSha": git_sha,
    }
]
installed_plugins_path.write_text(json.dumps(data, indent=2) + "\n")
PY

echo "Installed pixel-forge-channel plugin to ${plugin_cache_root}"
echo "Prepared plugin data dir: ${plugin_data_root}"
echo "Prepared local marketplace: ${marketplace_root}"
echo "Enabled plugin key: pixel-forge-channel@arc-forge"
echo "Registered marketplace key: arc-forge"
echo "Development launch: claude --dangerously-load-development-channels plugin:pixel-forge-channel@arc-forge"
