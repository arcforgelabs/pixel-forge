# Pixel Forge Installer

Public npm entrypoint for installing Pixel Forge from the canonical source repository.

## Linux

```bash
npx @iamsamuelrodda/pixel-forge
```

This runs the same source installer as the GitHub one-liner. It clones or updates the checkout at `~/.local/src/pixel-forge`, installs prerequisites when the platform installer supports that, then runs `./install.sh` from the checkout.

## Windows

```powershell
npx @iamsamuelrodda/pixel-forge
```

On Windows this launches `install-windows.ps1` from the source checkout. The Windows installer is early groundwork and currently prepares the checkout, builds the web assets, installs Python dependencies, and creates local launch scripts/Start Menu shortcuts.

## Environment

- `PIXEL_FORGE_REPO_URL`: source repository URL, default `https://github.com/arcforgelabs/pixel-forge.git`
- `PIXEL_FORGE_REF`: git ref, default `master`
- `PIXEL_FORGE_SRC`: source checkout path
- `PIXEL_FORGE_UNATTENDED=1`: skip supported installer prompts
