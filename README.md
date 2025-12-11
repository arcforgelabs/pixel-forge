# visual-to-code

> **Status**: Research & Spike Phase
> **Goal**: Tools and workflows to convert visual designs into structured data specifications for agent-driven code generation

## The Problem

Agents excel at backend development but struggle with visual/UI work because:
- They work from code, not visual references
- Lack precise specifications (colors, spacing, layout)
- Over-engineer when fixing UI issues
- Break adjacent features during "fixes"

## The Solution

Build a pipeline: **Visual Design → Structured Spec → Code Generation**

```
Screenshot/Design File
        ↓
  Extraction Tool
  (Figma/Penpot/AI)
        ↓
  Structured JSON Spec
  {
    "layout": "grid-3-col-24px-gap",
    "components": [...],
    "tokens": {
      "colors": ["#3B82F6"],
      "spacing": ["24px", "16px"]
    }
  }
        ↓
  Code Generator
  (Agent + Templates)
        ↓
  React + Tailwind Code
```

## Research Phase

Currently investigating:

### 1. Figma Ecosystem
- Figma Dev Mode capabilities
- Community plugins for spec extraction
- Figma REST API for programmatic access

### 2. Open-Source Alternatives
- **Penpot** - OSS Figma alternative
- **Framer** - Design with code generation
- **Plasmic** - Visual builder
- Other OSS design tools

### 3. AI-Native Tools
- Screenshot-to-code projects (GitHub)
- Vision model-based extractors
- Design token extraction tools

### 4. Design Token Tools
- Extract colors, spacing, typography from:
  - Images/screenshots
  - Design files
  - Live websites

## Evaluation Criteria

For each tool:
- **License**: OSS? Free tier? API access?
- **Output Format**: JSON? TypeScript? CSS?
- **Capabilities**: Layout, colors, spacing, typography, components
- **Integration**: Fits into agent workflow?

## Target Use Cases

1. **Screenshot → Component**: Take screenshot, generate React component
2. **Design File → Design Tokens**: Extract colors/spacing/typography
3. **Reference UI → Implementation**: Clone existing UI with precision
4. **Fix Verification**: Compare before/after screenshots programmatically

## Related Projects

- `repos/reflex` - Evidence-based specification (pixel diffs, screenshots)
- `repos/pip-by-arc-forge` - Test case for UI regression prevention
- `~/.claude/skills/orchestrating-contracts` - API contract infrastructure
- `~/.claude/skills/frontend-aesthetics` - Design principles

## Next Steps

1. Complete tool research (in progress)
2. Create comparison matrix of top candidates
3. Build proof-of-concept with most promising tool
4. Test on real Pip UI component
5. Extract reusable patterns into skills

---

**Created**: 2025-12-11
**Related**: Joplin note "Agent Visual Design Problem", `~/.claude/ISSUES.md` issue_009
