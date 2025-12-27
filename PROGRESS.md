# Visual-to-Code Integration Progress

**Project**: Rework visual-to-code fork with Claude Code integration
**Last Updated**: 2025-12-27
**Status**: MVP Complete - Claude CLI proxy working
**Workflow Tier**: Simple (main branch only)
**Tracking Method**: Document-based (PROGRESS.md + ISSUES.md)

---

## Current: MVP Claude CLI Proxy

**Status**: ✅ Working (2025-12-23)

Routes screenshot-to-code through Claude CLI for subscription billing instead of raw API credits.

### Completed
- ✅ Proof of concept: Claude CLI can read images and generate HTML
- ✅ Proxy backend (`claude-proxy/main.py`) - FastAPI WebSocket server
- ✅ Image input support - base64 → temp file → Claude CLI
- ✅ Video input support - frame extraction via moviepy → grid image
- ✅ Frontend integration - screenshot-to-code UI connects to proxy
- ✅ App proxy with script injection for dev app embedding

### Architecture
```
Frontend (localhost:5173) → Proxy (localhost:7001) → Claude CLI → Subscription
```

### Known Issues
- Video output quality needs tuning (prompt refinement)
- Claude sometimes outputs thinking text instead of pure code

---

## Next Priority: Visual Editor Mode

**Status**: 🟡 In Progress (UI done, backend wiring needed)
**Goal**: Point at elements in your running app, tell Claude what to change, watch it happen.

This is the core differentiator from screenshot-to-code: editing real apps with persistent context.

### What's Built

| Component | Status | File |
|-----------|--------|------|
| App proxy with script injection | ✅ Done | `app_proxy.py` |
| Element selector (hover/click) | ✅ Done | `SELECTION_SCRIPT` in app_proxy.py |
| Element data capture (XPath, outerHTML, classes) | ✅ Done | postMessage to parent |
| WebSocket passthrough for HMR | ✅ Done | `proxy_websocket()` |
| Test harness UI | ✅ Done | `test-harness.html` |
| "Send to Claude" button | ✅ Done | Wired to `/edit-element` endpoint |
| `/edit-element` endpoint | ✅ Done | `main.py:656` |
| Project path input | ✅ Done | `test-harness.html` |

### What's Missing

| Component | Complexity | Description |
|-----------|------------|-------------|
| ~~Element → Claude endpoint~~ | ~~Low~~ | ✅ Done - `/edit-element` WebSocket endpoint |
| Session manager | Medium | Persist Claude sessions per project (ADR-002) |
| ~~Wire test harness to endpoint~~ | ~~Low~~ | ✅ Done - WebSocket integration |
| ~~Project directory awareness~~ | ~~Low~~ | ✅ Done - Project path input field |

### Implementation Tasks

1. ~~**Create `/edit-element` WebSocket endpoint**~~ ✅ Done
   - Receives element data + instruction + project path
   - Builds prompt with element context (outerHTML, XPath, classes)
   - Calls Claude CLI with project as cwd

2. **Add session persistence** (Medium) - See ADR-002
   - Generate session ID from project path hash
   - First request: `--session-id <uuid>`
   - Subsequent: `--resume <uuid>`
   - Session manager class to track active sessions

3. ~~**Wire test harness**~~ ✅ Done
   - WebSocket connection to `/edit-element`
   - Displays Claude's response
   - Auto-reloads iframe after successful edit

4. ~~**Project path configuration**~~ ✅ Done
   - Project path input in test harness
   - Passed to Claude CLI as working directory

### Test Harness

Access at: `http://localhost:7001/test-harness.html`

```
┌─────────────────────────────────────────────────────────────────┐
│  [Target URL: localhost:3000] [Load] [Select Mode: OFF]         │
├─────────────────────────────────┬───────────────────────────────┤
│                                 │  Selected Element             │
│   Your App (iframe)             │  <button>                     │
│   via /app/ proxy               │  .btn.primary                 │
│                                 │  XPath: /html/body/div/button │
│   [Click to select elements]    │                               │
│                                 │  [Instruction input]          │
│                                 │  [Send to Claude]             │
└─────────────────────────────────┴───────────────────────────────┘
```

---

## Future: Detailed Enhancement Planning

The milestones below represent detailed planning for future enhancements beyond the MVP.
These were created before the MVP and may need revision based on what was learned.

---

## Milestone 1: Phase 1 - API Foundation Validation

**Goal**: Validate that existing HTML/Tailwind API generation still works after SDK/CLI/Web refactor

**Status**: ✅ Complete (2025-12-18)

| ID | Epic | Features | Tasks | Complexity | Status |
|---|---|---|---|---|---|
| 1.1 | API Testing Infrastructure | 2 | 5 | Low (avg 1.8) | ✅ Complete |
| 1.2 | API Monitoring & Debugging | 1 | 3 | Low-Medium (avg 2.0) | ✅ Complete |

### Epic 1.1: API Testing Infrastructure

**Status**: ✅ Complete

#### Feature 1.1.1: API Endpoint Validation

- **Task 1.1.1.1**: Create API test suite for HTML/Tailwind endpoint
  - Complexity: 1.8 (Low)
  - Dependencies: None
  - Status: ✅ Complete

- **Task 1.1.1.2**: Validate response format and structure
  - Complexity: 1.5 (Low)
  - Dependencies: None
  - Status: ✅ Complete

- **Task 1.1.1.3**: Test error handling and edge cases
  - Complexity: 2.0 (Low)
  - Dependencies: None
  - Status: ✅ Complete

#### Feature 1.1.2: SDK Integration Testing

- **Task 1.1.2.1**: Verify SDK layer correctness
  - Complexity: 2.0 (Low)
  - Dependencies: None
  - Status: ✅ Complete

- **Task 1.1.2.2**: Test SDK/API integration points
  - Complexity: 2.3 (Low)
  - Dependencies: Task 1.1.1.1
  - Status: ✅ Complete

### Epic 1.2: API Monitoring & Debugging

**Status**: ✅ Complete

- **Task 1.2.1.1**: Set up request/response logging
  - Complexity: 1.7 (Low)
  - Status: ✅ Complete

- **Task 1.2.1.2**: Create debug endpoint for troubleshooting
  - Complexity: 2.2 (Low)
  - Status: ✅ Complete

- **Task 1.2.1.3**: Performance baseline benchmarking
  - Complexity: 2.0 (Low)
  - Status: ✅ Complete

---

## Milestone 2: Phase 2-4 - Claude Code Integration (Weeks 3-8)

**Goal**: Integrate Claude Code as execution engine with orchestration skill and CLI tool

**Status**: 🔴 Not Started

| ID | Epic | Features | Tasks | Complexity | Status |
|---|---|---|---|---|---|
| 2.1 | Claude Code Terminal Bridge | 2 | 12 (depth 4) | Medium (avg 2.5) | 🔴 Not Started |
| 2.2 | Web UI Integration | 2 | 6 | Medium (avg 2.2) | 🔴 Not Started |
| 3.1 | CLI Tool Development | 2 | 7 | Medium (avg 2.3) | 🔴 Not Started |
| 3.2 | Constraint & Validation | 1 | 4 (depth 4) | Medium (avg 2.5) | 🔴 Not Started |
| 4.1 | Agent Orchestrating Skill | 2 | 4 | Low (avg 2.1) | 🔴 Not Started |

### Epic 2.1: Claude Code Terminal Bridge (COMPLEX - Decomposed to Depth 4)

**Status**: 🔴 Not Started
**Pattern**: Horizontal Layering (OS-specific + IPC + Streaming)

#### Feature 2.1.1: Cross-Platform Terminal Spawning

**Parent Task**: task_2_1_1 (composite: 3.5 → decomposed to 4 subtasks)

- **subtask_2_1_1_1**: Linux terminal spawning implementation
  - Complexity: 2.2 (Low-Medium)
  - Dependencies: None
  - Status: 🔴 Not Started
  - Acceptance: gnome-terminal, konsole, xterm support; unit tests on Ubuntu/Debian/Fedora

- **subtask_2_1_1_2**: macOS terminal spawning with AppleScript
  - Complexity: 2.1 (Low-Medium)
  - Dependencies: None
  - Status: 🔴 Not Started
  - Acceptance: Terminal.app/iTerm2 support; window focus handling; tests on macOS 13+

- **subtask_2_1_1_3**: Windows cmd/PowerShell automation
  - Complexity: 2.3 (Low-Medium)
  - Dependencies: None
  - Status: 🔴 Not Started
  - Acceptance: Windows Terminal/cmd/PowerShell support; UTF-8 encoding; tests on Windows 10/11

- **subtask_2_1_1_4**: Cross-platform abstraction layer
  - Complexity: 2.0 (Low)
  - Dependencies: subtask_2_1_1_1, subtask_2_1_1_2, subtask_2_1_1_3
  - Status: 🔴 Not Started
  - Acceptance: Single spawnTerminal() API; OS detection; fallback; unit tests

#### Feature 2.1.2: Prompt Injection & Output Capture (COMPLEX - Decomposed to Depth 4)

**Parent Task**: task_2_1_2 + task_2_1_3 (composite: 3.0 + 3.2 → 7 subtasks total)

**Prompt Injection Subtasks** (task_2_1_2):

- **subtask_2_1_2_1**: Prompt escaping and sanitization
  - Complexity: 2.3 (Low-Medium)
  - Dependencies: None
  - Status: 🔴 Not Started
  - Acceptance: Quote/newline/special char escaping; command injection prevention; Unicode support; unit tests

- **subtask_2_1_2_2**: Stdin pipe injection implementation
  - Complexity: 2.5 (Low-Medium)
  - Dependencies: subtask_2_1_2_1
  - Status: 🔴 Not Started
  - Acceptance: UTF-8 stdin write; buffer large prompts; handle write failures; error detection

- **subtask_2_1_2_3**: IPC error handling and recovery
  - Complexity: 2.7 (Low-Medium)
  - Dependencies: subtask_2_1_2_2
  - Status: 🔴 Not Started
  - Acceptance: Detect process crash; handle EPIPE; 30s timeout; actionable errors

**Output Capture Subtasks** (task_2_1_3):

- **subtask_2_1_3_1**: WebSocket server setup for streaming
  - Complexity: 2.3 (Low-Medium)
  - Dependencies: None
  - Status: 🔴 Not Started
  - Acceptance: WebSocket on port 8081; token auth; multi-client; graceful shutdown

- **subtask_2_1_3_2**: Stdout/stderr buffer management
  - Complexity: 2.8 (Low-Medium)
  - Dependencies: None
  - Status: 🔴 Not Started
  - Acceptance: 10MB buffer; backpressure handling; large output (>100MB) tests; rapid bursts

- **subtask_2_1_3_3**: Partial output parsing and chunking
  - Complexity: 2.7 (Low-Medium)
  - Dependencies: subtask_2_1_3_2
  - Status: 🔴 Not Started
  - Acceptance: ANSI codes preserved; <64KB chunks; incomplete UTF-8 handling; real Claude Code tests

- **subtask_2_1_3_4**: Real-time WebSocket streaming pipeline
  - Complexity: 2.5 (Low-Medium)
  - Dependencies: subtask_2_1_3_1, subtask_2_1_3_3
  - Status: 🔴 Not Started
  - Acceptance: <500ms latency; reconnection without data loss; end-of-stream event; E2E tests

### Epic 2.2: Web UI Integration with Claude Code

**Status**: 🔴 Not Started

- **Feature 2.2.1**: Web UI → Claude Code launcher
  - **Task 2.2.1.1**: Build terminal spawn UI component
    - Complexity: 2.0 (Low)
    - Status: 🔴 Not Started

  - **Task 2.2.1.2**: Implement prompt input form
    - Complexity: 1.8 (Low)
    - Status: 🔴 Not Started

- **Feature 2.2.2**: Output streaming to Web UI
  - **Task 2.2.2.1**: Build WebSocket client in React
    - Complexity: 2.2 (Low-Medium)
    - Status: 🔴 Not Started

  - **Task 2.2.2.2**: Render live output with ANSI support
    - Complexity: 2.3 (Low-Medium)
    - Status: 🔴 Not Started

- **Feature 2.2.3**: Constraint validation post-generation (COMPLEX - Decomposed to Depth 4)
  - **Parent Task**: task_2_2_3 (composite: 3.2 → 4 subtasks)

  - **subtask_3_2_3_1**: HTML/CSS/JS parsing and AST generation
    - Complexity: 2.5 (Low-Medium)
    - Dependencies: None
    - Status: 🔴 Not Started
    - Acceptance: htmlparser2, postcss, acorn; malformed handling; structured errors

  - **subtask_3_2_3_2**: Linting and code quality checks
    - Complexity: 2.3 (Low-Medium)
    - Dependencies: subtask_3_2_3_1
    - Status: 🔴 Not Started
    - Acceptance: ESLint, stylelint, HTMLHint; configurable rules; aggregated results

  - **subtask_3_2_3_3**: Accessibility scanning with axe-core
    - Complexity: 2.7 (Low-Medium)
    - Dependencies: subtask_3_2_3_1
    - Status: 🔴 Not Started
    - Acceptance: WCAG 2.1 AA; headless browser; violation selectors; threshold config

  - **subtask_3_2_3_4**: Constraint violation reporting and retry logic
    - Complexity: 2.5 (Low-Medium)
    - Dependencies: subtask_3_2_3_2, subtask_3_2_3_3
    - Status: 🔴 Not Started
    - Acceptance: Combined report; failed gen detection; retry in prompt; 3-retry limit

### Epic 3.1: CLI Tool Development

**Status**: 🔴 Not Started

- **Feature 3.1.1**: Single-task CLI invocation
  - **Task 3.1.1.1**: Build CLI argument parser
    - Complexity: 2.0 (Low)
    - Status: 🔴 Not Started

  - **Task 3.1.1.2**: Implement image input handling
    - Complexity: 1.9 (Low)
    - Status: 🔴 Not Started

- **Feature 3.1.2**: Programmatic constraint system
  - **Task 3.1.2.1**: Define constraint format and validation
    - Complexity: 2.2 (Low-Medium)
    - Status: 🔴 Not Started

  - **Task 3.1.2.2**: Integrate constraints into prompt
    - Complexity: 2.1 (Low-Medium)
    - Status: 🔴 Not Started

  - **Task 3.1.2.3**: Error handling for constraint violations
    - Complexity: 2.3 (Low-Medium)
    - Status: 🔴 Not Started

### Epic 3.2: Constraint & Validation System

**Status**: 🔴 Not Started (see Epic 2.2.3 for subtask details)

### Epic 4.1: Agent Orchestrating Skill

**Status**: 🔴 Not Started

- **Feature 4.1.1**: User preference gathering
  - **Task 4.1.1.1**: Build AskUserQuestion preference flow
    - Complexity: 2.0 (Low)
    - Dependencies: None
    - Status: 🔴 Not Started
    - Acceptance: Format selection (7 formats); style options; confirmation UI

  - **Task 4.1.1.2**: Preference validation and routing
    - Complexity: 1.9 (Low)
    - Dependencies: Task 4.1.1.1
    - Status: 🔴 Not Started

- **Feature 4.1.2**: Visual generation orchestration
  - **Task 4.1.2.1**: Route to appropriate handler (web/CLI/API)
    - Complexity: 2.2 (Low-Medium)
    - Dependencies: Task 4.1.1.2
    - Status: 🔴 Not Started

  - **Task 4.1.2.2**: Error handling and retry orchestration
    - Complexity: 2.3 (Low-Medium)
    - Dependencies: Task 4.1.2.1
    - Status: 🔴 Not Started

---

## Milestone 3: Phase 5 - Iterative Automation (Weeks 9-12)

**Goal**: Integrate reflex toolkit for iterative eval feedback and multi-pass automation

**Status**: 🔴 Not Started
**Critical**: Requires 2 spike tasks first (see ISSUES.md)

| ID | Epic | Features | Tasks | Complexity | Status |
|---|---|---|---|---|---|
| 5.1 | Multi-Format Support | 1 | 5 (depth 4) | Medium (avg 2.6) | 🔴 Not Started |
| 6.1 | Eval Framework Setup | 1 | 5 (depth 4) | Medium (avg 2.6) | ⚠️ Awaiting Spike |
| 6.2 | Feedback Loop & Iteration | 1 | 5 (depth 4-5) | Medium-High (avg 2.8) | ⚠️ Awaiting Spike |

### Epic 5.1: Multi-Format Support Migration (COMPLEX - Decomposed to Depth 4)

**Status**: 🔴 Not Started
**Pattern**: Vertical Slicing (one format = one subtask)
**Note**: Starts with 7 formats total (HTML/CSS, HTML/Tailwind, React/Tailwind, Bootstrap, Vue/Tailwind, Ionic/Tailwind, SVG). First 2 exist at depth 3; last 4 decomposed below.

- **Task 5.1.1**: HTML + CSS format support (existing depth 3)
  - Complexity: 2.2 (Low-Medium)
  - Status: 🔴 Not Started

- **Task 5.1.2**: React + Tailwind format support (existing depth 3)
  - Complexity: 2.4 (Low-Medium)
  - Status: 🔴 Not Started

**Additional Formats** (task_5_1_3 decomposed to subtasks):

- **subtask_5_1_3_1**: Migrate Bootstrap format backend prompts
  - Complexity: 2.5 (Low-Medium)
  - Dependencies: None
  - Status: 🔴 Not Started
  - Acceptance: Upstream Bootstrap prompt extraction; SDK routing; responsive grid tests

- **subtask_5_1_3_2**: Migrate Vue/Tailwind format backend prompts
  - Complexity: 2.5 (Low-Medium)
  - Dependencies: None
  - Status: 🔴 Not Started
  - Acceptance: Vue 3 SFC syntax; <script setup>; reactive bindings; Tailwind classes

- **subtask_5_1_3_3**: Migrate Ionic/Tailwind format backend prompts
  - Complexity: 2.7 (Low-Medium)
  - Dependencies: None
  - Status: 🔴 Not Started
  - Acceptance: Ionic 7.x components; ion-header/content/card; Tailwind integration; mobile responsive

- **subtask_5_1_3_4**: Migrate SVG format backend prompts
  - Complexity: 2.3 (Low-Medium)
  - Dependencies: None
  - Status: 🔴 Not Started
  - Acceptance: SVG viewBox/paths/shapes; color extraction; gradient reproduction; scalable graphics

- **subtask_5_1_3_5**: Integration testing across all 7 formats
  - Complexity: 2.8 (Low-Medium)
  - Dependencies: subtask_5_1_3_1, subtask_5_1_3_2, subtask_5_1_3_3, subtask_5_1_3_4
  - Status: 🔴 Not Started
  - Acceptance: 10 reference screenshots per format; syntax/structure/responsiveness validation; <30s generation; regression tests

### Epic 6.1: Eval Framework Setup (COMPLEX - Decomposed to Depth 4)

**Status**: ⚠️ **BLOCKED - Awaiting Spike Task** (see ISSUES.md → Spike_1)

**Parent Task**: feature_6_1 (uncertainty: 4)

- **Spike Task**: task_6_1_1 - Research eval metrics for iterative refinement
  - **Duration**: 3-5 days
  - **Status**: 🔴 Not Started
  - **Deliverable**: Metric selection report (SSIM vs pHash vs LPIPS comparison, correlation with user satisfaction)
  - **Reduces Uncertainty**: 4/5 → 2/5

**After spike completion, implement**:

- **subtask_6_1_2_1**: Playwright screenshot capture pipeline
  - Complexity: 2.7 (Low-Medium)
  - Dependencies: None
  - Status: 🔴 Not Started (blocked until spike done)
  - Acceptance: Headless browser launch; full-page renders; viewport handling; error tolerance

- **subtask_6_1_2_2**: Image similarity metric computation
  - Complexity: 2.8 (Low-Medium)
  - Dependencies: subtask_6_1_2_1
  - Status: 🔴 Not Started (blocked until spike done)
  - Acceptance: SSIM or pHash metric; image normalization; similarity 0.0-1.0; alternative implementation

- **subtask_6_1_2_3**: Accessibility scoring with axe-core metrics
  - Complexity: 2.5 (Low-Medium)
  - Dependencies: subtask_6_1_2_1
  - Status: 🔴 Not Started (blocked until spike done)
  - Acceptance: WCAG 2.1 AA ruleset; weighted violations; accessibility score 0.0-1.0

- **subtask_6_1_2_4**: Bundle size and performance analysis
  - Complexity: 2.3 (Low-Medium)
  - Dependencies: None
  - Status: 🔴 Not Started
  - Acceptance: HTML/CSS/JS size measurement; CSS complexity count; budget comparison; pass/fail

- **subtask_6_1_2_5**: Unified eval report generation
  - Complexity: 2.0 (Low)
  - Dependencies: subtask_6_1_2_2, subtask_6_1_2_3, subtask_6_1_2_4
  - Status: 🔴 Not Started
  - Acceptance: JSON report with all metrics; composite score; threshold-based pass/fail; file logging

### Epic 6.2: Feedback Loop & Iteration (COMPLEX - Decomposed to Depth 4-5)

**Status**: ⚠️ **BLOCKED - Awaiting Spike Task** (see ISSUES.md → Spike_2)

**Parent Task**: feature_6_2 (uncertainty: 4) → task_6_2_2 decomposed

- **Spike Task**: task_6_2_1 - Investigate prompt optimization strategies
  - **Duration**: 3-5 days
  - **Status**: 🔴 Not Started
  - **Deliverable**: Prompt refinement strategy document (which eval signals feed back to prompt, examples, convergence heuristics)
  - **Reduces Uncertainty**: 4/5 → 2/5

**After spike completion, implement state machine**:

- **subtask_6_2_2_1**: State machine for iteration lifecycle
  - Complexity: 2.8 (Low-Medium)
  - Dependencies: None
  - Status: 🔴 Not Started (blocked until spike done)
  - Acceptance: 6-state FSM; iteration history tracking; state transition error handling; unit tests

- **subtask_6_2_2_2**: Rate limiting and cost tracking
  - Complexity: 2.5 (Low-Medium)
  - Dependencies: None
  - Status: 🔴 Not Started
  - Acceptance: 5-iteration max; token tracking; cost estimation ($0.003/1K in, $0.015/1K out); $1.00 budget

- **subtask_6_2_2_3**: Convergence detection heuristics
  - Complexity: 2.7 (Low-Medium)
  - Dependencies: subtask_6_2_2_1
  - Status: 🔴 Not Started (blocked until spike done)
  - Acceptance: Plateau detection (<0.05 improvement); regression detection; threshold (0.85); convergence logging

- **subtask_6_2_2_4**: Prompt refinement integration
  - Complexity: 2.8 (Low-Medium)
  - Dependencies: subtask_6_2_2_1
  - Status: 🔴 Not Started (blocked until spike done)
  - Acceptance: Eval violations → constraints in prompt; accessibility/visual feedback; prompt growth control

- **subtask_6_2_2_5**: Full pipeline orchestration and error recovery
  - Complexity: 3.0 (Medium - at threshold)
  - Dependencies: subtask_6_2_2_1, subtask_6_2_2_2, subtask_6_2_2_3, subtask_6_2_2_4
  - Status: 🔴 Not Started (blocked until spike done)
  - Acceptance: Full generate→eval→refine→regenerate loop; stage failure handling; iteration history logging; E2E tests

**Contingency Decomposition** (if subtask_6_2_2_5 proves complex during implementation):

- **subtask_6_2_2_5_1**: Pipeline stage orchestrator
  - Complexity: 2.3 (Low-Medium)
  - Status: 🔴 Not Started (contingency only)

- **subtask_6_2_2_5_2**: Error recovery and retry logic
  - Complexity: 2.5 (Low-Medium)
  - Status: 🔴 Not Started (contingency only)

- **subtask_6_2_2_5_3**: Iteration history logging and telemetry
  - Complexity: 2.0 (Low)
  - Status: 🔴 Not Started (contingency only)

---

## Summary by Phase

| Phase | Timeline | Epics | Features | Tasks | Avg Complexity | Status |
|-------|----------|-------|----------|-------|----------------|---------|
| 1 | Weeks 1-2 | 2 | 3 | 8 | 1.9 (Low) | ✅ Complete |
| 2-4 | Weeks 3-8 | 4 | 8 | 29 (26 depth 3-4) | 2.3 (Low-Med) | 🔴 Not Started |
| 5 | Weeks 9-12 | 3 | 5 | 15 (depth 4-5) | 2.6 (Low-Med) | 🔴 Spikes Complete, Not Started |

**Total Work**: 3 milestones, 9 epics, 16 features, 52 tasks/subtasks

---

## Key Dependencies & Sequencing

### Critical Path

1. **Phase 1** (independent) → Phase 2-4 foundation
2. **Phase 2.1** (Terminal + IPC) → Phase 2.2 (Web UI integration)
3. **Phase 2.2** + **Phase 3.1-3.2** (in parallel) → Phase 4 (orchestrating skill)
4. **Phase 5.1** (formats) → independent
5. **Spike 1** (3 days) → **Phase 6.1** (eval metrics)
6. **Spike 2** (4 days) → **Phase 6.2** (feedback loop)

### Parallel Execution Opportunities

- **Phase 1 epics**: Independent, can run in parallel (2 agents)
- **Phase 2.1 subtasks**: Platform implementations (Linux/macOS/Windows) in parallel (3 agents)
- **Phase 2.1.2 subtasks**: Prompt injection and output capture in separate tracks (2 agents)
- **Phase 3 features**: CLI tool and constraint validation independent (2 agents)
- **Phase 5.1 format migrations**: All 6 formats in parallel (6 agents)
- **Phase 6.1 metrics**: Playwright + accessibility + performance in parallel (3 agents)

---

## Next Steps

1. **Live Editor v2** - See below for detailed task tracking
2. Fix MVP known issues (video quality, thinking text in output)
3. Future: Evaluate which detailed milestones align with current architecture

---

## Live Editor v2 - Feature Enhancement

**Blueprint**: `specs/archive/BLUEPRINT-feature-live-editor-v2-20251227.yaml`
**Status**: :yellow_circle: In Progress
**Tracking**: Document-based

### Research References
- **aim-up**: `~/repos/2-areas/aim-up/dashboard/` - Chat patterns, streaming, tool viz
- **open-webui**: https://github.com/open-webui/open-webui - UI patterns

### Phase 1: Foundation
| ID | Task | Complexity | Status |
|----|------|------------|--------|
| task_1_1 | Create chat store with Zustand | 1.4 | :red_circle: Not Started |
| task_2_3 | Add selection state to store | 1.2 | :red_circle: Not Started |

### Phase 2: Chat Components
| ID | Task | Complexity | Status |
|----|------|------------|--------|
| task_1_2 | Create ChatMessages component | 1.4 | :red_circle: Not Started |
| task_1_3 | Create ToolCard component | 1.4 | :red_circle: Not Started |
| task_1_4 | Create ChatInput component | 1.0 | :red_circle: Not Started |

### Phase 3: Backend Streaming
| ID | Task | Complexity | Status |
|----|------|------------|--------|
| task_1_5 | Update backend /edit-element for streaming | 2.2 | :red_circle: Not Started |

### Phase 4: Selection Persistence
| ID | Task | Complexity | Status |
|----|------|------------|--------|
| task_2_1 | Update selection script for persistence | 1.8 | :red_circle: Not Started |
| task_2_2 | Create SelectedElementsList component | 1.6 | :red_circle: Not Started |

### Phase 5: Multi-Select
| ID | Task | Complexity | Status |
|----|------|------------|--------|
| task_3_1 | Update selection script for multi-select | 2.0 | :red_circle: Not Started |
| task_3_2 | Context chips for multi-selection | 1.8 | :red_circle: Not Started |
| task_3_3 | Build context from multiple elements | 1.6 | :red_circle: Not Started |

### Phase 6: Integration
| ID | Task | Complexity | Status |
|----|------|------------|--------|
| task_1_6 | Integrate chat UI into LiveEditorPane | 2.2 | :red_circle: Not Started |

### Feature Summary

| Feature | Tasks | Complete |
|---------|-------|----------|
| Full Chat Interface | 6 | 0/6 |
| Persistent Element Selection | 3 | 0/3 |
| Multi-Element Selection | 3 | 0/3 |

### Files to Create
```
screenshot-to-code/frontend/src/components/live-editor/
├── store/
│   └── chat-store.ts          # task_1_1, task_2_3
├── ChatMessages.tsx            # task_1_2
├── ToolCard.tsx                # task_1_3
├── ChatInput.tsx               # task_1_4
├── SelectedElementsList.tsx    # task_2_2
└── ContextChips.tsx            # task_3_2
```

### Files to Modify
```
claude-proxy/
├── main.py                     # task_1_5 (streaming)
└── app_proxy.py                # task_2_1, task_3_1 (SELECTION_SCRIPT)

screenshot-to-code/frontend/src/components/live-editor/
└── LiveEditorPane.tsx          # task_1_6, task_3_2
```
