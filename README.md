# Pixel Forge

Visual app editor with screenshot bootstrap and live editing, backed by an integrated Agent Deck runtime.

## Install (Ubuntu, one command)

```bash
curl -fsSL https://raw.githubusercontent.com/IAMSamuelRodda/pixel-forge/master/scripts/quick-install.sh | bash
```

The installer checks for `node` (>=20), `python3` (>=3.11), `pnpm`, `uv`, and `go` (>=1.24); it prompts before installing any missing prereqs. Set `PIXEL_FORGE_UNATTENDED=1` to skip prompts.

Retired `pixel-forge-alpha` / `pixel-forge-workstation-v2` install env overrides are ignored by default so a stale shell session cannot accidentally reinstall the old lane. Set `PIXEL_FORGE_INSTALL_ALLOW_RETIRED_LANE_ENV=1` only if you are intentionally reproducing a legacy install for investigation.

After install:

```bash
pixel-forge            # control the service (start/stop/open/status/logs)
pixel-forge-shell      # open the desktop shell
pixel-forge-agent-deck # open the Agent Deck terminal
```

To uninstall: run `./uninstall.sh` from the repo checkout (pass `--remove-state` to also wipe `~/.pixel-forge`).

## Active docs

- `SPECS.md` — intent, goals, requirements, proof status
- `ARCHITECTURE.md` — current system shape, operating lanes, next target release
- `AGENTS.md` — agent guardrails for working in this repo
- `CLAUDE.md` — Claude Code specific guardrails

Historical and displaced root docs live under `docs/archives/root-docs/`.

## Versioning

CalVer `YYYY.M.D` (stable), `YYYY.M.D-N` (same-day correction), `YYYY.M.D-beta.N` (prerelease). See `SPECS.md` REQ-S-014 / REQ-S-015.
