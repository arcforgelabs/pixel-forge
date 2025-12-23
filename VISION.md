# VISION.md

**Last Updated**: 2025-12-23

---

Point at your screen. Tell Claude what to change. Watch it happen.

Visual feedback is faster than describing code. Claude should see what you see.

Before building, ask: does this make the feedback loop tighter?

---

## Core Axioms

1. **Visual > Verbal**: Pointing at an element beats describing it in words
2. **Context is King**: Claude with project context beats Claude without it
3. **Subscription > API Credits**: Power users shouldn't pay twice for Claude
4. **Iterate, Don't Regenerate**: Modify existing code, don't start from scratch

---

## The Evolution

| Phase | What | Status |
|-------|------|--------|
| **v0** | SDK that calls Claude API directly | Archived |
| **v1** | Wrap screenshot-to-code with Claude CLI proxy | Complete |
| **v2** | Embed dev apps, persistent sessions, real file edits | Planning |

---

## v2 Vision: Visual Code Editor

```
┌─────────────────────────────────────────────────────────────┐
│  pixel-forge                                                │
│  ┌─────────────────────┐  ┌─────────────────────────────┐  │
│  │  Your Running App   │  │  Claude (persistent session) │  │
│  │  localhost:3000     │  │  Full project context        │  │
│  │                     │  │                              │  │
│  │  [Select Element]   │  │  "Make this button blue"     │  │
│  │         ↓           │  │           ↓                  │  │
│  │  outerHTML captured │  │  Edits src/Button.tsx        │  │
│  └─────────────────────┘  └─────────────────────────────┘  │
└─────────────────────────────────────────────────────────────┘
```

**Key differences from screenshot-to-code:**
- Embeds your actual running app (not generated HTML preview)
- Claude has persistent session (remembers previous changes)
- Modifies real source files (not generates new code)
- Uses Claude subscription (not API credits)

---

## Decision Filter

When evaluating features, ask:

1. Does this tighten the visual feedback loop?
2. Does this preserve Claude's context?
3. Does this work with the user's existing dev setup?
4. Does this avoid requiring API keys?

If the answer to all four is "yes", build it.
