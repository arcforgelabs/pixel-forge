# Intent

Make Pixel Forge the fastest way to visually edit a real running app while keeping the real agent runtime visible and controllable. Pixel Forge should own visual context assembly and request brokering, not a fake headless session layer.

# Goals

1. Live Editor sends selected-element context and attachments into a persistent real agent session without losing continuity on server restart.
2. Every live-edit request is inspectable and reproducible from a disk-backed request pack instead of giant pasted blobs or process memory.
3. Pixel Forge sessions show up in Agent Deck so the user can drop into the real session when the chat UI is not enough.
4. Users can pull visual context from multiple sources into one prompt — select elements from two different URLs and combine them as comparison/reference context for the agent.

# Requirements

## Root Requirements

### Runtime Truth
- `REQ-R-001:` Live Editor must run against a persistent Agent Deck session, not an in-process per-server-run Claude session manager.
- `REQ-R-002:` One Pixel Forge Live Editor thread maps to one persistent Agent Deck session until the user explicitly starts a fresh thread.
- `REQ-R-003:` Screenshot bootstrap may stay on the direct Claude CLI path until the Agent Deck-backed replacement is proven and faster.

### Context Transport
- `REQ-C-001:` Each Live Editor request must be written to a disk-backed request pack before it is sent to the agent runtime.
- `REQ-C-002:` Request packs must include the user request, selected-element context, and any attachments in readable files instead of inline prompt blobs.
- `REQ-C-003:` Request packs must be retained long enough to debug the current loop, then cleaned up automatically to avoid unbounded growth.

### Transparency
- `REQ-T-001:` Pixel Forge must surface the Agent Deck session identity it is using for a Live Editor thread.
- `REQ-T-002:` Pixel Forge must preserve chat streaming when possible by adapting the underlying agent transcript instead of falling back blindly to black-box waits.

## Support Requirements

### Repo and State
- `REQ-S-001:` Repo-level operational truth lives in `SPECS.md`; runtime notes in `AGENTS.md` and `CLAUDE.md` must agree with it.
- `REQ-S-002:` Pixel Forge broker metadata belongs in a small persistent store; bulky artifacts belong on disk outside that metadata path.
- `REQ-S-003:` Workspace binding, preview target selection, and generated-output destination must stay separate in the product model. Do not collapse them into one misleading "project" field.

### Git Hygiene
- `REQ-G-001:` Request packs created inside a target repo must not pollute the user’s normal git status.
- `REQ-G-002:` Scratch generated code defaults to `.pixel-forge/generated/` inside the bound workspace unless the user explicitly chooses a repo-relative output path.

### Preview Targets
- `REQ-P-001:` Live preview targets may be any URL Pixel Forge can proxy, not just localhost dev servers.
- `REQ-P-002:` Direct code edits still require a writable workspace even when the preview target is a remote or third-party website.
- `REQ-P-003:` Authenticated staging and production targets must keep login state inside Pixel Forge by binding each browser session to its own proxy target and upstream cookie jar.
- `REQ-P-004:` Proxy setup from the web app must use credentialed backend calls so the browser-scoped proxy session cookie is actually established before the iframe loads.

### Multi-Source Context
- `REQ-M-001:` The Live Editor must support two preview sources, each with independent element selection. An "Add Source" button reveals the second source.
- `REQ-M-002:` The viewer must offer three layout modes: single (default, one source full-width), tabbed (toggle between A and B), and split (A and B side by side).
- `REQ-M-003:` Each selected element must carry its source URL so the agent knows which site/app the element came from.
- `REQ-M-004:` The element context builder must group selections by source URL, wrapping each group in a `<source url="...">` block, so the agent can reason about cross-source comparisons.
- `REQ-M-005:` The proxy must serve two targets concurrently via separate path prefixes (`/app-a/`, `/app-b/`), each with its own upstream client and cookie jar.
- `REQ-M-006:` Single-source mode remains the default and must not be degraded by multi-source support. Removing the second source returns to single mode cleanly.

### Deploy-Aware Feedback Loop
- `REQ-D-001:` Pixel Forge must detect whether the preview target is remote (not localhost/127.0.0.1) and surface that awareness in the completion flow.
- `REQ-D-002:` When the agent completes a code edit against a remote preview target, the dispatch prompt must instruct the agent to deploy the changes using whatever deployment process the workspace provides. No standardized deploy convention — the agent infers the deploy method from the workspace.
- `REQ-D-003:` After agent completion on a remote target, the chat UI must show a "Refresh Preview" action that cache-busts and reloads the iframe to the current path without destroying the proxy session or auth state.
- `REQ-D-004:` A manual "Refresh Preview" button must always be available in the toolbar as a universal fallback regardless of target type.

# Current Limiting Factor

- `[active]` The deploy-aware feedback loop must close the visual gap between editing code and seeing results on remote preview targets.
- Why it is the limiter: Without this, editing against staging/production targets is a dead-end — the user edits code but never sees the result without manual intervention outside Pixel Forge.
- Smallest complete unit to attack it: After agent completion on a remote target, the agent receives a deploy instruction, the chat shows a "Refresh Preview" button, and clicking it cache-busts the iframe without losing auth.
- Immediate proof target: Edit code against a remote preview URL, see the agent instructed to deploy, click Refresh Preview, and confirm the iframe reloads to the same path with fresh content.

# Current Proof Status

- `[validated]` Live Editor thread metadata now persists outside process memory. Basis: Pixel Forge stores thread state in a SQLite-backed local state file.
- `[validated]` Live Editor request context now lands on disk as request packs under `.pixel-forge/requests`. Basis: the backend writes request packs before dispatch.
- `[validated]` Pixel Forge now dispatches Live Editor requests into Agent Deck sessions instead of spawning direct `claude -p` processes for that path. Basis: `/ws/live-editor` uses the Agent Deck bridge.
- `[validated]` Pixel Forge surfaces Agent Deck session identity in the Live Editor UI. Basis: the frontend persists and displays Agent Deck session metadata.
- `[validated]` Pixel Forge now separates workspace selection, preview URL, and generated output policy in the selector flow. Basis: the selector now binds a workspace, accepts any preview URL, and defaults scratch output to `.pixel-forge/generated/`.
- `[validated]` Pixel Forge now maintains browser-scoped proxy sessions with upstream cookie jars for authenticated targets. Basis: `/config/app-proxy` issues a local proxy-session cookie and the app proxy reuses per-session upstream clients instead of one global stateless target.
- `[unvalidated]` JSONL-tail streaming parity is good enough for all real Claude tool flows, not just common edit flows. Basis: implemented from observed Claude JSONL structure but not yet proven across wider cases.
- `[unvalidated]` Request-pack retention limits are the right balance between debuggability and disk usage. Basis: chosen pragmatically for the first working cut.
- `[unvalidated]` Deploy-aware feedback loop: remote target detection, deploy instruction in dispatch prompt, and Refresh Preview button in chat and toolbar. Basis: implemented in backend and frontend but not yet proven against a real staging target.
- `[planned]` Multi-source context: dual-iframe layout with source-tagged element selections and dual proxy path prefixes.
- `[planned]` Screenshot bootstrap will be migrated onto the same session control plane only after the Live Editor loop is proven superior there.

# Open Questions

- `[question]` Do we want Pixel Forge to embed an Agent Deck terminal pane directly, or is surfacing the session identity enough for the next cut?
- `[question]` Should request-pack retention become content-addressed and deduplicated, or is bounded per-request storage sufficient in practice?
- `[question]` Should the second source panel support its own independent deploy-aware refresh, or is one shared refresh sufficient?

# Out of Scope

- Rebuilding Agent Deck inside Pixel Forge.
- Migrating screenshot bootstrap to Agent Deck before the Live Editor path is proven.
- Preserving fake “unified session” semantics between screenshot bootstrap and live editing if they make the backend model less truthful.
