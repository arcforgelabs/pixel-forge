# Visual-to-Code Tools Research Report
**Date**: 2025-12-11
**Purpose**: Evaluate tools for converting visual designs (screenshots, mockups, UI images) into structured data specifications for code generation

---

## Executive Summary

This research identifies 15+ tools across 4 categories for visual-to-code conversion:

1. **AI-Native Screenshot-to-Code** (immediate code generation)
2. **Design Tool Extractors** (Figma/Penpot plugins for design tokens/specs)
3. **Visual Builders** (hybrid design + code generation platforms)
4. **Design Token Transformers** (specification-to-code pipelines)

**Top Recommendations**:
- **Best for immediate prototyping**: `screenshot-to-code` (OSS, free, Claude Sonnet 3.7)
- **Best for production workflows**: Figma + Style Dictionary + `sd-transforms`
- **Best all-in-one platform**: Plasmic (headless API, design tokens, free tier)
- **Best emerging option**: Claude Sonnet 4.5 + Structured Outputs (custom pipeline)

---

## 1. AI-Native Screenshot-to-Code Tools

### 1.1 screenshot-to-code (abi/screenshot-to-code)

**Category**: Open-source AI screenshot converter
**License**: MIT (Open Source)
**GitHub**: https://github.com/abi/screenshot-to-code

**Capabilities**:
- Upload screenshot/mockup → generate HTML/Tailwind/React/Vue code
- Supports Claude Sonnet 3.7 (recommended), GPT-4o, GPT-4 Vision
- URL cloning (automatically screenshot + clone websites)
- Live preview with code editor
- Screen recording to code conversion

**Structured Output**:
- Format: Clean HTML/React/Vue source code
- No intermediate JSON spec layer
- Direct code generation

**API Access**:
- Self-hosted: Full control, use your own API keys (OpenAI/Anthropic)
- Hosted version: Paid service available at screenshottocode.com

**Pricing**:
- Free (self-hosted with your API keys)
- Hosted: Pricing not publicly disclosed

**Integration Workflow**:
```
Screenshot → screenshot-to-code → HTML/React/Vue Code
```

**Pros**:
- Fully open-source
- Best-in-class models (Claude Sonnet 3.7)
- Active maintenance (GitHub stars: 64k+)
- Self-hostable

**Cons**:
- No intermediate structured spec layer
- Requires API keys for AI models
- Limited customization of output structure

**Recommendation**: **Top choice for rapid prototyping and MVP development**

---

### 1.2 v0 by Vercel

**Category**: Hosted AI UI generator
**License**: Proprietary (closed source)
**URL**: https://v0.app

**Capabilities**:
- Text-to-UI and image-to-UI (screenshot upload)
- Generates React + Tailwind/shadcn components
- Iterative chat-based refinement
- Figma import (Premium+)
- Multi-screen flows with navigation
- Web search, file reading, site inspection

**Structured Output**:
- Format: React/TypeScript + Tailwind CSS
- Component-based architecture
- No intermediate JSON spec

**API Access**:
- Available on Premium ($20/mo) and Team ($30/user/mo) plans
- Credit-based usage (input/output tokens)

**Pricing** (2025):
- Free: $5/month credits
- Premium: $20/month ($20 credits + Figma import + API access)
- Team: $30/user/month (shared credits + collaboration)
- Enterprise: Custom

**Integration Workflow**:
```
Screenshot/Figma → v0 → React Components → Export to codebase
```

**Pros**:
- Best UX for iterative design
- High-quality React output
- Figma integration
- API access for automation

**Cons**:
- Credit-based pricing (unpredictable costs)
- Proprietary/closed source
- No structured spec extraction
- Requires constant credits

**Recommendation**: **Best for teams already on Vercel/Next.js with design iteration needs**

---

### 1.3 Lovable AI

**Category**: AI web app builder (screenshot-to-code)
**License**: Proprietary
**URL**: https://lovable.dev

**Capabilities**:
- Screenshot upload → working app
- Website cloning from screenshots
- Figma/Excalidraw sketch conversion
- Visual prompting (draw on screenshots)
- Full-stack app generation

**Structured Output**:
- Format: Full-stack application code
- No intermediate spec layer

**API Access**:
- Not publicly documented

**Pricing**:
- Free tier available
- Paid plans: Not publicly disclosed
- Early metrics: £13.50M ARR (3 months post-launch)

**Integration Workflow**:
```
Screenshot/Figma → Lovable → Full-stack app code
```

**Pros**:
- High quality output (4.7-star rating)
- Faster than traditional coding (20x claimed)
- Full-stack generation

**Cons**:
- Proprietary
- Limited API/automation info
- No structured spec extraction

**Recommendation**: **Best for rapid full-stack prototyping by non-developers**

---

### 1.4 GitHub Copilot Vision

**Category**: IDE-integrated screenshot-to-code
**License**: Proprietary
**Platform**: VS Code, Visual Studio

**Capabilities**:
- Upload screenshot/diagram → generate code + alt text
- Context-aware generation (integrates with codebase)
- Multi-language support
- Hand-drawn diagram support

**Structured Output**:
- Format: Code in any language (contextual)
- No intermediate spec

**API Access**:
- Not available (IDE-only)

**Pricing**:
- Included with GitHub Copilot subscription ($10/month as of June 2025)

**Integration Workflow**:
```
Screenshot → Copilot Chat → Code in editor
```

**Pros**:
- Deep IDE integration
- Codebase awareness
- Affordable ($10/mo)

**Cons**:
- No API access
- No standalone usage
- No structured spec extraction

**Recommendation**: **Best for developers already using Copilot, not for automation pipelines**

---

## 2. Design Tool Extractors (Figma/Penpot)

### 2.1 Figma Dev Mode + Plugins

**Category**: Design tool with developer handoff
**License**: Proprietary
**URL**: https://www.figma.com

**Design Token Extraction**:

#### 2.1.1 Figma REST API (Variables)
- **Requirement**: ENTERPRISE plan only (expensive)
- **Access**: Personal Access Token
- **Format**: JSON via REST API
- **Limitation**: Token extraction requires top-tier subscription

#### 2.1.2 Figma MCP Server
- **Type**: Model Context Protocol server
- **Access**: Local HTTP server at http://127.0.0.1:3845/mcp
- **Performance**: 20-100ms for design token extraction
- **Benefit**: Real-time access without API delays
- **Limitation**: Requires Figma desktop app

#### 2.1.3 Figma Plugins (Community)

**Design-to-JSON Plugin**:
- Exports layer hierarchy to JSON
- Developer-friendly structure
- Free

**Figma to JSON Exporter**:
- Comprehensive design data extraction
- Analysis and documentation support
- Free

**Design Tokens Manager**:
- Exports variables to W3C DTCG format JSON
- Mode-based exports (separate JSON per mode)
- Free

**Figma Token Exporter**:
- Exports to CSS, SASS, JSON
- Design token focused
- Free

**Tokens Studio Plugin**:
- Integrates with Dev Mode
- Advanced token management
- Syncs with repositories
- Free + Pro tiers

**Structured Output**:
- Format: JSON (plugin-dependent)
- W3C DTCG format support (Design Tokens Manager)
- CSS/SASS/JSON options

**API Access**:
- REST API: ENTERPRISE only
- MCP Server: Local desktop only
- Plugins: Manual export workflow

**Pricing**:
- Figma Free: $0 (basic features)
- Figma Professional: $12/editor/month
- Figma Organization: $45/editor/month
- Figma Enterprise: $75/editor/month (API access)

**Integration Workflow**:
```
Figma Design → Plugin → JSON/CSS → Style Dictionary → Platform Code
```

**Pros**:
- Industry standard tool
- Rich plugin ecosystem
- W3C DTCG format support
- MCP server for real-time access

**Cons**:
- API requires ENTERPRISE plan ($75/editor/mo)
- Plugins require manual export
- Not fully automated

**Recommendation**: **Best for teams already using Figma with design system workflows**

---

### 2.2 Penpot (Open Source)

**Category**: Open-source design tool (Figma alternative)
**License**: MPL 2.0 (Open Source)
**URL**: https://penpot.app

**Design Token Extraction**:

#### 2.2.1 penpot-export CLI
- Exports page components as CSS/SCSS
- Exports typography and colors as CSS/SCSS/JSON
- W3C DTCG format support
- Uses Penpot public API

#### 2.2.2 Penpot MCP Server
- Model Context Protocol integration
- Design token extraction
- DTCG format output

#### 2.2.3 REST API (Coming)
- Full REST API planned for future releases
- Will enable programmatic token creation/modification
- Cross-service syncing

**Structured Output**:
- Format: JSON (W3C DTCG), CSS, SCSS
- Component exports
- Token-focused architecture

**API Access**:
- Current: Public API (read-only, limited)
- CLI: penpot-export (available now)
- Future: Comprehensive REST API

**Pricing**:
- Free (open source, self-hosted)
- Penpot Cloud: Free tier + paid plans

**Integration Workflow**:
```
Penpot Design → penpot-export CLI → JSON/CSS/SCSS → Style Dictionary → Platform Code
```

**Pros**:
- Fully open source
- No vendor lock-in
- W3C DTCG support
- CLI automation available now
- MCP server integration

**Cons**:
- Full REST API still in development
- Smaller plugin ecosystem than Figma
- Less mature than Figma

**Recommendation**: **Best open-source alternative to Figma for design token workflows**

---

### 2.3 Anima

**Category**: Figma plugin (design-to-code)
**License**: Proprietary
**URL**: https://www.animaapp.com

**Capabilities**:
- Figma → React/HTML/Vue/Tailwind code
- Dev Mode integration
- Email HTML generation
- Multi-screen flow support
- UI library support (Material UI, Ant Design)

**Structured Output**:
- Format: React/Vue/HTML + CSS/Tailwind
- TypeScript/JavaScript options
- Next.js support
- No intermediate JSON spec

**API Access**:
- Not documented publicly

**Pricing**:
- Free tier available
- Paid plans: Not publicly disclosed

**Integration Workflow**:
```
Figma Design → Anima Plugin → React/Vue/HTML Code
```

**Pros**:
- Direct Figma integration
- Multiple framework support
- Dev Mode integration
- Email-compatible HTML

**Cons**:
- Proprietary
- No API documentation
- No structured spec extraction
- Pricing not transparent

**Recommendation**: **Best for Figma users needing quick code export without design token focus**

---

## 3. Visual Builders (Hybrid Platforms)

### 3.1 Plasmic

**Category**: Visual builder + headless API
**License**: Proprietary (with open-source SDK)
**URL**: https://www.plasmic.app

**Capabilities**:
- Visual page builder for React
- Headless API (fetch designs as data)
- Codegen option (export to git)
- Design token integration
- Custom component integration

**Design Token Extraction**:
- Tokens exported as CSS custom properties
- Format: `--plasmic-token-${tokenName}`
- Available in both Headless API and Codegen modes
- Sync via `plasmic sync` command
- Register existing token systems

**Structured Output**:
- Format: React components (codegen) or JSON data (headless)
- CSS tokens file
- Design system components

**API Access**:
- Headless API: Full access
- Real-time publishing (no git commits)
- Fetch and render designs programmatically

**Pricing**:
- Free: Unlimited projects, 1 editor
- Growth: $49/month (5 editors)
- Enterprise: Custom

**Integration Workflow**:
```
Visual Builder → Plasmic Headless API → React App (runtime fetch)
OR
Visual Builder → Plasmic Codegen → Git Repo (code export)
```

**Pros**:
- True headless API
- Design tokens as CSS variables
- Free tier very generous
- Custom component integration
- Both runtime and codegen options

**Cons**:
- Requires React
- Learning curve for headless setup
- Not screenshot-based (manual design)

**Recommendation**: **Best visual builder with API access and design token support**

---

### 3.2 Builder.io

**Category**: Visual CMS + builder
**License**: Proprietary
**URL**: https://www.builder.io

**Capabilities**:
- Visual editor with AI generation (Visual Editor 3.0)
- AI generates designs from brand guidelines
- Custom component integration
- Multi-framework support (React, Vue, Svelte, Qwik)
- CLI for component mapping

**Structured Output**:
- Format: JSON (visual data) + platform-specific code
- Component API reference
- Plugin architecture

**API Access**:
- Full API available
- CMS-style content APIs
- Real-time publishing

**Pricing**:
- Free: Community plan
- Growth: $49/month
- Enterprise: Custom

**Integration Workflow**:
```
Visual Editor → Builder API → Platform Code (React/Vue/etc)
```

**Pros**:
- AI-powered design generation
- Strong CMS features
- Multi-framework support
- Component integration

**Cons**:
- No explicit screenshot-to-code feature
- Focused on visual editing, not screenshot conversion
- Pricing unclear for AI features

**Recommendation**: **Best for content-heavy sites with visual editing needs**

---

### 3.3 Framer

**Category**: Design tool + website builder
**License**: Proprietary
**URL**: https://www.framer.com

**Capabilities**:
- AI-powered design generation
- Custom React components
- API integration (Fetch feature)
- Code component support
- Third-party integrations

**Structured Output**:
- Format: React components
- Exportable code snippets
- AI-generated code (review required)

**API Access**:
- Framer API for custom endpoints
- Fetch API for data retrieval
- Integration APIs (Google Analytics, payment gateways)

**Pricing**:
- Free: Personal sites
- Mini: $5/month
- Basic: $15/month
- Pro: $25/month

**Integration Workflow**:
```
Framer Design → AI Generation → React Components → Export
```

**Pros**:
- Designer-friendly
- AI code generation
- Custom API support
- Affordable pricing

**Cons**:
- Not focused on screenshot conversion
- Code export limited
- Requires manual design

**Recommendation**: **Best for designers building marketing sites**

---

### 3.4 Supernova

**Category**: Design system platform
**License**: Proprietary
**URL**: https://www.supernova.io

**Capabilities**:
- Design system documentation
- Token export (JSON, SCSS, XML, iOS)
- Git integration (auto-deployment)
- Figma/Storybook sync
- SDK for custom tooling

**Structured Output**:
- Format: JSON, SCSS, XML, platform-specific
- W3C DTCG support
- Export pipelines
- Markdown documentation

**API Access**:
- TypeScript SDK: `@supernovaio/sdk`
- Full platform API
- Git repo integration

**Pricing**:
- Starter: Free
- Team: Custom
- Enterprise: Custom

**Integration Workflow**:
```
Figma/Storybook → Supernova → JSON/SCSS/XML → Git Repo → Platform Code
```

**Pros**:
- Comprehensive design system platform
- SDK and API access
- Automated token delivery
- Multi-platform export

**Cons**:
- Not screenshot-based
- Requires design tool integration
- Pricing not transparent

**Recommendation**: **Best for enterprise design system management**

---

### 3.5 Uizard

**Category**: AI design tool + screenshot converter
**License**: Proprietary
**URL**: https://uizard.io

**Capabilities**:
- Screenshot Scanner (screenshot → mockup)
- AI-powered mockup generation
- Editable UI components
- Collaboration features
- Handoff Mode (design assets + code)

**Structured Output**:
- Format: Editable mockup (not direct code)
- Code export via Handoff Mode
- Supported formats: JPG, PNG, HEIC

**API Access**:
- Not documented publicly

**Pricing**:
- Free tier available
- Pro: From $12/month
- Business: From $39/month

**Integration Workflow**:
```
Screenshot → Uizard Scanner → Editable Mockup → Handoff Mode → Code/Assets
```

**Pros**:
- Screenshot to mockup focus
- Editable output
- Team collaboration
- Real-time editing

**Cons**:
- Not direct screenshot-to-code
- Requires mockup editing step
- Limited automation

**Recommendation**: **Best for design exploration and team collaboration from screenshots**

---

### 3.6 Galileo AI

**Category**: AI-powered UI design tool
**License**: Proprietary
**URL**: https://galileoai.com

**Capabilities**:
- Text-to-UI generation
- Image-to-UI (wireframes/screenshots)
- Figma export (one-click)
- Component hierarchy preservation

**Structured Output**:
- Format: Figma design (not code)
- Component hierarchy
- No direct code export

**API Access**:
- Not available

**Pricing** (2025):
- Standard: $19/month (1200 credits)
- Pro: $39/month (3000 credits)
- Each image generation: 10 credits

**Integration Workflow**:
```
Screenshot → Galileo AI → Figma Design → (Figma plugins for code)
```

**Pros**:
- Strong image-to-UI conversion
- Figma integration
- Component hierarchy

**Cons**:
- No direct code export (requested feature)
- No API access
- Requires Figma for code generation

**Recommendation**: **Best for designers needing screenshot-to-Figma conversion**

---

## 4. Design Token Transformers

### 4.1 Style Dictionary

**Category**: Design token transformer
**License**: Apache 2.0 (Open Source)
**GitHub**: https://github.com/amzn/style-dictionary

**Capabilities**:
- Transform design tokens to platform-specific code
- Multi-platform support (iOS, Android, web, etc.)
- JSON/JavaScript token input
- W3C DTCG forward-compatible
- Custom transforms and formats

**Structured Output**:
- Format: CSS, SCSS, JSON, iOS, Android, etc.
- Platform-specific variables
- Documentation generation

**API Access**:
- Node.js library
- CLI tool
- Full programmatic access

**Pricing**:
- Free (open source)

**Integration Workflow**:
```
Design Tokens (JSON) → Style Dictionary → Platform Code (CSS/iOS/Android/etc)
```

**Pros**:
- Industry standard
- Multi-platform support
- Highly customizable
- Active maintenance
- Free and open source

**Cons**:
- Requires token input (not screenshot-based)
- Configuration learning curve

**Recommendation**: **Essential tool for any design token pipeline**

---

### 4.2 sd-transforms (Tokens Studio)

**Category**: Style Dictionary transforms
**License**: MIT (Open Source)
**GitHub**: https://github.com/tokens-studio/sd-transforms

**Capabilities**:
- Prepares Tokens Studio tokens for Style Dictionary
- W3C DTCG support
- Additional transforms for design tokens
- Figma plugin integration

**Structured Output**:
- Format: Compatible with Style Dictionary
- W3C DTCG format

**API Access**:
- npm package: `@tokens-studio/sd-transforms`
- Programmatic usage

**Pricing**:
- Free (open source)

**Integration Workflow**:
```
Tokens Studio (Figma) → sd-transforms → Style Dictionary → Platform Code
```

**Pros**:
- Bridges Tokens Studio and Style Dictionary
- W3C DTCG support
- Free and open source

**Cons**:
- Specific to Tokens Studio workflow
- Requires token input

**Recommendation**: **Essential for Tokens Studio + Style Dictionary pipelines**

---

## 5. Vision AI Models (Custom Pipelines)

### 5.1 Claude Sonnet 4.5 (Anthropic)

**Category**: Vision + structured outputs LLM
**License**: Proprietary (API access)
**URL**: https://www.anthropic.com

**Capabilities**:
- Vision API (analyze screenshots)
- Structured Outputs (JSON schema enforcement)
- Beta feature: `structured-outputs-2025-11-13`
- Fine-tuning support for domain-specific tasks

**Structured Output**:
- Format: JSON (schema-enforced)
- Custom schemas
- Reliable, parseable output

**API Access**:
- Full API access
- Beta header required for structured outputs

**Pricing**:
- Claude Sonnet 4.5: Input $3/MTok, Output $15/MTok
- Claude Sonnet 3.7: Input $3/MTok, Output $15/MTok

**Integration Workflow**:
```
Screenshot → Claude API (vision) → Structured JSON Spec → Code Generation
```

**Pros**:
- Best-in-class vision understanding
- Structured output enforcement
- Customizable schemas
- Fine-tuning available

**Cons**:
- Requires custom pipeline development
- API costs
- Beta feature (structured outputs)

**Recommendation**: **Best for custom pipelines requiring structured spec extraction**

---

### 5.2 GPT-4 Vision (OpenAI)

**Category**: Vision + code generation LLM
**License**: Proprietary (API access)
**URL**: https://openai.com

**Capabilities**:
- Vision API (analyze screenshots)
- Code generation from visual input
- OCR and text extraction
- Layout and component analysis
- Object detection

**Structured Output**:
- Format: Text, code, or JSON (prompt-dependent)
- No native schema enforcement
- Requires prompt engineering

**API Access**:
- Full API access

**Pricing**:
- GPT-4 Vision: Input $10/MTok, Output $30/MTok
- GPT-4o: Input $2.50/MTok, Output $10/MTok

**Integration Workflow**:
```
Screenshot → GPT-4 Vision API → Code/JSON → Processing
```

**Pros**:
- Strong vision capabilities
- Direct code generation
- OCR and layout analysis

**Cons**:
- More expensive than Claude
- No native structured outputs
- Prompt engineering required

**Recommendation**: **Alternative to Claude for vision-to-code pipelines**

---

## 6. W3C DTCG Standard (Design Tokens)

**Category**: Design token specification
**License**: W3C Community Group
**URL**: https://www.designtokens.org

**Specification**: Design Tokens Format Module 2025.10 (First Stable Version)

**Key Features**:
- JSON interchange format
- Media type: `application/design-tokens+json`
- File extensions: `.tokens` or `.tokens.json`
- Properties prefixed with `$` ($value, $type, $description, $extensions, $deprecated)
- Support for theming, modern color spaces (Display P3, Oklch, CSS Color Module 4)
- Composite types (shadows, gradients, borders, typography)

**Industry Adoption**:
- 10+ tools supporting the standard
- Penpot, Figma, Sketch, Framer, Knapsack, Supernova, zeroheight
- Style Dictionary, Tokens Studio, Terrazzo

**Recommendation**: **Use W3C DTCG format for all design token workflows**

---

## Comparison Table

| Tool | Category | License | Screenshot Input | Structured Spec | API Access | Pricing | Best For |
|------|----------|---------|------------------|----------------|------------|---------|----------|
| **screenshot-to-code** | AI Converter | MIT (OSS) | ✅ Yes | ❌ No | ✅ Self-host | Free | Rapid prototyping |
| **v0 (Vercel)** | AI UI Gen | Proprietary | ✅ Yes | ❌ No | ✅ Premium+ | $20/mo+ | Next.js teams |
| **Lovable AI** | AI Builder | Proprietary | ✅ Yes | ❌ No | ❓ Unknown | Unknown | Full-stack apps |
| **GitHub Copilot Vision** | IDE Tool | Proprietary | ✅ Yes | ❌ No | ❌ No | $10/mo | Copilot users |
| **Figma + Plugins** | Design Tool | Proprietary | ❌ No | ✅ Yes (JSON) | ⚠️ Enterprise | $0-75/mo | Design systems |
| **Penpot** | Design Tool | MPL 2.0 (OSS) | ❌ No | ✅ Yes (JSON) | ⚠️ Limited | Free | OSS alternative |
| **Anima** | Figma Plugin | Proprietary | ❌ No | ❌ No | ❓ Unknown | Unknown | Quick code export |
| **Plasmic** | Visual Builder | Proprietary | ❌ No | ✅ Yes (tokens) | ✅ Yes | Free-$49/mo | Headless CMS |
| **Builder.io** | Visual CMS | Proprietary | ❌ No | ✅ Yes (JSON) | ✅ Yes | Free-$49/mo | Content sites |
| **Framer** | Design Tool | Proprietary | ❌ No | ⚠️ Partial | ✅ Yes | $0-25/mo | Marketing sites |
| **Supernova** | Design System | Proprietary | ❌ No | ✅ Yes (JSON) | ✅ SDK | Free-Custom | Enterprise |
| **Uizard** | Design Tool | Proprietary | ✅ Yes | ❌ No | ❓ Unknown | $0-39/mo | Mockup editing |
| **Galileo AI** | AI Designer | Proprietary | ✅ Yes | ❌ No | ❌ No | $19-39/mo | Figma designs |
| **Style Dictionary** | Transformer | Apache 2.0 (OSS) | ❌ No | ✅ Input req. | ✅ CLI/API | Free | Token pipelines |
| **Claude Sonnet 4.5** | Vision LLM | API (Proprietary) | ✅ Yes | ✅ Yes (JSON) | ✅ Full API | $3-15/MTok | Custom pipelines |
| **GPT-4 Vision** | Vision LLM | API (Proprietary) | ✅ Yes | ⚠️ Partial | ✅ Full API | $2.50-30/MTok | Alternative AI |

---

## Recommended Workflows

### Workflow 1: Rapid Prototyping (Free/Low-Cost)
**Target**: MVPs, personal projects, quick mockups

```
Screenshot → screenshot-to-code (OSS) → HTML/React/Vue Code
```

**Tools**:
- screenshot-to-code (self-hosted)
- Claude Sonnet 3.7 API key (or GPT-4o)

**Cost**: ~$0-10/month (API usage only)

**Pros**: Free, fast, full control
**Cons**: No structured spec layer

---

### Workflow 2: Production Design Systems
**Target**: Enterprise teams, design systems, scalable architecture

```
Figma Design → Tokens Studio Plugin → JSON (W3C DTCG)
             ↓
       sd-transforms → Style Dictionary → CSS/iOS/Android/etc
```

**Tools**:
- Figma ($12-75/editor/mo)
- Tokens Studio Plugin (free)
- sd-transforms (OSS)
- Style Dictionary (OSS)

**Cost**: $12-75/editor/month + free tooling

**Pros**: Industry standard, scalable, W3C compliant
**Cons**: Requires Figma subscription

---

### Workflow 3: Open-Source Design Systems
**Target**: OSS projects, no vendor lock-in, budget-conscious

```
Penpot Design → penpot-export CLI → JSON (W3C DTCG)
             ↓
       Style Dictionary → CSS/iOS/Android/etc
```

**Tools**:
- Penpot (OSS, free)
- penpot-export CLI (OSS)
- Style Dictionary (OSS)

**Cost**: $0 (fully free)

**Pros**: Zero cost, no vendor lock-in, W3C compliant
**Cons**: Less mature than Figma

---

### Workflow 4: Custom AI Pipeline (Structured Specs)
**Target**: Advanced automation, custom schema requirements, screenshot → spec → code

```
Screenshot → Claude Sonnet 4.5 (vision + structured outputs) → JSON Spec
           ↓
    JSON Schema (layout, components, tokens) → Code Generator → Platform Code
```

**Tools**:
- Claude Sonnet 4.5 API
- Custom JSON schemas
- Custom code generator (template-based)

**Cost**: ~$3-15/MTok (Claude API)

**Pros**: Full control, custom schemas, screenshot-based
**Cons**: Requires pipeline development

**Example JSON Schema**:
```json
{
  "layout": {
    "type": "grid",
    "columns": 3,
    "gap": "24px"
  },
  "components": [
    {
      "type": "Button",
      "variant": "primary",
      "text": "Sign Up",
      "position": {"x": 100, "y": 200}
    }
  ],
  "tokens": {
    "colors": {
      "primary": "#007bff",
      "background": "#ffffff"
    },
    "spacing": {
      "small": "8px",
      "medium": "16px",
      "large": "24px"
    },
    "typography": {
      "heading": {
        "fontFamily": "Inter",
        "fontSize": "24px",
        "fontWeight": "700"
      }
    }
  }
}
```

---

### Workflow 5: Headless Visual Builder
**Target**: Marketing sites, rapid iteration, non-developer editing

```
Visual Design (Plasmic) → Headless API → React App (runtime fetch)
                        ↓
                  Design Tokens (CSS vars) → Codebase
```

**Tools**:
- Plasmic (free-$49/mo)
- React (OSS)

**Cost**: $0-49/month

**Pros**: Non-developer editing, real-time publishing, design tokens
**Cons**: Requires React, not screenshot-based

---

## Final Recommendations

### For `repos/visual-to-code` Project

**Recommended Architecture**: Hybrid approach combining best tools

#### Phase 1: Immediate Prototyping
**Use**: `screenshot-to-code` (OSS)
- Fast setup
- Free (self-hosted)
- Claude Sonnet 3.7 support
- Direct code generation

#### Phase 2: Structured Spec Extraction
**Use**: Claude Sonnet 4.5 + Structured Outputs
- Custom JSON schemas
- Schema-enforced output
- Vision API for screenshot analysis
- Extract layout, components, tokens

**Example Schema**:
```typescript
interface DesignSpec {
  layout: {
    type: "grid" | "flex" | "absolute";
    columns?: number;
    gap?: string;
    direction?: "row" | "column";
  };
  components: Component[];
  tokens: {
    colors: Record<string, string>;
    spacing: Record<string, string>;
    typography: Record<string, TypographySpec>;
  };
}
```

#### Phase 3: Code Generation
**Use**: Template-based generator + Style Dictionary
- JSON spec → template engine → platform code
- W3C DTCG format for tokens
- Style Dictionary for multi-platform support

**Full Pipeline**:
```
Screenshot → Claude Sonnet 4.5 (vision) → JSON Spec (structured outputs)
           ↓
    Validate schema → Extract tokens (W3C DTCG) → Style Dictionary
           ↓
    Code templates → React/Vue/HTML components
```

---

### Tools to Build Around

1. **screenshot-to-code** (immediate MVP)
   - Fork/extend for custom needs
   - Add structured spec extraction layer

2. **Claude Sonnet 4.5 API** (spec extraction)
   - Structured outputs for schema enforcement
   - Vision API for screenshot analysis

3. **Style Dictionary** (token transformation)
   - Multi-platform token support
   - W3C DTCG compatibility

4. **Custom Template Engine** (code generation)
   - Mustache/Handlebars/Nunjucks
   - Platform-specific templates (React/Vue/HTML)

---

## Open Questions / Next Steps

1. **Schema Design**: Define comprehensive JSON schema for design specs
   - Layout primitives (grid/flex/absolute)
   - Component types (button/input/card/etc)
   - Token categories (colors/spacing/typography/shadows/etc)

2. **Template Library**: Build reusable component templates
   - React + Tailwind
   - Vue + Tailwind
   - HTML + CSS
   - React + shadcn/ui

3. **Validation**: Schema validation and error handling
   - JSON Schema validation
   - Design constraint checks
   - Accessibility checks

4. **Testing**: Screenshot → spec → code accuracy
   - Benchmark against popular designs
   - Compare with screenshot-to-code output
   - Measure spec extraction accuracy

5. **Integration**: GitHub Actions / CLI workflow
   - Screenshot input via CLI/API
   - Automated PR generation
   - Design review workflow

---

## Sources

### AI-Native Tools
- [screenshot-to-code GitHub](https://github.com/abi/screenshot-to-code)
- [Screenshot to Code Reviews](https://opentools.ai/tools/screenshot-to-code)
- [Vercel v0.dev Review 2025](https://skywork.ai/blog/vercel-v0-dev-review-2025-ai-ui-react-tailwind/)
- [How to move Your Design from Figma to v0.dev](https://www.pixeldarts.com/post/how-to-move-your-design-from-figma-to-v0-dev)
- [Build your own AI app builder with the v0 Platform API](https://vercel.com/blog/build-your-own-ai-app-builder-with-the-v0-platform-api)
- [Screenshot to Code: Lovable vs v0 vs Bolt](https://research.aimultiple.com/screenshot-to-code/)
- [Lovable AI Review](https://trickle.so/blog/lovable-ai-review)
- [GitHub Copilot brings mockups to life](https://techcrunch.com/2025/02/06/github-copilot-brings-mockups-to-life-by-generating-code-from-images/)
- [Copilot Chat Vision input](https://github.blog/changelog/2025-03-05-copilot-chat-users-can-now-use-the-vision-input-in-vs-code-and-visual-studio-public-preview/)

### Figma Ecosystem
- [Figma Token Exporter](https://www.figma.com/community/plugin/1345069854741911632/figma-token-exporter)
- [Dev Mode in Figma | Tokens Studio](https://docs.tokens.studio/figma/dev-mode)
- [Official Figma Dev Mode MCP Server](https://www.pulsemcp.com/servers/figma-dev-mode)
- [Figma Dev Mode MCP Integration Guide](https://medium.com/@evilgenius/figma-dev-mode-mcp-integration-complete-design-to-code-automation-guide-edf173e203ed)
- [Design-to-JSON Plugin](https://www.figma.com/community/plugin/1514601930647701205/design-to-json)
- [Figma to JSON Exporter Plugin](https://www.figma.com/community/plugin/1510358539626018288/figma-to-json-exporter)
- [Export Figma Variables to JSON](https://thedesignsystem.guide/knowledge-base/export-figma-variables-or-design-tokens-to-json)

### Penpot
- [Design Tokens - Penpot](https://help.penpot.app/user-guide/design-tokens/)
- [penpot-export GitHub](https://github.com/penpot/penpot-export)
- [Penpot MCP Server](https://lobehub.com/mcp/mart1m-penpot-mcp-server)
- [Penpot Integration Guide](https://help.penpot.app/technical-guide/integration/)

### Anima
- [Figma to Code - Anima](https://www.animaapp.com/figma)
- [Anima Plugin](https://www.figma.com/community/plugin/857346721138427857/anima-figma-to-code-react-html-css-tailwind-mui-devmode-inspect-react-html-vue-css)
- [Figma to React instantly](https://dev.to/shreyvijayvargiya/figma-to-react-instantly-introduction-anima-app-1kii)

### Visual Builders
- [Plasmic GitHub](https://github.com/plasmicapp/plasmic)
- [Headless API vs. Codegen | Plasmic](https://docs.plasmic.app/learn/loader-vs-codegen/)
- [Integrating style tokens with code | Plasmic](https://docs.plasmic.app/learn/integrating-tokens/)
- [Builder.io Visual Editor](https://www.builder.io/visual-editor)
- [Builder Visual Editor 3.0 launches](https://alternativeto.net/news/2025/4/builder-io-launches-visual-editor-3-0-to-turn-ui-designs-into-interactive-apps-with-ai/)
- [Framer Developers](https://www.framer.com/developers/)
- [Framer API Integration](https://apix-drive.com/en/blog/other/framer-api-integration)
- [Understanding The Framer API](https://www.numi.tech/post/framer-api)
- [Supernova Documentation](https://www.supernova.io/documentation)
- [Supernova Developer Platform](https://developers.supernova.io/)
- [@supernovaio/sdk](https://www.npmjs.com/package/@supernovaio/sdk)

### Screenshot Converters
- [Uizard Screenshot Scanner](https://uizard.io/screenshot-scanner/)
- [How To Use Screenshot Scanner](https://uizard.io/blog/how-to-use-screenshot-scanner/)
- [Generating Code From A UI Screen Grab](https://uizard.io/blog/pix2code/)
- [Galileo AI Complete Guide](https://uxpilot.ai/galileo-ai)
- [Galileo AI Product Hunt](https://www.producthunt.com/products/galileo-ai?launch=galileo-ai-2)

### Design Tokens & Standards
- [Design Tokens Format Module 2025.10](https://www.designtokens.org/tr/drafts/format/)
- [Design Tokens specification reaches first stable version](https://www.w3.org/community/design-tokens/2025/10/28/design-tokens-specification-reaches-first-stable-version/)
- [Design Tokens Community Group](https://www.designtokens.org/)
- [Style Dictionary](https://styledictionary.com/)
- [sd-transforms GitHub](https://github.com/tokens-studio/sd-transforms)
- [Style Dictionary + SD Transforms](https://docs.tokens.studio/transform-tokens/style-dictionary)

### Vision AI Models
- [Structured outputs on Claude](https://www.claude.com/blog/structured-outputs-on-the-claude-developer-platform)
- [Structured outputs - Claude Docs](https://docs.claude.com/en/docs/build-with-claude/structured-outputs)
- [Fine-Tune Claude 3.7 Sonnet for Vision AI](https://blog.roboflow.com/fine-tune-claude-3-7-sonnet/)
- [Claude Models overview](https://platform.claude.com/docs/en/about-claude/models/overview)
- [GPT-4 Vision Overview](https://www.leewayhertz.com/gpt-4-vision/)
- [GPT-4 Vision Applications](https://www.upcoretech.com/insights/gpt-4-vision-explained-applications-use-cases/)
- [OpenAI Vision API Guide](https://platform.openai.com/docs/guides/vision)

### Pricing & Comparisons
- [Vercel v0 Pricing 2025](https://shipper.now/v0-pricing/)
- [v0 Pricing](https://v0.app/pricing)
- [Screenshot API Comparison 2025](https://dev.to/mukul_sharma/choosing-the-best-screenshot-api-in-2025-a-developers-guide-79)
- [Top AI Coding Tools 2025 Pricing](https://apidog.com/blog/top-ai-coding-tools-2025/)
- [AI Coding Tools Pricing Battle](https://medium.com/@d.jeziorski/the-ai-coding-tools-pricing-battle-who-offers-the-most-in-the-pro-plan-f8a3a6f63182)

---

**End of Report**
