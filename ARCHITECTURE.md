# Architecture

## Intent

Pixel Forge must be the control surface for visually editing a real running app, including Pixel Forge itself. That means one project-level chat, one shared selected-element context, and a browser surface that is real enough for localhost dev apps, hostile third-party sites, and recursive self-development.

## Core Tenet: Self-Development

Pixel Forge must be able to point back at isolated sibling instances of Pixel Forge and improve the real product by selecting and editing the real surface.

If the self-target differs materially from the controller UI, the architecture has failed. The user is then fixing a surrogate, not Pixel Forge.

Safety must live below the UI:
- isolated ports, DB roots, and browser profiles
- staged apply instead of mid-stream self-restart
- frozen update snapshots plus rollback
- backend/runtime policy interception for dangerous actions

Safety must not depend on front-end neutering of the very UI Pixel Forge is supposed to inspect and fix.

## Current Reality

```text
Installed controller runtime
  -> desktop shell + installed backend + built frontend
  -> the real product path the user is operating

Current sibling target runtime
  -> default path is now an isolated mirror runtime built from the workspace source
  -> serves a built frontend from an isolated dist path and runs on its own ports/state/profile
  -> keeps the dev/HMR lane available only as an explicit lower-fidelity path
  -> is closer to the controller, but nested shell capabilities inside mirror runtimes are still incomplete

Agent Deck
  -> persistent agent runtime per Live Editor thread
```

Truth:
- The desktop shell is the product path.
- A plain web app cannot embed a real Chromium tab surface for arbitrary third-party sites or faithful localhost self-edit targets.
- Proxying or iframe tricks are not a durable answer for auth-heavy sites, HMR-heavy localhost apps, or sibling-instance self-edit flows.
- The current architectural bug is no longer the default launch path. It is the remaining gap between a faithful mirror runtime and a fully shell-capable recursive mirror runtime inside that preview surface.

## Transition Architecture

```text
Pixel Forge Desktop Shell (apps/desktop)
  -> BrowserWindow loads the existing Pixel Forge UI
  -> WebContentsView surfaces map 1:1 to Pixel Forge preview tabs
  -> preload script injects selection overlays into the real page
  -> preview events flow back into the React app

Pixel Forge UI (apps/web)
  -> remains the product chrome: tab strip, toolbar, chat, Elements pane
  -> can spawn isolated sibling Pixel Forge runtimes from the bound workspace
  -> owns the shared selection list and request-pack tunnel metadata
  -> measures the preview pane bounds
  -> tells the shell which preview tab is active and where the native browser surface should mount

Mirror target runtime (required default self-edit path)
  -> isolated sibling Pixel Forge instance
  -> must preserve the same startup flows and UI semantics as the controller
  -> must allow recursive self-targeting when needed
  -> should differ from the controller only in runtime isolation and staged-update policy

Dev target runtime (optional advanced path)
  -> lower-fidelity HMR/dev-server lane for rapid iteration
  -> may be useful for debugging
  -> must not replace the mirror target as the default self-edit surface

Selection engine
  -> auto-detects DOM vs region selection based on the live preview substrate
  -> keeps durable selection ids and page/view identity
  -> reconciles overlays back onto the live DOM or surface when that view returns
  -> captures bounded visual evidence for spatial selections

Selection tunnel
  -> freezes selected state into request-pack artifacts on disk
  -> exposes that frozen state through a local API/CLI for the working agent
  -> lets the agent inspect Pixel Forge-forged selection context without replaying auth or navigation

Sibling target runtime
  -> today: default launch uses the mirror lane, not the dev/HMR lane
  -> target state must remain isolated from the controller
  -> target UI should converge toward a full mirror, not a target-flavored variant
  -> nested mirror runtimes still need shell-grade preview ownership/context routing to recurse indefinitely

FastAPI backend (apps/api)
  -> remains the broker/state plane
  -> launches sibling Pixel Forge targets on demand
  -> persists projects/sessions/request packs
  -> may keep compatibility preview code internally, but the product surface routes preview through the shell
```

This is the current build direction. The unresolved transition work is no longer "make mirror the default"; it is "make mirror runtimes fully shell-capable when Pixel Forge is running inside Pixel Forge."

## Ideal Target

```text
Native Pixel Forge shell
  -> embedded Chromium is the default preview runtime for all URLs
  -> localhost and remote sites share one browser model
  -> one project chat can compare multiple live tabs without opening external browser windows
  -> one controller instance can launch and inspect sibling mirror-target instances for self-editing

FastAPI backend
  -> agent orchestration
  -> durable state
  -> request-pack generation
  -> file writes and repo operations

Mirror target runtime
  -> isolated sibling Pixel Forge instance
  -> same user-facing startup flows, layout, and controls as the controller
  -> safe because isolation, staging, and rollback live underneath the UI
  -> can recurse into deeper self-targets when the user needs to inspect Pixel Forge inspecting Pixel Forge

Agent Deck
  -> persistent coding session
```

In the ideal shape, the proxy path disappears from the user-facing preview workflow entirely, and self-development uses a faithful mirror target by default rather than a special target-mode UI.

## Layer Ownership

### Product Chrome
- Project/session state
- Preview tab strip
- Shared selection list
- Chat UI
- Request dispatch controls
- Selection tunnel assembly

### Native Browser Layer
- Real page loading
- Cookies/storage/service workers
- Login/auth flows
- Tab-local DOM state and history
- Automatic DOM-vs-region selection overlay injection into the live page

### Runtime Isolation Layer
- Separate API/web ports
- Separate DB and browser-profile state
- Mirror-target lifecycle
- Frozen staged-update snapshots
- Rollback lane
- Policy interception for dangerous self-edit actions

### Backend Broker Layer
- Project/session persistence
- Request packs
- Selection tunnel API/CLI surface
- Live Editor dispatch into Agent Deck
- Generated file writes

## Non-Goals

- Pretending the browser-only web app can become a full embedded Chromium host
- Treating the proxy path as a product-equivalent answer for localhost or third-party preview
- Treating a front-end-neutered target mode as a sufficient self-edit architecture
- Rebuilding Agent Deck inside Pixel Forge
