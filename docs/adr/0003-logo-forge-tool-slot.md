# ADR 0003: Logo Forge As An In-App Project-Scoped Tool Slot

- Status: Accepted
- Date: 2026-04-22

## Context

The Logo Forge already exists as a standalone editor at `design/logo/tromino-forge.html`, backed by the DOM-free `@pixel-forge/logo-forge-core` package. It has not yet been promoted into the Pixel Forge shell as a tool slot alongside Live Editor and Screenshot.

INTENT.md pins the product requirements (REQ-1.13, REQ-F-002, REQ-F-004, REQ-F-005, REQ-F-006, REQ-F-007) and ARCHITECTURE.md pins the runtime shape (single-region background rule, preview/export separation, per-project persistence). Those say *what* must be true. This ADR decides *how* the tool slot gets built and confirms the scope boundaries before code lands.

The trigger for writing this down now: we are moving workstations with the scaffold still unbuilt, and the next session needs to pick up without re-deriving the design.

## Decision

### Scope boundary — project-scoped, not global

The Logo Forge is a **project-scoped tool**, not a global utility. When the operator switches projects in the shell, the tool's state swaps to that project's forge state. Two projects may hold wildly different seeds, palettes, and export settings simultaneously.

This matches Live Editor (per-project chats/threads) and the Screenshot tool (per-project shots), not Settings (global singleton). It is the correct shape because:

- Each project ships its own brand mark — Pixel Forge's favicon is not Agent Deck's favicon.
- Operators iterate on a mark over many sessions; state decay between sessions is a regression.
- The mark drives generated assets that land in the project's tree (`apps/web/public/favicon/*`, `design/logo/pixel-forge-logo-pack/`). Tool state that outputs into a project directory must be owned by that project.
- Reinstalls, controller updates, and shell restarts must not lose the forge state — which rules out browser localStorage and mandates the shared control-plane store that already owns project truth.

### Tool slot — third entry in `ActiveMode`

- Extend `ActiveMode` in `apps/web/src/store/session-store.ts` from `"screenshot" | "live-editor"` to `"screenshot" | "live-editor" | "logo-forge"`.
- Migrate `profileState.active_mode` parsing to accept the new value; default remains `"screenshot"`.
- Extend `ModeTabBar` (`apps/web/src/components/layout/ModeTabBar.tsx`) with a third tab. Label: **"Logo Forge"**. Glyph: small tromino-F mark in the app's primary green (`hsl(var(--primary))`, `#5cb87a`) — this is the same green the logo itself emits, so the glyph is visually honest about what the tool produces.
- Extend `App.tsx` pane switching to mount a `<LogoForgePane />` under the same visibility-toggle pattern used by `<LiveEditorPane />`, so the pane mounts once per session and preserves scroll/canvas state across tab switches (same reason `TabsContent` was kept mounted in commits `6b3020a` / `672108f`).

### Component layout

New folder `apps/web/src/components/logo-forge/` mirroring `live-editor/`:

```
logo-forge/
  LogoForgePane.tsx           # top-level pane, sidebar + canvas grid
  LogoForgeSidebar.tsx        # Seed → Parameters → Colors → Preview surface → Export sections
  LogoForgeCanvas.tsx         # Canvas2D renderer, consumes logo-forge-core
  LogoForgePreviewStrip.tsx   # 24/48/128/256 thumbnails
  sections/
    SeedSection.tsx
    ParametersSection.tsx
    ColorsSection.tsx
    PreviewSurfaceSection.tsx
    ExportSection.tsx
  store/
    logo-forge-store.ts       # Zustand slice, per-project
    logo-forge-store.test.ts
  export/
    composeExport.ts          # ports standalone composeExport
    buildSvg.ts               # ports standalone buildSVGString
    downloadPack.ts           # ports the zip bundler
  hooks/
    useLogoForgeRenderer.ts   # drives redraw on param change
    useProjectScopedForge.ts  # swaps store slice when active project changes
```

### Renderer — Canvas2D, drop p5

`@pixel-forge/logo-forge-core` is already DOM-free. The in-app renderer imports the core directly and draws to a `<canvas>` via plain Canvas2D inside a `useEffect`, using `window.devicePixelRatio` for HiDPI and `imageSmoothingEnabled = false` for the nearest-neighbour pixel aesthetic.

**p5.js is not pulled into the web bundle.** It stays only in the standalone `design/logo/tromino-forge.html` sandbox where zero-build iteration matters more than bundle weight. The standalone and the in-app tool both consume the same core module, so visual output cannot drift; only the drawing surface differs.

Rationale: p5 is ~80kB gzipped for a single tool that only needs `canvas.fillRect` and `drawImage`. A ~200-line Canvas2D port is the cheaper trade. If future forge variants need p5 for animated generative previews, promote p5 to a shared runtime at that point — not speculatively now.

### Branding — reuse app tokens, drop Anthropic palette

The standalone editor uses Anthropic's colour scheme (Poppins/Lora fonts, light bg, off-brand accent colours) because the source template for the algorithmic-art skill is Anthropic-branded. That palette does not belong in the shipped product.

The in-app Logo Forge consumes the app's existing CSS variables verbatim:

- Background → `hsl(var(--background))` = `#080b10`
- Card / sidebar → `hsl(var(--card))` = `#0c1017`
- Primary CTA, active chip, seed-navigation glyphs → `hsl(var(--primary))` = `#5cb87a`
- Borders → `hsl(var(--border))` = `#272e38`
- Muted text → `hsl(var(--muted-foreground))` = `#788594`
- Typography → the app's existing sans stack (Inter / system). No Poppins, no Lora.

The primary green is already the logo's own green. Re-skinning to the app theme is not just visual tidiness; it's the tool producing a mark that matches the chrome it lives inside.

Sidebar section order stays identical to the standalone (**Seed → Parameters → Colors → Preview surface → Export**) because operators have muscle memory from the standalone. Only the skin changes.

### State — per-project slice in the shared control-plane store

- New Zustand slice `logo-forge-store.ts` structured like `chat-store.ts`.
- Key shape: `forgeStateByProject: Record<projectId, LogoForgeState>`. Active project's slice is the one the UI reads and writes.
- `LogoForgeState` holds: `seed`, `params` (recursion depth, gap ratio, shade spread, highlight boost, jitter, logo margin, pixel corner radius, icon corner radius), `colors` (foreground shades + configured background), `previewSurface` (`"configured" | "black" | "white"`), `previewShowBackground` (bool), `exportIncludeBackground` (bool), `pattern` (the cell grid).
- Persistence: serialise into the profile state already persisted by the backend control plane. **No browser localStorage.** Survives reinstalls, controller updates, and shell restarts. This is REQ-F-005.
- Debounce save writes (300–500ms) because slider drags would otherwise spam the control plane.
- Project switch fires `useProjectScopedForge` which reads the target project's slice and seeds the renderer. No cross-project bleed.

### Export — desktop bridge first, browser download fallback

The standalone uses `canvas.toBlob()` + `<a download>` because it's browser-only. The in-app tool runs in both the desktop shell (Electron) and the raw web UI.

- When `window.pixelForgeDesktop` is present, route PNG/SVG/zip through the desktop bridge to a real file dialog — same pattern as the workspace picker fix in commit `557d4ca`.
- Default save target for PNG/SVG is the active project's directory (e.g. `<project>/design/logo/` or `<project>/apps/web/public/favicon/`), surfaced via the file picker so the operator still confirms the landing spot.
- When the desktop bridge is absent (browser mode), fall back to blob download.
- The zip "pack" export (`downloadPack.ts`) reuses JSZip as in the standalone.

### Invariants that survive the port

These are non-negotiable and carry forward verbatim from the standalone:

- **Single-region background rule (REQ-F-006):** exports are either fully background-filled or fully transparent; no inner-icon-box vs margin split.
- **Preview/export separation (REQ-F-007):** preview-surface selectors (Configured / Black / White + show-background toggle) are CSS-layer only, behind the always-transparent render canvas; they never influence exported pixels.
- **Core-package parity:** the standalone and the in-app tool cannot diverge on pattern generation, leaf collection, colour math, centering, or corner-clip geometry. Both import `@pixel-forge/logo-forge-core`.

### Phasing

Ship in five thin slices, smallest viable first:

1. **Tool slot + rebranded shell.** Empty pane, new tab, Pixel Forge chrome. Proves routing, per-project state scaffolding, and that the theme doesn't clash with the rest of the UI. No forge rendering yet.
2. **Canvas port.** Core → Canvas2D → displayed. Seed + regenerate button, fixed parameters. Proves visual parity with the standalone.
3. **Parameter sidebar.** Port every slider and colour picker. Live update on change.
4. **Export pipeline.** PNG, SVG, then zip pack. Desktop-bridge file dialog when available; blob download otherwise. Default save target is the active project's tree.
5. **Project-scoped persistence.** Wire the store slice into the control-plane profile state. Verify reinstall / controller update / shell restart survive. Verify project switch swaps state cleanly.

The standalone editor at `design/logo/tromino-forge.html` **stays**. It remains the zero-build iteration surface for algorithm changes before they promote into core. Killing it would cost more in iteration friction than it saves in duplication.

## Consequences

- The standalone and the in-app tool share one algorithmic truth source (`logo-forge-core`). Bugs get fixed once.
- `ActiveMode` grows from two values to three. Anything that switches on mode (including tests, telemetry tags, profile-state serialisation) must handle the new variant. This is a one-time migration cost.
- Per-project state means the control-plane store grows proportional to the number of projects with forge state. Negligible — the state is a few hundred bytes per project.
- Desktop-bridge export means the tool has a different save UX in desktop vs browser mode. Acceptable; matches how every other save action in the shell already behaves.
- p5.js stays out of the web bundle; anyone later wanting p5-driven generative previews inside the shell must explicitly revisit this decision.
