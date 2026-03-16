# VISION.md

**Last Updated**: 2025-12-28

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
| **v2** | Embed dev apps, persistent sessions, real file edits | Complete |
| **v2.1** | Unified modes - Screenshot-to-Code + Live Editor as one experience | Complete |

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

## v2.1 Vision: Unified Modes

Two modes, one Claude brain.

```
┌─────────────────────────────────────────────────────────────┐
│  pixel-forge                                                │
│  ┌─────────────────────────────────────────────────────────┐│
│  │  [Screenshot-to-Code]  [Live Editor]     ← Mode tabs    ││
│  ├─────────────────────────────────────────────────────────┤│
│  │                                                         ││
│  │  Screenshot-to-Code:                                    ││
│  │  - Upload image → Generate HTML                         ││
│  │  - Sidebar: project settings, format selection          ││
│  │  - Preview generated code                               ││
│  │  - "Continue in Live Editor" button                     ││
│  │                                                         ││
│  │  Live Editor:                                           ││
│  │  - Embed running app via proxy                          ││
│  │  - No sidebar (full-width app view)                     ││
│  │  - Click to select, chat to edit                        ││
│  │  - Same Claude session continues conversation           ││
│  │                                                         ││
│  └─────────────────────────────────────────────────────────┘│
└─────────────────────────────────────────────────────────────┘
```

**Key insight:** Both modes benefit from the same persistent Claude session.
- Screenshot-to-Code generates initial code → Claude knows what it created
- Live Editor edits code → Claude remembers the context from generation
- Switching modes doesn't reset Claude's memory

**UX principle:** Mode-specific UI. Screenshot-to-Code needs format settings.
Live Editor needs maximum screen real estate for the embedded app.

---

## Decision Filter

When evaluating features, ask:

1. Does this tighten the visual feedback loop?
2. Does this preserve Claude's context?
3. Does this work with the user's existing dev setup?
4. Does this avoid requiring API keys?

If the answer to all four is "yes", build it.
