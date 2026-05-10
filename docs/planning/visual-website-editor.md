# Pixel Forge Visual Website Editor Plan

Status: planning
Created: 2026-05-11
Owner: Pixel Forge
GitHub issue: https://github.com/arcforgelabs/pixel-forge/issues/2

## Why This Exists

Pixel Forge is already strong at truthful visual context: it can load a real
site/app, let the operator select DOM, canvas-like, PDF, and screenshot-backed
regions, write request packs, and hand that exact context to an agent. The
missing capability is direct visual authorship for websites that are meant to be
owned and deployed from our repos.

The immediate driver was the Arc Forge website simplification work. We wanted a
builder where the current site could become a visually faithful editable page,
so ordinary copy/layout tweaks would not require asking an agent to change HTML
or code every time.

Framer did not solve that cleanly.

## Framer Lessons

Framer is still useful, but it is not the right foundation for a Pixel
Forge-owned visual website editor.

Observed and researched on 2026-05-10 and 2026-05-11:

- Framer's product/editor code is not open source in a way we can fork or embed.
  Framer's public GitHub presence exposes plugin examples, utilities, forks, and
  related open-source projects, not the website builder/editor itself.
- Framer can be extended through Plugin API, code components, and the beta
  Server API. Those are extension rails, not a path to owning the editor.
- The Design Bridge MCP route can create and edit native Framer canvas nodes,
  and API-visible TextNodes can be updated by an agent, but a first native
  Framer rebuild of Arc Forge was not visually close to the existing site.
- Framer code components can get closer to custom visuals, but the copy and
  layout then live in code/component props rather than in clean native editable
  layers.
- The official HTML to Framer Chrome extension is section-oriented. It copies
  selected DOM/computed styles into a Framer clipboard payload, but it is not a
  reliable full-site migration tool.
- A real full-page paste test against `https://arcforge.au/` produced a large
  rough frame, not a one-to-one editable Framer page.
- The Arc Forge hero depends on canvas/WebGL-style visuals. The HTML to Framer
  extension treats canvas/WebGL content as unsupported/special, so the hero did
  not become editable Framer layers.
- Framer static file upload is asset hosting, not "upload an HTML site and make
  it editable."

Conclusion: Framer can remain an export/interop target or a client-facing
builder when someone explicitly wants Framer. It should not be Pixel Forge's
native visual website editor foundation.

## Product Need

Pixel Forge needs a project-scoped builder mode that gives the operator and
agents one shared source of truth:

- A visible page canvas.
- Direct text editing for headings, body copy, buttons, labels, metadata, and
  repeated card content.
- Component-level editing instead of arbitrary fragile HTML mutation.
- Reorderable sections and slots.
- Controlled design tokens for colors, type, spacing, radii, shadows, and
  responsive rules.
- A structured serializable page model that agents can patch safely.
- Real React/Next.js rendering so our existing deployment pipeline remains the
  path to production.
- Explicit WebGL/3D blocks that can wrap Three/R3F, Spline, Unicorn, image, or
  video-backed hero systems without pretending those are ordinary text layers.
- Pixel Forge request-pack integration so visual selections, agent edits, and
  human edits all point at the same component/schema nodes.

## Candidate Editor Foundations

### Puck

Source: `https://github.com/puckeditor/puck`

Puck is the strongest first spike candidate.

Why it fits:

- MIT licensed.
- A visual editor for React that can be embedded as a React component.
- Works with Next.js.
- Uses our own React components.
- Ownable JSON data model with no required vendor lock-in.
- Good fit for section/page composition where brand-safe components matter more
  than pixel-freeform layout.

Risk:

- It is more a structured page builder than a full design-canvas clone. That is
  probably a feature for Arc Forge-style sellable pages, but it will not satisfy
  every "move any pixel anywhere" expectation without custom work.

Recommended use:

- Spike first for a Pixel Forge `Website Builder` mode.
- Start with a tiny schema: `Page`, `Hero`, `PricingCards`, `SetupRescueBanner`,
  `FeatureGrid`, `CTA`, `WebGLHero`.

### Easyblocks

Source: `https://docs.easyblocks.io/`

Easyblocks is a stronger framework candidate if Pixel Forge needs a more
custom white-label builder.

Why it fits:

- Open-source React toolkit for custom visual builders.
- Explicitly separates generic builder concerns from project-specific components
  and data sources.
- Supports drag/drop, nested selection, inline rich text, responsive styling
  fields, design tokens, history, localization, templates, dynamic data, and
  SSR.
- Uses "no-code components" rather than exposing raw HTML/CSS to the end user.

Risk:

- Bigger integration surface than Puck. It may be the right long-term builder
  framework, but it is likely slower to prove than Puck.

Recommended use:

- Study after the Puck spike if Puck's canvas/field model is too limiting.

### Craft.js

Source: `https://github.com/prevwong/craft.js`

Craft.js is a lower-level React framework for extensible drag-and-drop page
editors.

Why it fits:

- MIT licensed.
- Designed for building custom React page editors.
- Gives more control over editor behavior/state than an opinionated builder.

Risk:

- More product surface must be built by us: field panels, page model, history,
  responsive controls, asset controls, persistence, and authoring UX.

Recommended use:

- Consider only if Puck is too opinionated and Easyblocks is too large.

### GrapesJS

Source: `https://github.com/GrapesJS/grapesjs`

GrapesJS is mature and widely used for HTML/template builders.

Why it fits:

- Mature open-source web builder framework.
- Strong block/style/layer/assets/plugin ecosystem.

Risk:

- Its center of gravity is HTML/CSS template editing. Pixel Forge should avoid
  making arbitrary HTML the canonical source of truth for repo-owned React
  sites unless the target is email/template generation.

Recommended use:

- Keep as a reference for mature builder UX and plugin architecture, not as the
  default Arc Forge/Pixels-to-React path.

### Webstudio

Source: `https://github.com/webstudio-is/webstudio`

Webstudio is a serious open-source Webflow alternative.

Why it fits:

- Full visual development platform.
- Ownable hosting/infrastructure story.
- Connects to headless CMS and supports broad CSS control.

Risk:

- AGPL core matters if Pixel Forge modifies and exposes the builder over a
  network.
- It may become a second product inside Pixel Forge rather than a small embedded
  builder mode.

Recommended use:

- Study for architecture and UX patterns. Do not adopt without a deliberate
  license and product-boundary decision.

### Plasmic / Builder.io / React Bricks / TinaCMS

Sources:

- `https://github.com/plasmicapp/plasmic`
- `https://www.builder.io/m/react`
- `https://www.reactbricks.com/use-cases/visual-cms-for-react-developers`
- `https://tina.io/docs/contextual-editing/react/`
- `https://tina.io/docs/editing/blocks`

These are useful comparison points.

Plasmic and Builder.io are powerful component-driven visual builder/CMS systems,
but they add external platform dependency. React Bricks and TinaCMS have strong
visual/content editing models for React/Next.js, but they are more CMS/editor
oriented than Pixel Forge-native visual-app editing.

Recommended use:

- Borrow feature ideas: component registration, roles/permissions, localization,
  preview environments, block schemas, inline text editing, content field
  hydration, and editor-side rendering.
- Do not adopt one as the primary Pixel Forge builder until the Pixel
  Forge-owned page schema option fails.

## Required Pixel Forge Features

The builder should integrate with Pixel Forge's existing model instead of
becoming a disconnected app.

Minimum feature set:

- Project-scoped `Website Builder` mode in the main Pixel Forge shell.
- A page list and route/path model for repo-owned sites.
- Page JSON/schema stored in the bound workspace, probably under a project
  folder such as `.pixel-forge/site-builder/` or a target app-controlled content
  folder.
- A component registry mapped to real React components.
- Inspector panels for component props and design-token fields.
- Inline rich text for safe copy fields.
- Section reorder/add/remove with undo/redo.
- Responsive viewport switching aligned with the existing preview controls.
- Asset picker that writes into the repo's public/assets path or Pixel Forge
  project asset store.
- A preview renderer that uses the same components as production.
- Agent-facing node ids so a request pack can say "edit `hero.headline`" instead
  of only giving a DOM xpath.
- Export/render path into Next.js or another repo-owned deployment target.
- Validation that catches missing required copy, broken asset refs, unsupported
  component props, and likely mobile overflow.

WebGL/3D-specific feature set:

- First-class `WebGLHero` or `VisualScene` block.
- Explicit source type: `three-r3f`, `spline-embed`, `unicorn-embed`,
  `video/image`, or `custom-code`.
- Editable safe props: headline/copy/CTA overlay, scene preset, colors, speed,
  intensity, camera crop, fallback image, reduced-motion behavior.
- No promise that WebGL canvas internals are text-layer editable.
- Screenshot capture and canvas-region selection through Pixel Forge's existing
  canvas-like selection path.

## Proposed Plan

Phase 0: Decide the source-of-truth boundary.

- Builder edits should write schema/content in the repo, not a remote platform.
- The production site should render from that schema through ordinary app code.
- Pixel Forge should own the visual editing UI and agent bridge.

Phase 1: Puck spike.

- Create a disposable Pixel Forge branch or example under `examples/`.
- Add Puck with a tiny Arc Forge-style page schema.
- Register 5 components: hero, pricing cards, setup/rescue, feature grid, CTA.
- Add one WebGL/visual-scene placeholder block with safe editable props.
- Confirm JSON can be edited by both the UI and an agent without conflict.
- Confirm the page renders in a normal local Next/Vite preview.

Phase 2: Pixel Forge integration sketch.

- Add a builder mode prototype that opens the Puck editor inside Pixel Forge.
- Bind editor state to the current project/workspace.
- Add request-pack references for builder node ids and selected component props.
- Make one agent-driven change from selected builder context and reload the
  rendered preview.

Phase 3: Compare with Easyblocks/Craft.js.

- Test whether Puck's model blocks required UX.
- If yes, spike Easyblocks for richer builder internals.
- If Puck is too opinionated but Easyblocks is too heavy, test Craft.js.

Phase 4: Arc Forge pilot.

- Rebuild the simplified managed OpenClaw offer page as a Pixel Forge builder
  page.
- Keep the page intentionally simple: three pricing tiers plus A$507 setup/rescue.
- Treat the WebGL hero as a controlled visual block, not an imported editable
  canvas.
- Deploy through the existing pipeline.

## Decision Bias

Prefer:

- Component-constrained editing over arbitrary freeform design.
- Repo-owned schema/code over SaaS-locked project data.
- React/Next.js compatibility over HTML-template export.
- Safe prop editing over raw CSS exposure.
- Pixel Forge request-pack/node-id truth over visual-only screenshots.
- WebGL as a controlled component block over fake "editable layers."

Avoid:

- Building a full Framer/Webflow clone.
- Letting the visual editor own production code generation as an opaque blob.
- Treating canvas/WebGL import as if it can become native text/layer editing.
- Adding a second source of truth that agents cannot patch safely.

## References

- Framer GitHub organization: `https://github.com/framer`
- Framer Plugin API reference: `https://www.framer.com/developers/reference`
- Framer plugins overview: `https://www.framer.com/developers/plugins/reference`
- HTML to Framer update: `https://www.framer.com/updates/html-to-framer`
- Puck: `https://github.com/puckeditor/puck`
- Easyblocks: `https://docs.easyblocks.io/`
- Craft.js: `https://github.com/prevwong/craft.js`
- GrapesJS: `https://github.com/GrapesJS/grapesjs`
- Webstudio: `https://github.com/webstudio-is/webstudio`
- Plasmic: `https://github.com/plasmicapp/plasmic`
- Builder.io React builder: `https://www.builder.io/m/react`
- TinaCMS visual editing: `https://tina.io/docs/contextual-editing/react/`
- TinaCMS blocks: `https://tina.io/docs/editing/blocks`
