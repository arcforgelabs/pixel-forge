# Architecture

## Intent

Pixel Forge must be the control surface for visually editing a real running app. That means one project-level chat, one shared selected-element context, and a browser surface that is real enough for localhost dev apps and hostile third-party sites alike.

## Current Reality

```text
FastAPI service
  -> serves the built React frontend
  -> brokers Live Editor requests into Agent Deck
  -> persists projects/sessions in SQLite
  -> writes request packs into the target workspace

React frontend (apps/web)
  -> owns project selection, chat, selected elements, preview tab strip
  -> can launch a sibling Pixel Forge target runtime for self-editing
  -> treats the native shell as the only supported Live Editor preview runtime
  -> exposes a browser-only fallback only as a debug/service surface, not as product-equivalent preview

Agent Deck
  -> persistent agent runtime per Live Editor thread
```

Truth:
- The desktop shell is the product path.
- A plain web app cannot embed a real Chromium tab surface for arbitrary third-party sites or faithful localhost self-edit targets.
- Proxying or iframe tricks are not a durable answer for auth-heavy sites, HMR-heavy localhost apps, or sibling-instance self-edit flows.

## Transition Architecture

```text
Pixel Forge Desktop Shell (apps/desktop)
  -> BrowserWindow loads the existing Pixel Forge UI
  -> WebContentsView surfaces map 1:1 to Pixel Forge preview tabs
  -> preload script injects selection overlays into the real page
  -> preview events flow back into the React app

Pixel Forge UI (apps/web)
  -> remains the product chrome: tab strip, toolbar, chat, Elements pane
  -> can spawn a sibling Pixel Forge target runtime from the bound workspace
  -> owns the shared selection list and request-pack tunnel metadata
  -> measures the preview pane bounds
  -> tells the shell which preview tab is active and where the native browser surface should mount

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
  -> runs its own FastAPI + Vite stack on isolated localhost ports
  -> gets its own SQLite state root and managed-browser profile path
  -> renders inside the controller preview like any other localhost app
  -> stays visually faithful, but suppresses controller-first startup blocking

FastAPI backend (apps/api)
  -> remains the broker/state plane
  -> launches sibling Pixel Forge targets on demand
  -> persists projects/sessions/request packs
  -> may keep compatibility preview code internally, but the product surface routes preview through the shell
```

This is the current build direction.

## Ideal Target

```text
Native Pixel Forge shell
  -> embedded Chromium is the default preview runtime for all URLs
  -> localhost and remote sites share one browser model
  -> one project chat can compare multiple live tabs without opening external browser windows
  -> one controller instance can launch and inspect sibling target instances for self-editing

FastAPI backend
  -> agent orchestration
  -> durable state
  -> request-pack generation
  -> file writes and repo operations

Agent Deck
  -> persistent coding session
```

In the ideal shape, the proxy path disappears from the user-facing preview workflow entirely.

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

### Sibling Target Layer
- Isolated localhost target runtime for self-editing
- Separate API/web ports
- Separate DB and browser-profile state
- Target-mode UI guardrails

### Backend Broker Layer
- Project/session persistence
- Request packs
- Selection tunnel API/CLI surface
- Live Editor dispatch into Agent Deck
- Generated file writes

## Non-Goals

- Pretending the browser-only web app can become a full embedded Chromium host
- Treating the proxy path as a product-equivalent answer for localhost or third-party preview
- Rebuilding Agent Deck inside Pixel Forge
