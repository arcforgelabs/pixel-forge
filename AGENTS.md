# Pixel Forge - Agent Notes

- `SPECS.md` is repo truth. Update it before other docs when runtime reality changes.
- `ARCHITECTURE.md` is the only active repo-level architecture and operating doc. Move displaced material to `docs/archives/root-docs/`.
- Visible UI proof must use a maximized Pixel Forge shell or browser window. Fixed demo windows lie about the layout.
- If the install/update lane changes, clear and restage old pending controller updates instead of applying stale snapshots.
- `install.sh` is content-hash cached at `~/.cache/pixel-forge/install-cache/<instance_slug>/` and runs frontend/python/desktop in parallel. No-op reinstalls take ~2.5s. If a build result looks suspicious or you need to force a full rebuild, `rm -rf ~/.cache/pixel-forge/install-cache` before `./install.sh`. Never invoke `install.sh` a second time while one is still running — concurrent runs fight over `desktop/node_modules` and the electron download.
- Mirror runtimes cache under `<state_dir>/.build-cache/*.sha256`; clear that directory to force the workspace-layout mirror to rebuild its venv/frontend-dist.
