# Intent

Make Pixel Forge the fastest way to visually edit a real running app, including Pixel Forge itself, while keeping the real agent runtime visible and controllable. Pixel Forge should own visual context assembly and request brokering, not a fake headless session layer.

# Goals

1. Live Editor sends selected-element context and attachments into a persistent real agent session without losing continuity on server restart.
2. Every live-edit request is inspectable and reproducible from a disk-backed request pack instead of giant pasted blobs or process memory.
3. Pixel Forge sessions show up in Agent Deck so the user can drop into the real session when the chat UI is not enough.
4. Users can pull visual context from multiple preview tabs into one prompt while keeping one unified Live Editor chat and selection workflow for the project.
5. Pixel Forge can launch a faithful sibling Pixel Forge mirror runtime for self-edit loops without colliding with the controller instance or diverging from the UI being fixed.
6. Selected-element context must stay truthful across DOM and canvas-like preview surfaces, and the working agent must be able to inspect the frozen selected state without replaying the browser path manually.
7. Pixel Forge preview interaction must grow as a real tool system, with selection as the first tool rather than a permanent special case, so future capabilities can ship without sprawling across Live Editor state and shell glue.
8. Working agents must use Pixel Forge-forged preview evidence truthfully instead of inferring or inventing live behavior from repo code when the user already navigated and selected the real target surface.

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
- `REQ-S-004:` Workspace/project metadata and resumable Live Editor session linkage must persist in the Pixel Forge backend store instead of browser localStorage.
- `REQ-S-005:` Project/workspace metadata, Live Editor thread/session linkage, and staged update records must live in a shared Pixel Forge control-plane store visible to the controller and mirror runtimes. Runtime sandboxes may isolate browser state, logs, and build artifacts, but they must not silently fork this shared product metadata.

### Git Hygiene
- `REQ-G-001:` Request packs created inside a target repo must not pollute the user’s normal git status.
- `REQ-G-002:` Scratch generated code defaults to `.pixel-forge/generated/` inside the bound workspace unless the user explicitly chooses a repo-relative output path.

### Preview Targets
- `REQ-P-001:` Live preview targets may be any URL Pixel Forge can proxy, not just localhost dev servers.
- `REQ-P-002:` Direct code edits still require a writable workspace even when the preview target is a remote or third-party website.
- `REQ-P-003:` Authenticated staging and production targets must keep login state inside Pixel Forge by binding each browser session to its own proxy target and upstream cookie jar.
- `REQ-P-004:` Proxy setup from the web app must use credentialed backend calls so the browser-scoped proxy session cookie is actually established before the iframe loads.
- `REQ-P-005:` Pixel Forge preview must run through the native shell's embedded Chromium surface for both localhost and third-party targets. The browser-only web build is a service/debug fallback, not a supported Live Editor preview surface.

### Multi-Tab Preview Context
- `REQ-M-001:` The Live Editor preview layer must support multiple browser-style preview tabs inside one project/chat instance. Adding a tab must not start a new chat thread.
- `REQ-M-002:` Each preview tab must keep its own proxy/browser session state, including upstream cookie/auth state, so switching tabs restores that tab’s browsing context.
- `REQ-M-003:` Selected elements must carry explicit preview-tab identity and resolved source URL so the agent can reason about cross-tab comparisons.
- `REQ-M-004:` The element context builder must group selections by preview tab/source, including tab and URL metadata, while still sending one unified prompt to the agent.
- `REQ-M-005:` Switching preview tabs must not clear the unified selected-element list. The active iframe only renders overlays for selections that belong to the active tab.
- `REQ-M-006:` Pixel Forge must not enforce a small fixed preview-tab cap. Practical limits are driven by runtime/browser resources, not a hardcoded product limit.
- `REQ-M-007:` In the native shell path, preview tabs must render inside Pixel Forge itself rather than bouncing the user out to separate external browser windows.
- `REQ-M-008:` When selections span multiple preview sources, the short dispatch prompt must not collapse them into one misleading preview target or deploy instruction. The request-pack source grouping is the truth, and the dispatch prompt may only summarize it faithfully.

### Selection Engine
- `REQ-X-001:` Pixel Forge must choose the selection strategy automatically from the live preview substrate instead of exposing selector-mode choice as a default user workflow.
- `REQ-X-002:` DOM-like targets must preserve semantic selectors and DOM excerpts; canvas-like targets must preserve spatial region anchors and visual evidence instead of fake DOM references.
- `REQ-X-003:` Selection identity must be stable by Pixel Forge selection id, not only by xpath, so renumbering, removal, and cross-tab reconciliation stay truthful.
- `REQ-X-004:` Visual overlays must reattach only when the selected target's page/view identity and substrate match the current live preview state.
- `REQ-X-005:` While select mode is active on DOM-like targets, pressing `Left Ctrl` with the pointer held still must cycle the proposed hover target upward through ancestor containers, and any mouse movement must reset that cycle back to the immediate hovered target.
- `REQ-X-006:` While select mode is active on an already selected DOM-like target, holding `Ctrl+Shift` over that selection must preview promotion to the next ancestor container in a distinct transitional state, and clicking must replace that saved selection in place instead of removing and re-adding it.
- `REQ-X-007:` Pixel Forge must support undo and redo for selection-engine mutations so selection add/remove/clear/promote mistakes can be reversed without rebuilding the whole prompt manually.

### Tool System
- `REQ-L-001:` Pixel Forge preview interaction must be modeled as named tools with a shared controller/registry, not as one-off booleans and ad hoc event handling embedded directly in Live Editor UI code.
- `REQ-L-002:` The current selection tool must live inside that tool system as tool `v1`, not as a permanent special case that future tools have to work around.
- `REQ-L-003:` Each tool must own its input handling, transient hover/proposal state, committed artifact state, overlay rendering, and request-pack/tunnel serialization contract.
- `REQ-L-004:` Tool state must distinguish transient proposed targets from committed artifacts so hover previews, promotion, undo/redo, and future tool composition stay predictable.
- `REQ-L-005:` Tool shortcuts, modifier chords, and focus handoff must be routed through a central tool input layer instead of being solved separately inside each tool implementation.
- `REQ-L-006:` Default tool behavior should stay automatic when the substrate makes the right choice obvious, but advanced sub-modes and alternate probing strategies may exist behind explicit chords or advanced controls.
- `REQ-L-007:` Pixel Forge must record which tool and sub-mode produced each committed artifact so the working agent can interpret the selection tunnel truthfully.
- `REQ-L-008:` The user-facing tool surface should converge toward a compact persistent tool palette/rail, not a scattering of special-case buttons across individual panes.

### Agent Selection Tunnel
- `REQ-U-001:` Each Live Editor request pack must include a structured frozen selection tunnel artifact in addition to human-readable selected-elements markup.
- `REQ-U-002:` Pixel Forge must expose agent-facing inspection paths for selected live surfaces. The minimum path is the frozen local selection tunnel; the target path is live attach into the already-running preview session without replaying login, navigation, or view reconstruction.
- `REQ-U-003:` Canvas-like and other spatial selections must carry screenshot evidence into the request pack so the agent receives the visual state Pixel Forge forged, not an inferred substitute, and dispatch instructions must require the agent to state any remaining inspection limitation explicitly instead of guessing.
- `REQ-U-004:` Agent-facing Pixel Forge operations must converge on the existing `pixel-forge` CLI plus a dedicated `using-pixel-forge` skill. Do not fork agent behavior across a second parallel CLI surface unless the canonical CLI proves insufficient.

### Self-Edit Runtime
- `REQ-E-001:` Pixel Forge must be able to launch a sibling Pixel Forge target runtime for a compatible workspace, with isolated ports, runtime sandbox paths, and managed-browser profile paths.
- `REQ-E-002:` The default self-edit target must be a faithful mirror of Pixel Forge's real controller UI and startup flows, including the workspace selector and deeper self-target launch paths. Safety belongs to isolated runtime/state boundaries and backend/runtime policy interception, not to front-end neutering of the target surface.
- `REQ-E-002A:` Self-edit must be preview-first. A completed Pixel Forge self-edit request should be loadable into a new mirror preview build/tab before the user decides to promote that same build into the controller.
- `REQ-E-003:` A Pixel Forge self-edit request must not restart or replace the active Pixel Forge controller before the current live-edit stream finishes.
- `REQ-E-004:` Self-edit activation should stage repo changes first and leave install/restart activation to an explicit post-run step rather than cutting off the in-flight broker session.
- `REQ-E-005:` The installed controller path must keep at least one rollback build so a broken self-update can be reverted quickly.
- `REQ-E-006:` Self-edit completions and external/manual Pixel Forge edits must share the same staged controller-update lane instead of one path living only inside chat.
- `REQ-E-007:` A staged controller update must freeze a source snapshot at stage time so applying it cannot accidentally pick up later unrelated working-tree drift.
- `REQ-E-008:` Applying a staged controller update must relaunch the shell against the restored project/mode/preview context so desktop-shell code changes can take effect without manual relaunch choreography.
- `REQ-E-009:` If Pixel Forge keeps a lower-fidelity dev-target path for rapid iteration, that path must be explicit and must not replace the faithful mirror target as the default self-edit surface.
- `REQ-E-010:` Mirror preview builds must be versioned local artifacts keyed by their frozen source snapshot/runtime root so multiple mirror candidates can stay open in separate tabs without overwriting each other.
- `REQ-E-011:` `Run Pixel Forge` must default to the latest available mirror candidate for the workspace, while still allowing explicit selection of older mirror builds.
- `REQ-E-012:` Mirror build artifacts belong in Pixel Forge state outside the repo so they do not pollute git status or require git-ignore churn in the workspace.
- `REQ-E-013:` Applying a staged controller update must hand off to a detached update runner and close the active controller shell before install/restart begins. The update progress surface may be a separate dedicated updater window, but the controller being replaced must not remain responsible for its own update lifecycle.

### Deploy-Aware Feedback Loop
- `REQ-D-001:` Pixel Forge must detect whether the preview target is remote (not localhost/127.0.0.1) and surface that awareness in the completion flow.
- `REQ-D-002:` When the agent completes a code edit against the active preview target and that target is controlled by the workspace, the request pack and dispatch prompt must instruct the agent to apply the update to that preview target before treating the task as done.
- `REQ-D-003:` For local/dev preview targets, the agent must rebuild, restart, or reload the service serving that exact preview URL/path using the repo's normal workflow instead of stopping at file edits.
- `REQ-D-004:` For repo-controlled remote preview targets, the agent must deploy using whatever deployment process the workspace provides. No standardized deploy convention — the agent infers the deploy method from the workspace.
- `REQ-D-005:` If the active preview target is external or not controlled by the workspace, the agent must say that explicitly and skip deployment or reload instead of silently doing nothing.
- `REQ-D-006:` After agent completion on a remote target, the chat UI must show a "Refresh Preview" action that cache-busts and reloads the iframe to the current path without destroying the proxy session or auth state.
- `REQ-D-007:` A manual "Refresh Preview" button must always be available in the toolbar as a universal fallback regardless of target type.

# Current Limiting Factor

- `[active]` Agent handoff fidelity is still weaker than the preview/session fidelity Pixel Forge already captures.
- Why it is the limiter: Pixel Forge can capture the real selected surface, but working agents still fall back to repo-code inference too easily because the handoff is mostly a frozen request pack with no proven live attach path into the already-running preview session. That creates hallucinated behavior and missed deploy/apply steps even when the user already navigated to the truth.
- Smallest complete unit to attack it: strengthen the handoff contract so agents must treat Pixel Forge-forged artifacts as authoritative evidence, then add a live attach path from the agent runtime into the existing preview session instead of forcing replay or guesswork.
- Immediate proof target: prove one real agent workflow that reads the request pack, uses the selection tunnel instead of recreating navigation, applies the change to the active preview target, and states any remaining live-inspection limitation honestly.

# Current Proof Status

- `[validated]` Live Editor thread metadata now persists outside process memory. Basis: Pixel Forge stores thread state in a shared SQLite-backed local state database.
- `[validated]` Live Editor request context now lands on disk as request packs under `.pixel-forge/requests`. Basis: the backend writes request packs before dispatch.
- `[validated]` Pixel Forge now dispatches Live Editor requests into Agent Deck sessions instead of spawning direct `claude -p` processes for that path. Basis: `/ws/live-editor` uses the Agent Deck bridge.
- `[validated]` Pixel Forge surfaces Agent Deck session identity in the Live Editor UI. Basis: the frontend persists and displays Agent Deck session metadata.
- `[validated]` Pixel Forge now separates workspace selection, preview URL, and generated output policy in the selector flow. Basis: the selector now binds a workspace, accepts any preview URL, and defaults scratch output to `.pixel-forge/generated/`.
- `[validated]` Project/workspace metadata and resumable Live Editor session linkage now persist server-side in SQLite under `~/.pixel-forge/pixel-forge.db`. Basis: recent projects, preview URL history, and Live Editor session metadata now load from backend APIs instead of browser localStorage.
- `[validated]` Shared Pixel Forge metadata now lives in a control-plane store that is visible to controller and mirror runtimes instead of being snapshotted into isolated mirror DB copies. Basis: the shared SQLite DB and staged controller-update state now resolve through the shared control-plane root while mirrors keep isolated runtime sandboxes for browser/build state.
- `[validated]` Pixel Forge now maintains browser-scoped proxy sessions with upstream cookie jars for authenticated targets. Basis: `/config/app-proxy` issues a local proxy-session cookie and the app proxy reuses per-session upstream clients instead of one global stateless target.
- `[validated]` Pixel Forge now maintains multiple mounted preview tabs inside one Live Editor thread, with each tab bound to its own proxy session and active URL state. Basis: browser smoke loaded `https://field.arcforge.au/` and `https://claude.ai/new` in separate tabs and kept the active URL bar on the real target URL rather than the internal proxy URL.
- `[validated]` Cross-tab element selection now survives tab switches and stays unified in one project-level context list. Basis: browser smoke selected one element from the Claude tab and one from the Field tab, then the Elements pane showed both selections together with their source URLs.
- `[validated]` Multi-source request artifacts preserve grouped source truth, and the broker prompt no longer collapses them into one singular preview target. Basis: request-pack inspection showed mixed Pixel Forge + Claude selections grouped correctly, and the dispatch prompt builder now summarizes multi-source selections instead of emitting a single remote-target line for them.
- `[validated]` Pixel Forge now has a native desktop-shell path (`apps/desktop`) that embeds real Chromium-backed preview tabs inside the app chrome. Basis: Electron shell proof loaded a live remote page into the preview pane, switched it to `https://example.com/`, enabled selecting, and the shared Elements context incremented inside the Pixel Forge UI.
- `[validated]` The product preview path now treats embedded Chromium as the only supported Live Editor surface. Basis: the launcher defaults to the shell, `Save & Edit Live` now hands URLs straight to Live Editor state instead of configuring the proxy, and the browser-only Live Editor path now blocks with a shell-required message.
- `[validated]` Pixel Forge can now launch a sibling Pixel Forge target runtime for self-editing without sharing controller ports, DB state, or managed-browser profile state. Basis: the backend local-target launcher allocates isolated runtime settings and the controller opens the returned target URL inside the existing preview-tab system.
- `[validated]` The default self-edit launch path now uses the mirror lane instead of defaulting to the dev/HMR target lane. Basis: `Run Pixel Forge` launches `runtime_kind=mirror`, and the dev/HMR lane remains explicit rather than the default.
- `[unvalidated]` Pixel Forge self-edit requests now stay controller-safe through completion instead of restarting the active broker mid-stream. Basis: request-pack and dispatch-prompt guardrails exist, but the full self-edit loop has not yet been re-proven end to end.
- `[validated]` Pixel Forge now stages controller updates through one shared lane for self-edit and external/manual agent work, and that notice survives outside the chat surface. Basis: the shell watches a persistent staged-update record, the app top chrome renders a shared update notice, and both Live Editor self-edit completion and the `pixel-forge stage-update` CLI write the same record.
- `[validated]` Staged controller updates now apply from a frozen source snapshot instead of the mutable live repo working tree. Basis: stage-time snapshot smoke proved the staged snapshot excludes transient heavy paths, `show` returns the frozen payload, and `clear` removes both the pending record and snapshot.
- `[validated]` Applying a staged controller update now relaunches the shell back into the same project/mode/preview context. Basis: the shell writes bootstrap state to disk before install/restart, then relaunches Electron so updated shell code can take effect without a manual close/reopen dance.
- `[validated]` Sibling target runtimes can now surface the shared workspace-selector affordance and recursive self-launch controls inside the isolated target runtime. Basis: target mode now exposes a selector opener in-app and no longer suppresses `Run Pixel Forge` inside the target runtime.
- `[unvalidated]` Mirror-target fidelity is high enough that fixing the target UI fixes the controller UI. Basis: the mirror launcher now targets the current runtime artifact and seeds isolated state from the current runtime, but end-to-end UI proof against the startup dialog mismatch has not yet been re-run after that change.
- `[unvalidated]` Mirror runtimes are fully shell-capable when Pixel Forge runs inside Pixel Forge, including nested preview ownership and update affordances. Basis: the default self-edit target is now a faithful mirror build, but recursive shell capability inside that mirror runtime has not yet been completed.
- `[validated]` Self-edit now separates preview loading from controller promotion in the product model. Basis: chat completion can load a staged update into a mirror preview tab, while the controller header notice remains the promotion path for the installed app.
- `[validated]` Mirror candidates are now versioned local runtime artifacts rather than one mutable mirror instance. Basis: mirror instances are keyed by source snapshot/runtime root, can coexist in separate tabs, and can be listed/selectively reopened.
- `[planned]` Pixel Forge preview interaction will be restructured as a first-class tool system with selection as the first tool rather than a permanent special case. Basis: the architectural intent is now explicit, but the controller/registry extraction has not started yet.
- `[validated]` Live Editor request packs now include a structured `selection-tunnel.json` artifact and can expose it back through a local API/CLI path. Basis: request-pack smoke created the tunnel file, registered it in the manifest, and the backend now serves `/api/live-editor/selection-tunnel`.
- `[validated]` Pixel Forge now stores screenshot evidence alongside selection context so non-DOM selections can carry frozen visual state into the request pack. Basis: the shell selection bridge now captures bounded image crops during selection and the frontend includes them as request-pack attachments.
- `[validated]` Selected DOM targets can now be promoted upward in place without losing their selection slot, and the shell preview shows that promotion as a yellow transitional preview before commit. Basis: Electron smoke selected a child button, showed `Promote to div#parent` with yellow badge state on `Ctrl+Shift`, then emitted `browser-element-updated` with the same selection id retargeted to the parent xpath.
- `[validated]` Selection add/remove/clear/promote mutations now support undo and redo in the controller state. Basis: store regression tests prove replace/remove/clear restore the exact selection order and ids through undo/redo.
- `[unvalidated]` Automatic selector routing is good enough across real hybrid DOM/canvas/WebGL apps, not just synthetic cases. Basis: implemented in the shell selection engine, but not yet hammered against a wider hostile sample.
- `[validated]` Ancestor-cycle hover selection now moves upward through visible DOM ancestors while the pointer stays still and resets back to the direct hovered target on movement. Basis: shell smoke on nested markup showed child `1/3`, parent `2/3`, then reset to the child after mouse movement.
- `[validated]` Dispatch/request-pack guidance now explicitly tells agents to treat Pixel Forge-forged artifacts as authoritative evidence, apply changes to the active preview target when the workspace controls it, and state remaining inspection limits instead of guessing. Basis: backend dispatch prompt and request-pack working rules now encode that behavior.
- `[validated]` Pixel Forge now provides a dedicated `using-pixel-forge` skill and points Live Editor implementers at it instead of expecting them to infer the CLI/tunnel workflow. Basis: the skill is installed locally and the Live Editor dispatch prompt explicitly tells agents to use it when available.
- `[unvalidated]` The selection tunnel gives working agents enough frozen context to avoid replaying third-party auth or deep navigation in practice. Basis: file/API/CLI path now exists, but it has not yet been exercised by a real agent workflow end to end.
- `[unvalidated]` Pixel Forge has a true live attach path that lets a working agent inspect the already-running preview session/tab in place instead of relying on frozen artifacts only. Basis: this is the desired architecture, but no such attach lane is proven yet.
- `[unvalidated]` JSONL-tail streaming parity is good enough for all real Claude tool flows, not just common edit flows. Basis: implemented from observed Claude JSONL structure but not yet proven across wider cases.
- `[unvalidated]` Request-pack retention limits are the right balance between debuggability and disk usage. Basis: chosen pragmatically for the first working cut.
- `[unvalidated]` Deploy-aware feedback loop: remote target detection, deploy instruction in dispatch prompt, and Refresh Preview button in chat and toolbar. Basis: implemented in backend and frontend but not yet proven against a real staging target.
- `[unvalidated]` Cross-tab dispatch context: one request pack and one agent prompt clearly preserve grouped source metadata for selections gathered from multiple preview tabs. Basis: browser-side tab/session/selection behavior is now proven, but the full dispatch artifact has not yet been inspected.
- `[unvalidated]` Self-edit rebuild resilience: the controller keeps the sibling target tab usable across repeated target rebuilds/restarts. Basis: target launch plumbing exists, but the restart/reconnect loop has not yet been hammered.
- `[planned]` Screenshot bootstrap will be migrated onto the same session control plane only after the Live Editor loop is proven superior there.

# Open Questions

- `[question]` Do we want Pixel Forge to embed an Agent Deck terminal pane directly, or is surfacing the session identity enough for the next cut?
- `[question]` Should request-pack retention become content-addressed and deduplicated, or is bounded per-request storage sufficient in practice?
- `[question]` Should the second source panel support its own independent deploy-aware refresh, or is one shared refresh sufficient?
- `[question]` When we add behind-the-pixel probing later, should it stay on a separate modifier chord from ancestor cycling or become an explicit advanced selection sub-mode?
- `[question]` Should the eventual tool palette be global to the whole preview workspace, or should some tools only appear when the active substrate/runtime can actually support them?
- `[question]` Should the eventual live attach lane be implemented through Pixel Forge's own browser-session API, a browser-native attach protocol, or both?

# Out of Scope

- Rebuilding Agent Deck inside Pixel Forge.
- Migrating screenshot bootstrap to Agent Deck before the Live Editor path is proven.
- Preserving fake “unified session” semantics between screenshot bootstrap and live editing if they make the backend model less truthful.
