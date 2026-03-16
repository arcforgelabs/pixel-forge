# Pixel Forge

Pixel Forge is a visual editor for real running apps.

It has one product surface:
- `Screenshot` mode bootstraps UI from images.
- `Live Editor` loads a real app through the proxy, lets you click elements, writes a disk-backed request pack, and dispatches that context into a persistent Agent Deck session.

## Repo Shape

```text
pixel-forge/
  apps/
    api/        FastAPI backend, app proxy, Claude session manager
    web/        React + Vite UI
  packages/
    cli/        Optional bootstrap CLI adapter
    sdk-node/   Optional Node SDK adapter
  archive/
    adapters/   Archived non-default integrations
  tools/        Offline automation and evaluation scripts
```

## Run Locally

```bash
./start-dev.sh
```

That starts:
- `apps/api` on `http://pixel-forge.localhost:7001`
- `apps/web` on `http://pixel-forge.localhost:5173`

Open `http://pixel-forge.localhost:5173`.

## Live Editor Flow

1. Open Pixel Forge and bind a target workspace.
2. Optionally set a preview URL. This can be localhost, staging, production, or another website Pixel Forge can proxy.
3. Switch to `Live Editor`.
4. Load the preview target, select an element in the embedded app, and describe the change.
5. Pixel Forge writes `.pixel-forge/requests/<request-id>/...` inside the target workspace, then sends a short request to the Agent Deck session for that workspace.

## Authenticated Targets

- Pixel Forge now establishes a browser-scoped proxy session before the iframe loads.
- The app proxy keeps an upstream cookie jar per Pixel Forge browser session, so logins to staging or production targets survive subsequent proxied API requests.
- The frontend configures the proxy with credentialed backend requests, which is required for the proxy-session cookie to stick.

## Screenshot Output

- Scratch-generated output now defaults to `.pixel-forge/generated/` inside the bound workspace.
- Use a custom repo-relative path only when you want generated code to land in a tracked location.
- If no separate preview URL is configured, HTML-like scratch output can be reloaded through Pixel Forge's own saved-file preview route.

## Product Boundary

Pixel Forge is no longer a nested imported app. The canonical product is:
- `apps/web` for the UI
- `apps/api` for screenshot generation, app proxying, selection capture, request-pack brokering, and Agent Deck orchestration for Live Editor
- `packages/cli` and `packages/sdk-node` for non-runtime command surfaces

Archived integrations live outside the default product path under `archive/`.
Everything under `tools/` is secondary to the runtime.

## Current Docs

- `SPECS.md`
- `QUICK-START.md`
- `ARCHITECTURE.md`
- `VISION.md`
- `PROGRESS.md`

Older planning and migration-era docs were moved under `docs/archive/root-docs/`.
