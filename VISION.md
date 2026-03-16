# Vision

Pixel Forge should shorten the loop between seeing a UI problem and changing the real app.

## Core Claim

Pointing at a live interface is better context than describing it from memory.

## Product Shape

```text
Screenshot mode
  -> bootstrap a UI idea from an image

Live Editor
  -> load a real running app
  -> select a real element
  -> pass that selected context into Claude
  -> edit the real project
```

## Decision Filter

Keep work only if it improves at least one of these:
- tighter screenshot-to-edit loop
- better selected-element context
- clearer project/session continuity
- less duplicated runtime surface

Reject work that creates a second product boundary or revives legacy nested-app structure.
