# Pixel Forge

Visual app editor with screenshot bootstrap and live editing for real running apps.

Status: early public-release groundwork. Linux is the primary install path today; Windows groundwork is in progress.

## Install

```bash
npx @iamsamuelrodda/pixel-forge
```

Linux source installer:

```bash
curl -fsSL https://raw.githubusercontent.com/arcforgelabs/pixel-forge/master/scripts/quick-install.sh | bash
```

Windows groundwork from a checkout:

```powershell
powershell -ExecutionPolicy Bypass -File .\install-windows.ps1
```

The Linux installer checks for `node` (>=20), `python3` (>=3.11), `pnpm`, `uv`, and `go` (>=1.24); it prompts before installing any missing prereqs. Set `PIXEL_FORGE_UNATTENDED=1` to skip prompts. The Windows installer currently prepares the checkout/runtime, builds web assets, installs Python dependencies, and creates local launchers/Start Menu shortcuts.

After install:

```bash
pixel-forge            # control the service (start/stop/open/status/logs)
pixel-forge-shell      # open the desktop shell
pixel-forge-agent-deck # open the Agent Deck terminal
```

To uninstall: run `./uninstall.sh` from the repo checkout (pass `--remove-state` to also wipe `~/.pixel-forge`).

Retired `pixel-forge-alpha` / `pixel-forge-workstation-v2` install env overrides are ignored by default by both `install.sh` and the installed `pixel-forge`, `pixel-forge-shell`, and `pixel-forge-agent-deck` launchers, so a stale shell session cannot accidentally reinstall or misroute runtime into the old lane. Set `PIXEL_FORGE_INSTALL_ALLOW_RETIRED_LANE_ENV=1` only if you are intentionally reproducing a legacy install for investigation.

## npm Packages

- `@iamsamuelrodda/pixel-forge`: public installer entrypoint.
- `@iamsamuelrodda/pixel-forge-sdk`: Node SDK for screenshot bootstrap workflows.

## Active docs

- `INTENT.md` — intent, goals, requirements, proof status
- `ARCHITECTURE.md` — current system shape, operating lanes, next target release
- `AGENTS.md` — agent guardrails for working in this repo
- `CLAUDE.md` — Claude Code specific guardrails

Historical and displaced root docs live under `docs/archives/root-docs/`.

## Versioning

CalVer `YYYY.M.D` (stable), `YYYY.M.D-N` (same-day correction), `YYYY.M.D-beta.N` (prerelease). See `INTENT.md` REQ-S-014 / REQ-S-015.
