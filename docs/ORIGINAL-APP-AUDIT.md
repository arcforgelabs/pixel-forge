# Screenshot-to-Code Original Application Audit

**Date:** 2025-12-12
**Status:** Complete
**Source:** `screenshot-to-code/` directory (forked from abi/screenshot-to-code)

---

## Table of Contents

1. [Executive Summary](#1-executive-summary)
2. [Architecture Overview](#2-architecture-overview)
3. [UI Layout & Navigation](#3-ui-layout--navigation)
4. [Input System](#4-input-system)
5. [Code Generation Pipeline](#5-code-generation-pipeline)
6. [Variant System](#6-variant-system)
7. [Preview System](#7-preview-system)
8. [Select & Edit Mode](#8-select--edit-mode)
9. [Update Mechanism](#9-update-mechanism)
10. [History & Version Control](#10-history--version-control)
11. [Settings & Configuration](#11-settings--configuration)
12. [WebSocket & Streaming](#12-websocket--streaming)
13. [Prompt Engineering](#13-prompt-engineering)
14. [File Reference Index](#14-file-reference-index)

---

## 1. Executive Summary

The original screenshot-to-code application is a full-featured React + FastAPI application that converts screenshots/videos to functional code. Key capabilities:

- **4 concurrent variant generation** with different LLM models
- **Real-time WebSocket streaming** with token-by-token updates
- **Live HTML preview rendering** with responsive viewport controls
- **Select & Edit mode** for click-to-modify element updates
- **Git-like version control** with commit chains and history navigation
- **7 output frameworks** (HTML/Tailwind, HTML/CSS, React, Vue, Bootstrap, Ionic, SVG)
- **3 LLM providers** (OpenAI, Anthropic Claude, Google Gemini)
- **Multi-pass video mode** with frame extraction

### Technology Stack

| Layer | Technology |
|-------|------------|
| Frontend | React 18, TypeScript, Vite, Zustand, Tailwind CSS |
| Backend | FastAPI, Python 3.11+, uvicorn |
| Communication | WebSocket (real-time streaming) |
| LLM Providers | OpenAI, Anthropic, Google AI |
| State Management | Zustand (frontend), Dataclass context (backend) |

---

## 2. Architecture Overview

### High-Level Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                    React Frontend (5173)                      │
│  ┌──────────┬──────────┬──────────┬──────────┬──────────┐   │
│  │ StartPane│ Sidebar  │ Variants │ Preview  │ Settings │   │
│  │ (Upload) │ (Actions)│ (Grid)   │ (Iframe) │ (Dialog) │   │
│  └──────────┴──────────┴──────────┴──────────┴──────────┘   │
│                           │                                   │
│                    WebSocket Client                           │
└───────────────────────────┼───────────────────────────────────┘
                            │ ws://localhost:7001/generate-code
┌───────────────────────────┼───────────────────────────────────┐
│                    FastAPI Backend (7001)                      │
│  ┌─────────────────────────────────────────────────────────┐ │
│  │              Middleware Pipeline                          │ │
│  │  WebSocketSetup → ParameterExtraction → StatusBroadcast  │ │
│  │  → PromptCreation → CodeGeneration → PostProcessing      │ │
│  └─────────────────────────────────────────────────────────┘ │
│                           │                                   │
│              ┌────────────┼────────────┐                     │
│              ▼            ▼            ▼                     │
│         ┌────────┐  ┌─────────┐  ┌────────┐                 │
│         │ OpenAI │  │ Claude  │  │ Gemini │                 │
│         └────────┘  └─────────┘  └────────┘                 │
└───────────────────────────────────────────────────────────────┘
```

### Directory Structure

```
screenshot-to-code/
├── frontend/                    # React application
│   ├── src/
│   │   ├── components/          # UI components
│   │   │   ├── preview/         # Preview rendering
│   │   │   ├── variants/        # Variant grid
│   │   │   ├── settings/        # Settings dialog
│   │   │   ├── sidebar/         # Action sidebar
│   │   │   ├── select-and-edit/ # Click-to-edit feature
│   │   │   ├── commits/         # Version history
│   │   │   ├── history/         # History navigation
│   │   │   └── start-pane/      # Initial upload UI
│   │   ├── store/               # Zustand state stores
│   │   ├── hooks/               # Custom React hooks
│   │   ├── lib/                 # Utilities
│   │   ├── generateCode.ts      # WebSocket client
│   │   ├── App.tsx              # Main application
│   │   └── types.ts             # TypeScript definitions
│   └── package.json
├── backend/
│   ├── routes/
│   │   └── generate_code.py     # WebSocket endpoint (959 lines)
│   ├── prompts/                 # System prompts by framework
│   │   ├── __init__.py          # Prompt assembly
│   │   ├── screenshot_system_prompts.py
│   │   ├── imported_code_prompts.py
│   │   ├── text_prompts.py
│   │   └── claude_prompts.py
│   ├── models/                  # LLM client implementations
│   │   ├── openai_client.py
│   │   ├── claude.py
│   │   └── gemini.py
│   ├── video/                   # Video processing
│   ├── image_generation/        # DALL-E integration
│   ├── config.py                # Configuration
│   ├── llm.py                   # Model definitions
│   └── main.py                  # FastAPI app
└── README.md
```

---

## 3. UI Layout & Navigation

### 3.1 Application States

**File:** `frontend/src/App.tsx`

```typescript
enum AppState {
  INITIAL,      // Upload screen shown
  CODING,       // Generation in progress
  CODE_READY    // Results displayed
}
```

**State Transitions:**
```
INITIAL → (upload/generate) → CODING → (complete) → CODE_READY
                                            ↑
CODE_READY → (regenerate/update) ───────────┘
```

### 3.2 Layout Structure

**INITIAL State:**
```
┌─────────────────────────────────────────────┐
│              StartPane (Full Screen)         │
│  ┌─────────────────────────────────────────┐│
│  │         Upload Zone (drag & drop)       ││
│  │    ┌──────────────────────────────┐     ││
│  │    │  Drop screenshot here        │     ││
│  │    │  or click to upload          │     ││
│  │    └──────────────────────────────┘     ││
│  │                                         ││
│  │  [Stack Selector] [Model Selector]      ││
│  └─────────────────────────────────────────┘│
└─────────────────────────────────────────────┘
```

**CODE_READY State:**
```
┌─────────────────────────────────────────────────────────────────┐
│                         Header Bar                               │
├────────────┬────────────────────────────────────────────────────┤
│            │           Variant Grid (2x2)                        │
│  Sidebar   │  ┌──────────────┐  ┌──────────────┐                │
│            │  │  Variant 1   │  │  Variant 2   │                │
│ [Regen]    │  │  (Selected)  │  │              │                │
│ [Select]   │  └──────────────┘  └──────────────┘                │
│ [Update]   │  ┌──────────────┐  ┌──────────────┐                │
│            │  │  Variant 3   │  │  Variant 4   │                │
│ Console    │  │              │  │              │                │
│            │  └──────────────┘  └──────────────┘                │
├────────────┴────────────────────────────────────────────────────┤
│                    Preview/Code Pane                             │
│  ┌───────────────────────────────────────────────────────────┐  │
│  │                   Live HTML Preview                       │  │
│  │              (or CodeMirror editor)                       │  │
│  └───────────────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────────┘
```

### 3.3 Component Hierarchy

```
App.tsx
├── StartPane (when INITIAL)
│   ├── UploadDropzone
│   ├── OutputSettingsSection (stack selector)
│   └── ImageUpload
└── (when CODING/CODE_READY)
    ├── Sidebar
    │   ├── RegenerateButton
    │   ├── SelectAndEditModeToggleButton
    │   ├── UpdateImageUpload
    │   ├── UpdateImagePreview
    │   ├── Textarea (update instructions)
    │   └── ExecutionConsole
    ├── Variants
    │   └── VariantItem[] (grid of 4)
    ├── PreviewPane
    │   ├── DeviceSelector
    │   ├── ViewToggle (preview/code)
    │   └── PreviewComponent / CodeMirror
    ├── HistoryPanel
    └── SettingsDialog
```

### 3.4 Keyboard Shortcuts

| Shortcut | Action | Location |
|----------|--------|----------|
| Alt+1 through Alt+9 | Select variant by number | Variants.tsx:57-79 |
| Enter | Submit update (in textarea) | EditPopup.tsx:134-138 |
| Escape | Close dialogs | Various components |

---

## 4. Input System

### 4.1 Input Modes

**File:** `frontend/src/types.ts`

```typescript
type InputMode = "image" | "video" | "text";
```

### 4.2 Image Upload

**Components:**
- `StartPane.tsx` - Initial upload UI
- `ImageUpload.tsx` - File selector
- `UpdateImageUpload.tsx` - Multi-image for updates

**Supported Formats:**
- PNG, JPEG, GIF, WebP
- Drag & drop or click to upload
- Paste from clipboard
- URL import via ScreenshotOne API

**Processing Flow:**
```
File Selected → FileReader.readAsDataURL() → Base64 Data URL
     ↓
Store in referenceImages[] state
     ↓
Send via WebSocket as prompt.images[]
```

### 4.3 Video Upload

**File:** `backend/video/utils.py`

**Processing:**
1. Decode base64 video data URL
2. Extract MIME type for file extension
3. Create temporary file
4. Calculate frame skip interval: `max(1, ceil(total_frames / 20))`
5. Extract up to 20 frames as PIL Images
6. Convert to JPEG base64 for Claude

**Maximum Frames:** 20 (to manage token limits)

### 4.4 Text Mode

**File:** `frontend/src/components/start-pane/StartPane.tsx`

- Toggle between image and text mode
- Text description input with placeholder
- Uses `TEXT_SYSTEM_PROMPTS` for generation

### 4.5 Import from Code

**Feature:** Paste existing HTML to modify

**Flow:**
1. User pastes code in textarea
2. `isImportedFromCode` flag set to `true`
3. Uses `IMPORTED_CODE_SYSTEM_PROMPTS`
4. Code becomes first history item

---

## 5. Code Generation Pipeline

### 5.1 Middleware Architecture

**File:** `backend/routes/generate_code.py`

```python
@router.websocket("/generate-code")
async def stream_code(websocket: WebSocket):
    pipeline = Pipeline()
    pipeline.use(WebSocketSetupMiddleware())
    pipeline.use(ParameterExtractionMiddleware())
    pipeline.use(StatusBroadcastMiddleware())
    pipeline.use(PromptCreationMiddleware())
    pipeline.use(CodeGenerationMiddleware())
    pipeline.use(PostProcessingMiddleware())
    await pipeline.execute(websocket)
```

### 5.2 Pipeline Stages

| Stage | Purpose | Key Operations |
|-------|---------|----------------|
| WebSocketSetup | Connection lifecycle | Accept, cleanup in finally |
| ParameterExtraction | Validate inputs | Stack, mode, API keys |
| StatusBroadcast | Initial messages | variantCount, status per variant |
| PromptCreation | Build prompts | System prompt + user content |
| CodeGeneration | Parallel streaming | 3 concurrent model tasks |
| PostProcessing | Finalize output | Image generation, logging |

### 5.3 Pipeline Context

```python
@dataclass
class PipelineContext:
    websocket: WebSocket
    ws_comm: WebSocketCommunicator | None
    params: Dict[str, str]
    extracted_params: ExtractedParams | None
    prompt_messages: List[ChatCompletionMessageParam]
    image_cache: Dict[str, str]
    variant_models: List[Llm]
    completions: List[str]
    variant_completions: Dict[int, str]
    metadata: Dict[str, Any]
```

### 5.4 Model Selection Logic

**File:** `backend/routes/generate_code.py:620-634`

```python
# For creation, use Claude Sonnet 3.7
# For updates, use Claude Sonnet 4.5
if params["generationType"] == "create":
    claude_model = Llm.CLAUDE_3_7_SONNET_2025_02_19
else:
    claude_model = Llm.CLAUDE_4_5_SONNET_2025_09_29
```

### 5.5 Variant Model Cycling

**Default Pattern (3 variants):**
1. Variant 0: Claude (primary)
2. Variant 1: GPT-4o
3. Variant 2: Gemini

**Fallback:** If only one provider available, all variants use that provider.

---

## 6. Variant System

### 6.1 Configuration

**File:** `backend/config.py`

```python
NUM_VARIANTS = 4  # Default variant count
```

### 6.2 Variant Data Structure

**File:** `frontend/src/components/commits/types.ts`

```typescript
interface Variant {
  code: string;
  status: "generating" | "complete" | "error" | "cancelled";
  error?: string;
}

interface Commit {
  hash: CommitHash;
  type: "ai_create" | "ai_edit";
  parentHash: CommitHash | null;
  variants: Variant[];
  selectedVariantIndex: number;
  isCommitted: boolean;
  inputs: PromptContent;
}
```

### 6.3 Variant Grid UI

**File:** `frontend/src/components/variants/Variants.tsx`

**Layout:** 2x2 grid (responsive)

**Visual States:**
- Generating: Spinner animation
- Complete: Green checkmark
- Error: Red badge with message
- Selected: Blue border highlight

### 6.4 Keyboard Navigation

```typescript
useEffect(() => {
  const handleKeyDown = (e: KeyboardEvent) => {
    if (e.altKey && e.key >= '1' && e.key <= '9') {
      const index = parseInt(e.key) - 1;
      if (index < variants.length) {
        setSelectedVariantIndex(head, index);
      }
    }
  };
  window.addEventListener('keydown', handleKeyDown);
  // ...
}, [variants.length, head]);
```

### 6.5 Non-Blocking Generation

Key behavior: Users can interact with completed variants while others are still generating.

**Implementation:**
- Each variant tracked independently in state
- Status updates per-variant via WebSocket
- Selection change doesn't interrupt generation
- Preview updates to selected variant's code

---

## 7. Preview System

### 7.1 Preview Modes

| Mode | Description | Component |
|------|-------------|-----------|
| Preview | Live HTML rendering | PreviewComponent.tsx |
| Code | Syntax-highlighted editor | CodeMirror.tsx |

### 7.2 Device Presets

**File:** `frontend/src/components/preview/PreviewPane.tsx`

| Device | Width | Description |
|--------|-------|-------------|
| Desktop | 1440px | Full width |
| Mobile | 375px | iPhone viewport |

### 7.3 Scaling System

**File:** `frontend/src/components/preview/PreviewComponent.tsx:24-47`

```typescript
const viewportWidth = wrapper.clientWidth;
const baseWidth = device === "desktop" ? 1440 : 375;
const scaleValue = Math.min(1, viewportWidth / baseWidth);

iframe.style.transform = `scale(${scaleValue})`;
iframe.style.transformOrigin = "top left";
wrapper.style.height = `${iframe.offsetHeight * scaleValue}px`;
```

### 7.4 Iframe Rendering

**Security:** `sandbox` attribute not used (allows scripts, forms)

**Content Injection:**
```typescript
useEffect(() => {
  if (iframeRef.current) {
    const doc = iframeRef.current.contentDocument;
    if (doc) {
      doc.open();
      doc.write(code);
      doc.close();
    }
  }
}, [code]);
```

### 7.5 Code Editor

**File:** `frontend/src/components/preview/CodeMirror.tsx`

**Features:**
- Syntax highlighting (HTML/JavaScript)
- Theme selection (Cobalt/Espresso)
- Read-only display
- Copy button

---

## 8. Select & Edit Mode

### 8.1 Overview

Click-to-edit feature allowing users to select specific elements in the preview for targeted modifications.

### 8.2 Toggle Button

**File:** `frontend/src/components/select-and-edit/SelectAndEditModeToggleButton.tsx`

**Visibility:** Only shown for HTML_TAILWIND or HTML_CSS stacks

**States:**
- Default: "Select and update" (neutral color)
- Active: "Exit selection mode" (destructive/red)

### 8.3 Element Selection

**File:** `frontend/src/components/select-and-edit/utils.ts`

```typescript
export function addHighlight(element: HTMLElement) {
  element.style.outline = "2px dashed #1846db";  // Blue dashed outline
  element.style.backgroundColor = "#bfcbf5";      // Light blue background
  return element;
}

export function removeHighlight(element: HTMLElement) {
  element.style.outline = "";
  element.style.backgroundColor = "";
  return element;
}
```

### 8.4 Edit Popup

**File:** `frontend/src/components/select-and-edit/EditPopup.tsx`

**Features:**
- Positioned at click coordinates (scale-adjusted)
- Textarea for update instructions
- Enter key submits
- Auto-focuses on appearance

**Coordinate Adjustment:**
```typescript
const adjustedCoordinates = getAdjustedCoordinates(
  event.clientX,
  event.clientY,
  iframeRef.current?.getBoundingClientRect(),
  scale
);
```

### 8.5 Element HTML Injection

**File:** `frontend/src/App.tsx:302-306`

```typescript
if (selectedElement) {
  modifiedUpdateInstruction =
    updateInstruction +
    " referring to this element specifically: " +
    selectedElement.outerHTML;
}
```

**Example:** User types "Make larger", selected element is `<button>Click</button>`:
```
Make larger referring to this element specifically: <button>Click</button>
```

---

## 9. Update Mechanism

### 9.1 Update Flow

```
1. User types update instruction in sidebar/popup
2. doUpdate() called with instruction + optional element
3. Extract history via extractHistory()
4. Append element HTML to instruction (if selected)
5. Build updatedHistory array
6. Call doGenerateCode() with generationType: "update"
7. Backend uses Claude 4.5 Sonnet for updates
8. Streaming response updates variant code
```

### 9.2 History Extraction

**File:** `frontend/src/components/history/utils.ts`

```typescript
export function extractHistory(
  hash: CommitHash,
  commits: Record<CommitHash, Commit>
): PromptContent[] {
  const flatHistory: PromptContent[] = [];
  let currentCommitHash: CommitHash | null = hash;

  while (currentCommitHash !== null) {
    const commit = commits[currentCommitHash];
    if (commit) {
      // Add code as assistant message
      flatHistory.unshift({
        text: commit.variants[commit.selectedVariantIndex].code,
        images: [],
      });
      // For edits, add prompt as user message
      if (commit.type === "ai_edit") {
        flatHistory.unshift(commit.inputs);
      }
      currentCommitHash = commit.parentHash;
    }
  }
  return flatHistory;
}
```

### 9.3 Create vs Update Differences

| Aspect | Create | Update |
|--------|--------|--------|
| Generation Type | "create" | "update" |
| Model | Claude 3.7 Sonnet | Claude 4.5 Sonnet |
| History | None | Previous code + prompts |
| Commit Type | ai_create | ai_edit |
| Parent Hash | null | Previous commit hash |

### 9.4 Multi-Image Updates

**File:** `frontend/src/store/app-store.ts`

```typescript
updateImages: string[];
setUpdateImages: (images: string[]) => void;
```

Users can attach multiple reference images to update requests via drag-drop or file picker.

---

## 10. History & Version Control

### 10.1 Commit System

**Git-like model with parent-child chains**

**File:** `frontend/src/store/project-store.ts`

```typescript
interface ProjectStore {
  commits: Record<CommitHash, Commit>;
  head: CommitHash | null;

  createCommit: (commit: Commit) => void;
  setHead: (hash: CommitHash) => void;
  appendCommitCode: (hash: CommitHash, variantIndex: number, code: string) => void;
  setCommitCode: (hash: CommitHash, variantIndex: number, code: string) => void;
  updateVariantStatus: (hash: CommitHash, variantIndex: number, status: string, error?: string) => void;
  setSelectedVariantIndex: (hash: CommitHash, index: number) => void;
}
```

### 10.2 Commit Types

```typescript
type CommitType = "ai_create" | "ai_edit";

interface Commit {
  hash: CommitHash;           // Unique identifier
  type: CommitType;           // Creation or edit
  parentHash: CommitHash | null; // Previous version
  variants: Variant[];        // Generated outputs
  selectedVariantIndex: number;  // Currently selected
  isCommitted: boolean;       // Finalized flag
  inputs: PromptContent;      // Original prompt
}
```

### 10.3 Hash Generation

```typescript
function generateCommitHash(): CommitHash {
  return crypto.randomUUID();
}
```

### 10.4 History Chain

```
Initial Create (parent: null)
       ↓
   First Edit (parent: initial)
       ↓
  Second Edit (parent: first)
       ↓
     HEAD
```

### 10.5 History Navigation

**File:** `frontend/src/components/history/HistoryPanel.tsx`

- Sidebar panel showing commit chain
- Click to navigate to previous versions
- Shows commit type icons (create/edit)
- Highlights current HEAD

---

## 11. Settings & Configuration

### 11.1 Settings Interface

**File:** `frontend/src/types.ts`

```typescript
export interface Settings {
  openAiApiKey: string | null;
  openAiBaseURL: string | null;
  anthropicApiKey: string | null;
  screenshotOneApiKey: string | null;
  isImageGenerationEnabled: boolean;
  editorTheme: EditorTheme;
  generatedCodeConfig: Stack;
  codeGenerationModel: CodeGenerationModel;
  isTermOfServiceAccepted: boolean;
}

export enum EditorTheme {
  ESPRESSO = "espresso",
  COBALT = "cobalt",
}
```

### 11.2 Settings Persistence

**File:** `frontend/src/hooks/usePersistedState.ts`

```typescript
function usePersistedState<T>(defaultValue: T, key: string): PersistedState<T> {
  const [value, setValue] = useState<T>(() => {
    const value = window.localStorage.getItem(key);
    return value ? (JSON.parse(value) as T) : defaultValue;
  });

  useEffect(() => {
    window.localStorage.setItem(key, JSON.stringify(value));
  }, [key, value]);

  return [value, setValue];
}
```

**Storage Key:** `"setting"`

### 11.3 Framework Selection

**File:** `frontend/src/lib/stacks.ts`

| Stack | Components | Beta |
|-------|------------|------|
| html_tailwind | HTML, Tailwind | No |
| html_css | HTML, CSS | No |
| react_tailwind | React, Tailwind | No |
| bootstrap | Bootstrap | No |
| vue_tailwind | Vue, Tailwind | Yes |
| ionic_tailwind | Ionic, Tailwind | Yes |
| svg | SVG | Yes |

### 11.4 Model Selection

**File:** `frontend/src/lib/models.ts`

| Model | Name | Status |
|-------|------|--------|
| claude-sonnet-4-5-20250929 | Claude Sonnet 4.5 | Active |
| gpt-4o-2024-05-13 | GPT-4o | Active |
| gpt-4-turbo-2024-04-09 | GPT-4 Turbo | Deprecated |
| gpt_4_vision | GPT-4 Vision | Deprecated |
| claude_3_sonnet | Claude 3 | Deprecated |

### 11.5 Backend Configuration

**File:** `backend/config.py`

```python
NUM_VARIANTS = 4
OPENAI_API_KEY = os.environ.get("OPENAI_API_KEY", None)
ANTHROPIC_API_KEY = os.environ.get("ANTHROPIC_API_KEY", None)
GEMINI_API_KEY = os.environ.get("GEMINI_API_KEY", None)
OPENAI_BASE_URL = os.environ.get("OPENAI_BASE_URL", None)
SHOULD_MOCK_AI_RESPONSE = bool(os.environ.get("MOCK", False))
IS_DEBUG_ENABLED = bool(os.environ.get("IS_DEBUG_ENABLED", False))
IS_PROD = os.environ.get("IS_PROD", False)
```

### 11.6 Environment Variables

**Frontend (.env.local):**
```
VITE_WS_BACKEND_URL=ws://localhost:7002
VITE_HTTP_BACKEND_URL=http://localhost:7002
VITE_IS_DEPLOYED=false
```

**Backend (.env):**
```
ANTHROPIC_API_KEY=sk-ant-...
OPENAI_API_KEY=sk-...
GEMINI_API_KEY=...
```

---

## 12. WebSocket & Streaming

### 12.1 Connection Setup

**File:** `frontend/src/generateCode.ts`

```typescript
export function generateCode(
  wsRef: React.MutableRefObject<WebSocket | null>,
  params: FullGenerationSettings,
  callbacks: CodeGenerationCallbacks
) {
  const wsUrl = `${WS_BACKEND_URL}/generate-code`;
  const ws = new WebSocket(wsUrl);
  wsRef.current = ws;

  ws.addEventListener("open", () => {
    ws.send(JSON.stringify(params));
  });
  // ...
}
```

### 12.2 Message Protocol

**Message Types:**
```typescript
type WebSocketResponse = {
  type: "chunk" | "status" | "setCode" | "error" |
        "variantComplete" | "variantError" | "variantCount";
  value: string;
  variantIndex: number;
};
```

**Message Flow:**
```
1. variantCount (once) - Number of variants to expect
2. status (per variant) - "Generating code..."
3. chunk (repeated) - Token-by-token streaming
4. setCode (per variant) - Final processed code
5. variantComplete (per variant) - Generation finished
```

### 12.3 Callback System

```typescript
interface CodeGenerationCallbacks {
  onChange: (chunk: string, variantIndex: number) => void;
  onSetCode: (code: string, variantIndex: number) => void;
  onStatusUpdate: (status: string, variantIndex: number) => void;
  onVariantComplete: (variantIndex: number) => void;
  onVariantError: (variantIndex: number, error: string) => void;
  onVariantCount: (count: number) => void;
  onCancel: () => void;
  onComplete: () => void;
}
```

### 12.4 Close Codes

| Code | Meaning | Handling |
|------|---------|----------|
| 1000 | Normal completion | onComplete() |
| 4332 | Application error | onCancel() |
| 4333 | User cancellation | onCancel() + toast |
| Other | Network error | onCancel() + error toast |

### 12.5 LLM Streaming Implementations

**OpenAI:**
```python
async for chunk in stream:
    content = chunk.choices[0].delta.content or ""
    full_response += content
    await callback(content)
```

**Claude:**
```python
async with client.messages.stream(...) as stream:
    async for text in stream.text_stream:
        response += text
        await callback(text)
```

**Gemini:**
```python
async for chunk in await client.aio.models.generate_content_stream(...):
    for part in chunk.candidates[0].content.parts:
        if part.text:
            full_response += part.text
            await callback(part.text)
```

---

## 13. Prompt Engineering

### 13.1 System Prompts Structure

**File:** `backend/prompts/screenshot_system_prompts.py`

**Common Elements (all frameworks):**
1. Expert developer positioning
2. Exactness requirements ("exactly like", "exact text")
3. Full code mandate (no placeholder comments)
4. Element repetition rules
5. Image placeholder handling (placehold.co)
6. Output format specification

### 13.2 Framework-Specific CDN Libraries

| Framework | Libraries |
|-----------|-----------|
| HTML/Tailwind | Tailwind CDN, Font Awesome 5.15.3, Google Fonts |
| HTML/CSS | Font Awesome, Google Fonts |
| React | React 18.0.0, ReactDOM, Babel, Tailwind |
| Vue | Vue 3.3.11 (global build), Tailwind |
| Bootstrap | Bootstrap 5.3.2, Font Awesome |
| Ionic | Ionic Core, Tailwind, Ionicons |
| SVG | Google Fonts only |

### 13.3 Prompt Assembly

**File:** `backend/prompts/__init__.py`

```python
async def create_prompt(
    stack: Stack,
    input_mode: InputMode,
    generation_type: str,
    prompt: PromptContent,
    history: list[dict[str, Any]],
    is_imported_from_code: bool,
) -> tuple[list[ChatCompletionMessageParam], dict[str, str]]:
```

**Assembly Logic:**
1. Select system prompt based on stack
2. Build user message with image/text
3. For updates: append history with alternating roles
4. For video: extract frames and build multi-image prompt

### 13.4 User Prompts

```python
USER_PROMPT = "Generate code for a web page that looks exactly like this."
SVG_USER_PROMPT = "Generate code for a SVG that looks exactly like this."
```

### 13.5 Update History Structure

**Role Alternation:**
- Even indices (0, 2, 4...): Assistant (previous code)
- Odd indices (1, 3, 5...): User (edit requests)

```
[System prompt]
[User: original image]
[Assistant: first generated code]    ← history[0]
[User: first update request]         ← history[1]
[Assistant: updated code]            ← history[2]
[User: second update request]        ← history[3]
...
```

### 13.6 Image Detail Level

All images use `"detail": "high"` for maximum vision processing quality.

---

## 14. File Reference Index

### Frontend Core Files

| File | Purpose | Lines |
|------|---------|-------|
| `src/App.tsx` | Main application, state management | 427 |
| `src/generateCode.ts` | WebSocket client | 94 |
| `src/types.ts` | TypeScript definitions | 100 |
| `src/config.ts` | Frontend configuration | 13 |

### Frontend Components

| File | Purpose | Lines |
|------|---------|-------|
| `components/variants/Variants.tsx` | Variant grid display | 146 |
| `components/preview/PreviewComponent.tsx` | Iframe rendering | 94 |
| `components/preview/PreviewPane.tsx` | Preview controls | 91 |
| `components/preview/CodeMirror.tsx` | Code editor | 81 |
| `components/sidebar/Sidebar.tsx` | Action buttons, console | 270 |
| `components/settings/SettingsDialog.tsx` | Settings modal | 231 |
| `components/select-and-edit/EditPopup.tsx` | Click-to-edit popup | 154 |
| `components/select-and-edit/SelectAndEditModeToggleButton.tsx` | Mode toggle | 22 |
| `components/commits/types.ts` | Commit data types | 40 |
| `components/history/utils.ts` | History extraction | 96 |

### Frontend State

| File | Purpose | Lines |
|------|---------|-------|
| `store/app-store.ts` | UI state (Zustand) | 39 |
| `store/project-store.ts` | Commits, variants (Zustand) | 218 |
| `hooks/usePersistedState.ts` | localStorage persistence | 19 |

### Backend Core

| File | Purpose | Lines |
|------|---------|-------|
| `routes/generate_code.py` | WebSocket endpoint, pipeline | 959 |
| `main.py` | FastAPI application | 50 |
| `config.py` | Configuration | 26 |
| `llm.py` | Model definitions | 71 |

### Backend Prompts

| File | Purpose | Lines |
|------|---------|-------|
| `prompts/__init__.py` | Prompt assembly | 181 |
| `prompts/screenshot_system_prompts.py` | Main prompts | 198 |
| `prompts/imported_code_prompts.py` | Import prompts | 153 |
| `prompts/text_prompts.py` | Text mode prompts | 126 |
| `prompts/claude_prompts.py` | Claude-specific (future) | 114 |

### Backend Models

| File | Purpose | Lines |
|------|---------|-------|
| `models/openai_client.py` | OpenAI streaming | 76 |
| `models/claude.py` | Anthropic streaming | 217 |
| `models/gemini.py` | Google AI streaming | 94 |

### Backend Utilities

| File | Purpose | Lines |
|------|---------|-------|
| `video/utils.py` | Video frame extraction | 135 |
| `utils.py` | Prompt summary utilities | 98 |
| `ws/constants.py` | WebSocket close codes | 10 |

---

## Appendix: Running the Original Application

### Prerequisites

- Node.js 18+
- Python 3.11+
- API keys for at least one provider (Anthropic/OpenAI/Gemini)

### Backend Setup

```bash
cd screenshot-to-code/backend

# Create virtual environment
python -m venv .venv
source .venv/bin/activate

# Install dependencies
uv pip install -r requirements.txt

# Configure API keys
export ANTHROPIC_API_KEY="your-key"
export OPENAI_API_KEY="your-key"  # Optional
export GEMINI_API_KEY="your-key"  # Optional

# Start server (port 7001 or 7002 if 7001 in use)
python main.py
```

### Frontend Setup

```bash
cd screenshot-to-code/frontend

# Install dependencies
npm install

# Configure backend URL (if not default)
echo "VITE_WS_BACKEND_URL=ws://localhost:7002" > .env.local
echo "VITE_HTTP_BACKEND_URL=http://localhost:7002" >> .env.local

# Start development server
npm run dev
```

### Access

Open http://localhost:5173 in browser.

---

**Audit Complete: 2025-12-12**
