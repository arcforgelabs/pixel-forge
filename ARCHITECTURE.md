# Architecture

## Runtime

```text
Browser
  -> apps/web
       -> ws://pixel-forge.localhost:7001/generate-code
       -> ws://pixel-forge.localhost:7001/ws/live-editor
       -> http://pixel-forge.localhost:7001/config/app-proxy (credentialed)
       -> http://pixel-forge.localhost:7001/save-code

apps/api
  -> screenshot bootstrap prompt pipeline
  -> app proxy with injected selection script
  -> browser-scoped proxy session cookie
  -> per-session upstream cookie jar + target URL
  -> live-editor thread store
  -> request-pack writer (.pixel-forge/requests/<request-id>)
  -> Agent Deck session bridge for live-edit requests
  -> real file writes into the target project

Agent Deck
  -> persistent Claude session per live-editor thread
  -> visible/attachable session in Agent Deck
```

## Selection Context Path

```text
Target app in /app/ proxy
  -> injected selection script captures tag, id, classes, text, xpath, outerHTML
  -> proxied browser session carries a local proxy cookie
  -> apps/api replays upstream auth cookies from the per-session jar
  -> apps/web stores selected element state
  -> apps/web serializes <selected-element> context
  -> apps/api writes request pack on disk
  -> apps/api sends a short dispatch prompt into Agent Deck
  -> Claude reads the request pack and edits the real project
```

## State Boundary

```text
Target project
  -> .pixel-forge/requests/<request-id>/*
     request.md
     selected-elements.xml
     attachments/*

Pixel Forge local state
  -> live-editor thread metadata
     thread_id -> agent_deck_session_id -> claude_session_id
  -> proxy session metadata
     browser session cookie -> target_url -> upstream cookie jar
```

## Repo Boundary

```text
apps/api
  Canonical backend

apps/web
  Canonical frontend

packages/*
  Optional CLI/SDK adapters, not the product runtime

archive/*
  Archived integrations that are not part of the default product surface

tools/*
  Offline automation and evaluation helpers
```

## Non-Goals

- No nested frontend/backend product inside the repo
- No second web app pretending to be the primary runtime
- No duplicate backend path for the same live-edit workflow
