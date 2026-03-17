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
  -> still has a browser-only fallback path:
       localhost/private URLs -> proxy iframe
       remote URLs -> backend-managed Chrome session or native shell when present

Agent Deck
  -> persistent agent runtime per Live Editor thread
```

Truth:
- The existing browser-only app can keep working for localhost and simple flows.
- A plain web app cannot embed a real Chromium tab surface for arbitrary third-party sites.
- Proxying or iframe tricks are not a durable answer for auth-heavy sites like Claude or Google.

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
  -> measures the preview pane bounds
  -> tells the shell which preview tab is active and where the native browser surface should mount

Sibling target runtime
  -> runs its own FastAPI + Vite stack on isolated localhost ports
  -> gets its own SQLite state root and managed-browser profile path
  -> renders inside the controller preview like any other localhost app
  -> stays visually faithful, but suppresses controller-first startup blocking

FastAPI backend (apps/api)
  -> remains the broker/state plane
  -> launches sibling Pixel Forge targets on demand
  -> persists projects/sessions/request packs
  -> keeps web fallback preview support for non-shell usage
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

In the ideal shape, the proxy path becomes a compatibility fallback, not the core preview architecture.

## Layer Ownership

### Product Chrome
- Project/session state
- Preview tab strip
- Shared selection list
- Chat UI
- Request dispatch controls

### Native Browser Layer
- Real page loading
- Cookies/storage/service workers
- Login/auth flows
- Tab-local DOM state and history
- Selection overlay injection into the live page

### Sibling Target Layer
- Isolated localhost target runtime for self-editing
- Separate API/web ports
- Separate DB and browser-profile state
- Target-mode UI guardrails

### Backend Broker Layer
- Project/session persistence
- Request packs
- Live Editor dispatch into Agent Deck
- Generated file writes

## Non-Goals

- Pretending the browser-only web app can become a full embedded Chromium host
- Treating the proxy path as the long-term answer for third-party authenticated sites
- Rebuilding Agent Deck inside Pixel Forge
