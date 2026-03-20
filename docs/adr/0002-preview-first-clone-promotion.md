# ADR 0002: Preview First, Promote Second For Clone-Backed Self-Edit

- Status: Accepted
- Date: 2026-03-20

## Context

Pixel Forge edits itself through isolated clone-backed sessions. Those sessions need to be useful immediately without silently becoming controller installs. Operators need to inspect the changed UI in a real mirror first, decide whether the change is worth keeping, then promote it into the canonical root and only after that stage/apply a controller update.

## Decision

- Clone-backed self-edit sessions publish preview-only frozen mirror updates scoped to the clone/session.
- The installed controller update lane stages from the canonical root by default, not directly from clone workspaces.
- Promotion from clone to controller follows an explicit sequence:
  1. clone session work
  2. preview mirror candidate
  3. promote into canonical root
  4. stage/apply controller update

## Consequences

- Seeing a change in a mirror preview is not the same as accepting it into canonical repo truth.
- Closeout and promotion flows must reconcile clone deltas explicitly.
- Preview reload and controller update remain separate operator surfaces.
