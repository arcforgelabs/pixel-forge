# ADR 0001: Native Agent Deck Session Stays Visible

- Status: Accepted
- Date: 2026-03-20

## Context

Pixel Forge can route work into agent runtimes through multiple layers. The operator needs to see the real working session, take over manually when needed, and trust that the visible terminal is the same continuity lane Pixel Forge is using. A wrapper or proxy shell can add useful control features, but it also risks hiding the true session identity and forking continuity away from the operator's view.

## Decision

- Agent Deck's native `claude` or `codex` session remains the primary visible session identity for Live Editor work.
- Pixel Forge writes request packs, captures visual context, and routes into that native session instead of replacing it with a private shell abstraction.
- ACPX may exist as a structured sidecar/control layer, but it does not replace the visible session as the continuity owner unless shared-session attach is proven.

## Consequences

- Pixel Forge APIs and UI should prefer Agent Deck session ids as the operator-facing handle.
- Streaming, troubleshooting, and manual takeover should follow the native session/transcript path.
- Future structured runtime work must complement the visible session rather than hide it.
