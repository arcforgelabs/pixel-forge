# SPIKE: Prompt Optimization Strategies for Iterative Refinement

**Status**: Research Complete
**Date**: 2025-12-12
**Uncertainty Reduction**: 4/5 → 2/5

---

## Executive Summary

This research investigates prompt optimization strategies for iterative refinement based on evaluation feedback. The goal is to design a feedback loop where eval results (visual similarity, accessibility, performance) inform prompt refinements to improve generated HTML/CSS in subsequent iterations.

### Key Findings

1. **Feedback-Driven Iteration Works**: Research confirms Self-Refine and PromptWizard frameworks converge in 3-5 iterations with proper feedback signals
2. **Visual Similarity Requires Localized Feedback**: Generic "match exactly" prompts are insufficient; specific visual differences must be identified and addressed
3. **Token Budget Critical**: Each iteration adds 50-150 tokens; must use summarization to avoid prompt explosion
4. **Plateau Detection Essential**: Without it, iterations can diverge or stagnate in local optima (GRACE framework addresses this)
5. **Hybrid Convergence Criteria Optimal**: Combine absolute threshold + improvement rate + max iterations

---

## 1. Feedback Signal → Prompt Mapping

### 1.1 Mapping Table

| Eval Signal | Condition | Priority | Prompt Modification | Token Cost |
|-------------|-----------|----------|---------------------|------------|
| **Visual Similarity (Perceptual Hash)** | < 0.70 | HIGH | "The current design differs significantly from the reference. Pay special attention to: {top_3_visual_differences}. Match these elements exactly." | ~80 tokens |
| **Visual Similarity (Pixel Diff)** | < 0.75 | HIGH | "Pixel-level comparison shows {mismatch_percentage}% difference. Focus on exact color matching, spacing, and alignment in: {affected_regions}." | ~60 tokens |
| **Accessibility Score (axe-core)** | < 0.80 | MEDIUM | "Accessibility violations detected ({violation_count}): {top_5_violations}. Ensure WCAG 2.1 AA compliance by addressing these issues." | ~100 tokens |
| **Performance (Bundle Size)** | > 500KB | LOW | "Current bundle size is {size}KB. Optimize by: removing unused CSS, using CDN links, inlining critical CSS only." | ~40 tokens |
| **HTML Validation** | errors > 0 | MEDIUM | "HTML validation errors detected: {error_summary}. Fix these to ensure cross-browser compatibility." | ~50 tokens |
| **Responsive Design** | score < 0.85 | MEDIUM | "Responsive design issues: {breakpoint_failures}. Ensure proper scaling for mobile ({width}px) and tablet ({width}px) viewports." | ~70 tokens |
| **Color Accuracy** | mean_delta > 10 | HIGH | "Color accuracy issues: {color_differences}. Use exact hex values from reference image." | ~45 tokens |

### 1.2 Priority System

**Iteration 1**: Focus on HIGH priority (visual similarity, color accuracy)
**Iteration 2**: Add MEDIUM priority (accessibility, responsiveness, validation)
**Iteration 3+**: Include LOW priority (performance optimization)

**Rationale**: Visual fidelity must converge first; accessibility/performance refinements can cause visual regression if applied too early.

### 1.3 Specific Visual Difference Detection

Rather than generic "match exactly" feedback, extract specific differences:

```javascript
// Example output from visual diff analysis
{
  "visual_differences": [
    "Header background: expected #1a202c, got #2d3748 (delta: 15)",
    "Font size in .title: expected 36px, got 32px",
    "Spacing between nav items: expected 24px, got 16px",
    "Hero image aspect ratio: expected 16:9, got 4:3"
  ],
  "affected_regions": [
    "Header (top 80px)",
    "Navigation bar",
    "Hero section"
  ]
}
```

**Prompt Injection**:
```
PREVIOUS ATTEMPT HAD THESE ISSUES:
- Header background color is too light (#2d3748 instead of #1a202c)
- Title font size is too small (32px instead of 36px)
- Navigation spacing is too tight (16px instead of 24px)
- Hero image aspect ratio is incorrect (4:3 instead of 16:9)

Please fix these specific issues while maintaining all other correct elements.
```

---

## 2. Prompt Template Design

### 2.1 Base Prompt Structure

The base prompt (from screenshot-to-code) is **345 tokens**. This is our foundation.

```javascript
// Base prompt (NEVER modified)
const BASE_SYSTEM_PROMPT = `You are an expert Tailwind developer
You take screenshots of a reference web page from the user, and then build single page apps
using Tailwind, HTML and JS.

- Make sure the app looks exactly like the screenshot.
- Pay close attention to background color, text color, font size, font family,
padding, margin, border, etc. Match the colors and sizes exactly.
- Use the exact text from the screenshot.
- Do not add comments in the code such as "<!-- Add other navigation links as needed -->" and "<!-- ... other news items ... -->" in place of writing the full code. WRITE THE FULL CODE.
- Repeat elements as needed to match the screenshot. For example, if there are 15 items, the code should have 15 items. DO NOT LEAVE comments like "<!-- Repeat for each news item -->" or bad things will happen.
- For images, use placeholder images from https://placehold.co and include a detailed description of the image in the alt text so that an image generation AI can generate the image later.

In terms of libraries,

- Use this script to include Tailwind: <script src="https://cdn.tailwindcss.com"></script>
- You can use Google Fonts
- Font Awesome for icons: <link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/5.15.3/css/all.min.css"></link>

Return only the full code in <html></html> tags.
Do not include markdown "\`\`\`" or "\`\`\`html" at the start or end.`;

// Refinement constraints (appended to system prompt)
const REFINEMENT_CONSTRAINTS = `

REFINEMENT ITERATION {iteration_number}:
The previous attempt scored {previous_score} and had the following issues:
{feedback_summary}

Focus on fixing these issues while preserving all correctly implemented elements.`;
```

### 2.2 Constraint Injection Strategy

**Option A: System Prompt Append** (Recommended)
- Append refinement constraints to system prompt
- Keeps user prompt simple and consistent
- Token cost: +50-150 per iteration

**Option B: User Prompt Enhancement**
- Add constraints to user message
- Preserves original system prompt
- May reduce instruction following (system > user in Claude's priority)

**Recommendation**: Option A (system prompt append) based on research showing system-level instructions have higher compliance rates.

### 2.3 Token Budget Management

**Budget Allocation** (per iteration):

| Component | Iteration 1 | Iteration 2 | Iteration 3 | Iteration 4+ |
|-----------|-------------|-------------|-------------|--------------|
| Base Prompt | 345 | 345 | 345 | 345 |
| Image Tokens | ~1400 | ~1400 | ~1400 | ~1400 |
| Refinement Constraints | 0 | 80 | 150 | 200 (DANGER) |
| **Total Input** | **1745** | **1825** | **1895** | **1945** |
| **% Increase** | - | +4.6% | +8.6% | +11.5% |

**Token Growth Rate**: ~50-80 tokens per iteration

**Guardrails**:
1. **Max Iterations**: 5 (hard limit to prevent >12% token growth)
2. **Summarization**: After iteration 3, summarize all constraints into top 3-5 issues
3. **Compression**: Use abbreviated feedback (e.g., "Header bg: #1a202c" instead of full sentences)

**Example Compressed Feedback** (Iteration 4):
```
ITERATION 4 - Top Issues Remaining:
1. Header bg: #1a202c (not #2d3748)
2. Nav spacing: 24px (not 16px)
3. Hero aspect: 16:9 (not 4:3)
```
Token cost: ~30 tokens (vs. 150 for verbose version)

### 2.4 Feedback Summarization Algorithm

```python
def summarize_feedback(all_feedback: List[Dict], max_issues: int = 5) -> str:
    """
    Summarize feedback across iterations to prevent token explosion.

    Strategy:
    1. Group issues by category (visual, accessibility, performance)
    2. Prioritize unresolved issues from previous iterations
    3. Limit to top N most impactful issues
    """

    # Group by category
    visual_issues = [f for f in all_feedback if f['category'] == 'visual']
    a11y_issues = [f for f in all_feedback if f['category'] == 'accessibility']
    perf_issues = [f for f in all_feedback if f['category'] == 'performance']

    # Sort by priority (delta from target)
    visual_issues.sort(key=lambda x: x['priority'], reverse=True)
    a11y_issues.sort(key=lambda x: x['priority'], reverse=True)

    # Select top N across categories
    selected = []
    selected.extend(visual_issues[:3])  # Top 3 visual
    selected.extend(a11y_issues[:2])    # Top 2 a11y

    # Compress to abbreviated format
    summary = []
    for issue in selected[:max_issues]:
        summary.append(f"{issue['location']}: {issue['fix']}")

    return "\n".join(summary)
```

---

## 3. Convergence Algorithm Specification

### 3.1 Hybrid Convergence Criteria

Combine three detection methods to avoid both premature stopping and infinite loops:

```python
def should_stop_iterating(scores: List[float], iteration: int, config: Dict) -> Tuple[bool, str]:
    """
    Determine if iteration should stop based on hybrid criteria.

    Returns: (should_stop, reason)
    """

    # Criterion 1: Absolute Threshold
    latest_score = scores[-1]
    if latest_score >= config['target_score']:
        return True, f"Target score reached ({latest_score:.3f} >= {config['target_score']})"

    # Criterion 2: Plateau Detection (no improvement for N iterations)
    if len(scores) >= config['plateau_window']:
        recent_scores = scores[-config['plateau_window']:]
        max_improvement = max(recent_scores) - min(recent_scores)

        if max_improvement < config['min_improvement']:
            return True, f"Plateau detected (max improvement: {max_improvement:.3f} in last {config['plateau_window']} iterations)"

    # Criterion 3: Improvement Rate Below Threshold
    if len(scores) >= 2:
        improvement = scores[-1] - scores[-2]

        if improvement < config['min_improvement_rate']:
            return True, f"Improvement rate too low ({improvement:.3f} < {config['min_improvement_rate']})"

    # Criterion 4: Divergence Detection (score decreased)
    if len(scores) >= 2 and scores[-1] < scores[-2]:
        delta = scores[-2] - scores[-1]

        if delta > config['max_regression']:
            return True, f"Divergence detected (score decreased by {delta:.3f})"

    # Criterion 5: Max Iterations Hard Limit
    if iteration >= config['max_iterations']:
        return True, f"Max iterations reached ({iteration})"

    return False, ""
```

### 3.2 Recommended Configuration

```python
DEFAULT_CONVERGENCE_CONFIG = {
    # Absolute thresholds
    'target_score': 0.85,           # Stop if score >= 0.85

    # Plateau detection
    'plateau_window': 2,            # Check last 2 iterations
    'min_improvement': 0.03,        # Must improve by >= 0.03 across window

    # Improvement rate
    'min_improvement_rate': 0.02,   # Must improve by >= 0.02 per iteration

    # Divergence handling
    'max_regression': 0.05,         # Stop if score drops by > 0.05

    # Hard limits
    'max_iterations': 5,            # Never exceed 5 iterations
}
```

**Rationale for Values**:

- **target_score (0.85)**: Based on screenshot-to-code achieving 85-90% visual accuracy; 0.85 is "good enough"
- **plateau_window (2)**: Research shows 3-5 iterations typical; 2-iteration window catches stagnation early
- **min_improvement (0.03)**: 3% improvement threshold balances sensitivity vs. noise
- **min_improvement_rate (0.02)**: 2% per-iteration minimum ensures meaningful progress
- **max_regression (0.05)**: 5% drop indicates divergence; stop immediately
- **max_iterations (5)**: Limits token growth to <12%; prevents runaway loops

### 3.3 Plateau Detection Deep Dive

**Problem**: LLMs can get stuck in local optima, repeatedly generating similar outputs with minor variations.

**Detection Strategy** (from GRACE framework):

```python
def detect_local_optima(scores: List[float], outputs: List[str], iteration: int) -> bool:
    """
    Detect if optimization is stuck in local optima.

    Indicators:
    1. Scores oscillating within narrow band
    2. Generated code is semantically similar across iterations
    3. Same issues reappearing
    """

    # Score oscillation check
    if len(scores) >= 3:
        recent_scores = scores[-3:]
        score_variance = np.var(recent_scores)

        if score_variance < 0.001:  # Very low variance
            return True

    # Code similarity check (optional, expensive)
    if len(outputs) >= 2:
        # Use embeddings or AST diff to check semantic similarity
        similarity = compute_code_similarity(outputs[-1], outputs[-2])

        if similarity > 0.95:  # 95% similar
            return True

    return False
```

**Escape Strategy** (from GRACE adaptive compression):

When local optima detected:
1. **Distill core concepts**: Extract only the TOP 3 most critical issues
2. **Restart with fresh perspective**: Clear all previous refinement history
3. **Increase temperature**: Temporarily increase from 1.0 to 1.2 for more exploration

```python
def escape_local_optima(current_prompt: str, scores: List[float]) -> str:
    """
    Apply adaptive compression to escape local optima.
    """

    # Extract top 3 issues from all previous feedback
    core_issues = extract_core_issues(current_prompt, top_n=3)

    # Reset to base prompt + compressed constraints
    escaped_prompt = BASE_SYSTEM_PROMPT + f"""

CRITICAL ISSUES TO FIX:
{core_issues}

Approach this fresh - ignore previous attempts and focus only on these core issues.
"""

    return escaped_prompt
```

### 3.4 Divergence Handling

**Problem**: Score can decrease after refinement (e.g., fixing accessibility breaks visual layout).

**Detection**:
```python
if scores[-1] < scores[-2]:
    delta = scores[-2] - scores[-1]

    if delta > 0.05:  # 5% regression
        # DIVERGENCE DETECTED
```

**Handling Strategies**:

**Option 1: Immediate Stop** (Conservative)
- Stop iteration immediately
- Return best result so far
- Use case: Production systems where stability > optimal score

**Option 2: Revert to Best** (Recommended)
- Keep track of best result seen so far
- If divergence detected, revert to best and try one more iteration with modified approach
- Use case: Most scenarios

**Option 3: Continue with Warning** (Aggressive)
- Log warning but continue iterating
- Assume divergence is temporary exploration
- Use case: Research/experimentation

**Implementation**:

```python
def handle_divergence(scores: List[float], results: List[Dict], strategy: str = 'revert') -> Dict:
    """
    Handle score regression.
    """

    if strategy == 'stop':
        # Return best result immediately
        best_idx = np.argmax(scores)
        return results[best_idx]

    elif strategy == 'revert':
        # Revert to best, try one more time with escaped prompt
        best_idx = np.argmax(scores)
        best_result = results[best_idx]

        # Generate escape prompt
        escaped_prompt = escape_local_optima(
            current_prompt=best_result['prompt'],
            scores=scores
        )

        # Try one more iteration
        return {
            'action': 'retry_with_escape',
            'base_result': best_result,
            'escaped_prompt': escaped_prompt
        }

    elif strategy == 'continue':
        # Log and continue
        logger.warning(f"Divergence detected: {scores[-2]:.3f} -> {scores[-1]:.3f}")
        return {'action': 'continue'}
```

**Recommendation**: Use `revert` strategy for balance between exploration and stability.

---

## 4. Example Refinement Flow

### 4.1 Three-Iteration Example

**Input**: Landing page design screenshot (SaaS product)
**Target Score**: 0.85 (visual similarity)
**Max Iterations**: 5

#### Iteration 1: Initial Generation

**Prompt**:
```
[BASE_SYSTEM_PROMPT]
```

**User Message**:
```
Generate code for a web page that looks exactly like this.
[Image: landing_page.png]
```

**Result**:
```javascript
{
  "iteration": 1,
  "score": 0.68,
  "duration_ms": 8500,
  "tokens": { "input": 1745, "output": 3200 },
  "issues": [
    {
      "category": "visual",
      "description": "Header background: expected #1a202c, got #2d3748",
      "priority": 9,
      "delta": 15
    },
    {
      "category": "visual",
      "description": "Hero font size: expected 48px, got 36px",
      "priority": 8,
      "delta": 12
    },
    {
      "category": "visual",
      "description": "CTA button color: expected #3b82f6, got #2563eb",
      "priority": 7,
      "delta": 8
    },
    {
      "category": "accessibility",
      "description": "Missing alt text on 3 images",
      "priority": 5
    },
    {
      "category": "accessibility",
      "description": "Contrast ratio 3.8:1 on nav links (needs 4.5:1)",
      "priority": 4
    }
  ]
}
```

**Decision**: Continue (score 0.68 < target 0.85)

#### Iteration 2: Visual Refinement

**Prompt**:
```
[BASE_SYSTEM_PROMPT]

REFINEMENT ITERATION 2:
The previous attempt scored 0.68 and had the following visual issues:

1. Header background: use #1a202c (not #2d3748)
2. Hero heading font size: use 48px (not 36px)
3. CTA button color: use #3b82f6 (not #2563eb)

Fix these specific color and sizing issues while keeping all other elements correct.
```

**User Message**:
```
Generate code for a web page that looks exactly like this.
[Image: landing_page.png]
```

**Result**:
```javascript
{
  "iteration": 2,
  "score": 0.79,
  "improvement": 0.11,
  "duration_ms": 9200,
  "tokens": { "input": 1825, "output": 3300 },
  "issues": [
    {
      "category": "visual",
      "description": "Feature card spacing: expected 32px, got 24px",
      "priority": 5,
      "delta": 8
    },
    {
      "category": "visual",
      "description": "Footer text color: expected #94a3b8, got #64748b",
      "priority": 4,
      "delta": 6
    },
    {
      "category": "accessibility",
      "description": "Missing alt text on 3 images",
      "priority": 5
    },
    {
      "category": "accessibility",
      "description": "Heading hierarchy skip (h1 -> h3)",
      "priority": 3
    }
  ]
}
```

**Decision**: Continue (score 0.79 < target 0.85, improvement 0.11 > min 0.02)

#### Iteration 3: Visual + Accessibility Refinement

**Prompt**:
```
[BASE_SYSTEM_PROMPT]

REFINEMENT ITERATION 3:
The previous attempt scored 0.79 (improved from 0.68). Remaining issues:

VISUAL:
1. Feature card spacing: use 32px gap (not 24px)
2. Footer text color: use #94a3b8 (not #64748b)

ACCESSIBILITY:
3. Add descriptive alt text to all images
4. Fix heading hierarchy (don't skip from h1 to h3)

Fix these while preserving all correctly implemented elements from iteration 2.
```

**User Message**:
```
Generate code for a web page that looks exactly like this.
[Image: landing_page.png]
```

**Result**:
```javascript
{
  "iteration": 3,
  "score": 0.87,
  "improvement": 0.08,
  "duration_ms": 9800,
  "tokens": { "input": 1895, "output": 3400 },
  "issues": [
    {
      "category": "visual",
      "description": "Testimonial avatar size: expected 64px, got 56px",
      "priority": 2,
      "delta": 8
    },
    {
      "category": "performance",
      "description": "Bundle size 520KB (could inline critical CSS)",
      "priority": 1
    }
  ]
}
```

**Decision**: STOP (score 0.87 >= target 0.85)

**Final Result**:
```javascript
{
  "status": "converged",
  "reason": "Target score reached (0.87 >= 0.85)",
  "iterations": 3,
  "final_score": 0.87,
  "initial_score": 0.68,
  "total_improvement": 0.19,
  "total_duration_ms": 27500,
  "total_tokens": {
    "input": 5465,
    "output": 9900
  },
  "cost_usd": 0.095,  // Based on Sonnet 4.5 pricing
  "best_result": {
    "iteration": 3,
    "code": "...",
    "score": 0.87
  }
}
```

### 4.2 Plateau Detection Example

**Scenario**: Score stagnates at 0.75 for 2 iterations

**Iteration 2**: 0.75 (improved from 0.68)
**Iteration 3**: 0.76 (improvement: 0.01)
**Iteration 4**: 0.75 (improvement: -0.01, REGRESSION)

**Detection**:
```python
scores = [0.68, 0.75, 0.76, 0.75]

# Check plateau
recent_scores = scores[-2:]  # [0.76, 0.75]
max_improvement = max(recent_scores) - min(recent_scores)  # 0.01

if max_improvement < 0.03:  # min_improvement threshold
    # PLATEAU DETECTED

# Check improvement rate
improvement = scores[-1] - scores[-2]  # -0.01

if improvement < 0.02:  # min_improvement_rate threshold
    # LOW IMPROVEMENT RATE
```

**Response**:
```python
{
  "status": "stopped",
  "reason": "Plateau detected (max improvement: 0.01 in last 2 iterations)",
  "iterations": 4,
  "final_score": 0.76,  # Use best score, not latest
  "recommendation": "Manual review recommended - may have reached LLM limitations"
}
```

### 4.3 Divergence Example

**Scenario**: Accessibility fixes break visual layout

**Iteration 2**: 0.79 (visual good)
**Iteration 3**: 0.72 (added ARIA labels, broke spacing)

**Detection**:
```python
scores = [0.68, 0.79, 0.72]

delta = scores[-2] - scores[-1]  # 0.07

if delta > 0.05:  # max_regression threshold
    # DIVERGENCE DETECTED
```

**Response** (using 'revert' strategy):
```python
{
  "action": "revert_and_retry",
  "reverted_to": {
    "iteration": 2,
    "score": 0.79,
    "code": "..."
  },
  "retry_strategy": "escape_local_optima",
  "modified_prompt": """
[BASE_SYSTEM_PROMPT]

CRITICAL: Previous attempt to add accessibility broke visual layout.

Focus on adding ARIA labels and alt text WITHOUT changing any spacing, colors, or sizing.
Keep all visual elements exactly as they are.

ACCESSIBILITY FIXES ONLY:
1. Add alt text to images
2. Add ARIA labels where needed
3. Fix heading hierarchy

DO NOT MODIFY: spacing, colors, font sizes, margins, padding
"""
}
```

**Iteration 4** (with escaped prompt): 0.84 (success - accessibility added without visual regression)

---

## 5. Implementation Recommendations

### 5.1 Minimal Viable Implementation

**Phase 1: Basic Feedback Loop** (Week 1)
1. Implement visual similarity eval (perceptual hash)
2. Implement basic feedback → prompt mapping (top 3 visual issues)
3. Implement simple convergence (absolute threshold + max iterations)
4. Test with 5 representative designs

**Phase 2: Robust Convergence** (Week 2)
1. Add plateau detection
2. Add improvement rate tracking
3. Add divergence handling (revert strategy)
4. Add feedback summarization for iteration 3+

**Phase 3: Multi-Metric** (Week 3)
1. Add accessibility eval integration
2. Add performance eval integration
3. Implement priority system for feedback
4. Add local optima escape mechanism

### 5.2 Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                    Iterative Refinement Pipeline            │
└─────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────┐
│  1. Generate Initial Code (base prompt)                     │
│     - Input: Reference image                                │
│     - Output: HTML/CSS code                                 │
│     - Score: Run evals → 0.68                               │
└─────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────┐
│  2. Convergence Check                                        │
│     - Score >= target (0.85)? → STOP                        │
│     - Plateau detected? → STOP                              │
│     - Divergence detected? → REVERT                         │
│     - Max iterations? → STOP                                │
│     - Else: Continue to Step 3                              │
└─────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────┐
│  3. Feedback Extraction                                      │
│     - Parse eval results                                    │
│     - Identify top N issues (by priority)                   │
│     - Categorize: visual / accessibility / performance      │
│     - Generate specific actionable feedback                 │
└─────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────┐
│  4. Prompt Refinement                                        │
│     - Append feedback to system prompt                      │
│     - Apply summarization if iteration > 3                  │
│     - Check token budget (<12% growth)                      │
└─────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────┐
│  5. Generate Refined Code                                    │
│     - Input: Image + refined prompt                         │
│     - Output: Improved HTML/CSS                             │
│     - Score: Run evals → 0.79                               │
└─────────────────────────────────────────────────────────────┘
                              │
                              ▼
                       (Loop back to Step 2)
```

### 5.3 Code Structure

```typescript
// src/refinement/types.ts
interface RefinementConfig {
  targetScore: number;
  maxIterations: number;
  plateauWindow: number;
  minImprovement: number;
  minImprovementRate: number;
  maxRegression: number;
}

interface EvalResult {
  score: number;
  issues: Issue[];
  metadata: Record<string, any>;
}

interface Issue {
  category: 'visual' | 'accessibility' | 'performance';
  description: string;
  priority: number;
  fix?: string;
  location?: string;
  delta?: number;
}

interface IterationResult {
  iteration: number;
  score: number;
  code: string;
  issues: Issue[];
  prompt: string;
  tokens: { input: number; output: number };
  duration_ms: number;
}

interface RefinementResult {
  status: 'converged' | 'plateau' | 'diverged' | 'max_iterations';
  reason: string;
  iterations: number;
  finalScore: number;
  initialScore: number;
  totalImprovement: number;
  bestResult: IterationResult;
  history: IterationResult[];
}

// src/refinement/feedback.ts
class FeedbackGenerator {
  extractIssues(evalResult: EvalResult): Issue[] { ... }
  prioritizeIssues(issues: Issue[]): Issue[] { ... }
  generateFeedback(issues: Issue[], iteration: number): string { ... }
  summarizeFeedback(issues: Issue[], maxIssues: number): string { ... }
}

// src/refinement/convergence.ts
class ConvergenceDetector {
  shouldStop(scores: number[], iteration: number, config: RefinementConfig): [boolean, string] { ... }
  detectPlateau(scores: number[], config: RefinementConfig): boolean { ... }
  detectDivergence(scores: number[], config: RefinementConfig): boolean { ... }
}

// src/refinement/prompt.ts
class PromptRefiner {
  constructor(private basePrompt: string) {}

  appendConstraints(feedback: string, iteration: number): string { ... }
  escapeLocalOptima(issues: Issue[]): string { ... }
  checkTokenBudget(prompt: string): number { ... }
}

// src/refinement/pipeline.ts
class RefinementPipeline {
  constructor(
    private generator: CodeGenerator,
    private evaluator: Evaluator,
    private feedbackGen: FeedbackGenerator,
    private convergence: ConvergenceDetector,
    private promptRefiner: PromptRefiner,
    private config: RefinementConfig
  ) {}

  async refine(imagePath: string): Promise<RefinementResult> {
    const history: IterationResult[] = [];
    const scores: number[] = [];

    for (let i = 1; i <= this.config.maxIterations; i++) {
      // Generate code
      const code = await this.generator.generate(imagePath);

      // Evaluate
      const evalResult = await this.evaluator.evaluate(code, imagePath);

      // Record results
      const result: IterationResult = { iteration: i, score: evalResult.score, ... };
      history.push(result);
      scores.push(evalResult.score);

      // Check convergence
      const [shouldStop, reason] = this.convergence.shouldStop(scores, i, this.config);
      if (shouldStop) {
        return this.buildResult('converged', reason, history, scores);
      }

      // Generate feedback for next iteration
      const issues = this.feedbackGen.extractIssues(evalResult);
      const feedback = this.feedbackGen.generateFeedback(issues, i);

      // Refine prompt
      this.promptRefiner.appendConstraints(feedback, i + 1);
    }

    return this.buildResult('max_iterations', 'Max iterations reached', history, scores);
  }
}
```

---

## 6. Risks and Limitations

### 6.1 Known Risks

| Risk | Likelihood | Impact | Mitigation |
|------|------------|--------|------------|
| **Prompt Token Explosion** | HIGH | HIGH | Implement summarization after iteration 3; hard limit at 5 iterations |
| **Local Optima Trapping** | MEDIUM | HIGH | Implement GRACE-style escape mechanism; detect semantic similarity |
| **Divergence from Accessibility Fixes** | MEDIUM | MEDIUM | Use priority system; defer accessibility to iteration 2+ |
| **Evaluation Noise** | MEDIUM | MEDIUM | Use average of multiple metrics; require consistent improvement across 2 iterations |
| **LLM Non-Determinism** | LOW | MEDIUM | Set temperature = 1.0 consistently; use same model version |
| **Cost Escalation** | MEDIUM | LOW | Track cumulative cost; set budget limits per refinement session |

### 6.2 Limitations

1. **Eval Quality Dependency**: Refinement only as good as eval metrics
   - Visual similarity may miss semantic differences
   - Accessibility score may not catch all WCAG violations
   - Solution: Use multiple complementary evals

2. **Contradiction Between Metrics**: Improving one metric may degrade another
   - Example: Adding ARIA labels increases HTML size (performance)
   - Example: Fixing accessibility may break visual layout
   - Solution: Priority system + sequential refinement (visual first, then accessibility)

3. **LLM Context Limitations**: Claude has finite context window
   - Each iteration adds to input tokens
   - At some point, prompt becomes too long
   - Solution: Token budget management + compression

4. **Diminishing Returns**: Improvements decrease with each iteration
   - Iteration 1 → 2: +11% improvement
   - Iteration 2 → 3: +8% improvement
   - Iteration 3 → 4: +3% improvement
   - Solution: Plateau detection stops when returns too low

5. **Non-Reproducibility**: LLM outputs vary even with same prompt
   - Temperature = 1.0 introduces randomness
   - Same feedback may yield different code
   - Solution: Track best result; allow revert to previous iteration

### 6.3 Edge Cases

**Edge Case 1: Oscillating Scores**
```
Scores: [0.68, 0.75, 0.71, 0.76, 0.70, ...]
```
**Issue**: Score bounces up and down, never converges
**Detection**: Check variance of last 3 scores
**Handling**: Stop if variance > threshold for 3 iterations; return best score

**Edge Case 2: Immediate Divergence**
```
Scores: [0.75, 0.62, ...]
```
**Issue**: First refinement makes things worse
**Detection**: Iteration 2 score < iteration 1 score
**Handling**: Return iteration 1 result; log warning for manual review

**Edge Case 3: Perfect Score Too Early**
```
Scores: [0.95, ...]
```
**Issue**: First generation already exceeds target
**Detection**: Iteration 1 score >= target_score
**Handling**: Stop immediately; no refinement needed

**Edge Case 4: Stuck at Low Score**
```
Scores: [0.42, 0.45, 0.43, 0.44, ...]
```
**Issue**: Never reaches target, but keeps making tiny improvements
**Detection**: All scores < 0.6 after 3 iterations
**Handling**: Stop; flag for manual review (likely fundamental mismatch)

---

## 7. Future Research Directions

### 7.1 Advanced Feedback Extraction

**Current**: Parse eval JSON, extract top N issues
**Future**: Use LLM to analyze visual diff and generate natural language feedback

```python
# Use Claude to analyze pixel diff heatmap
feedback_prompt = f"""
Analyze this visual difference heatmap between reference and generated images.

Reference: [image]
Generated: [image]
Diff Heatmap: [heatmap image with red = different]

Identify the top 3 visual differences and provide specific CSS/HTML fixes.
"""

# Claude analyzes images and generates targeted feedback
feedback = await claude.messages.create(
    model="claude-sonnet-4-5",
    messages=[{"role": "user", "content": feedback_prompt}]
)
```

**Benefit**: More nuanced, context-aware feedback than rule-based extraction

### 7.2 Multi-Objective Optimization

**Current**: Optimize single composite score
**Future**: Pareto optimization across multiple objectives

```python
# Treat as multi-objective problem
objectives = {
    'visual_similarity': 0.75,
    'accessibility': 0.85,
    'performance': 0.90
}

# Find Pareto-optimal solutions (no objective can improve without degrading another)
pareto_frontier = find_pareto_optimal(results, objectives)

# Let user choose from frontier based on priorities
```

### 7.3 Reinforcement Learning from Human Feedback (RLHF)

**Current**: Automated eval scores
**Future**: Incorporate human preferences

```python
# Show user 2-3 variants
variants = [iteration_2_result, iteration_3_result, iteration_4_result]

# User ranks: 3 > 2 > 4
ranking = get_user_ranking(variants)

# Use ranking to fine-tune feedback generation
# Learn which types of feedback lead to user-preferred outputs
```

### 7.4 Prompt Optimization via Meta-Learning

**Current**: Hand-crafted feedback templates
**Future**: Learn optimal feedback format via meta-learning

```python
# DSPy-style approach: optimize the prompt template itself
class FeedbackTemplate(dspy.Signature):
    """Generate refinement feedback from eval results."""
    eval_result = dspy.InputField()
    iteration = dspy.InputField()
    feedback = dspy.OutputField()

# Compile template using training examples
compiled = dspy.BootstrapFewShot().compile(
    FeedbackTemplate,
    trainset=training_examples
)

# Use compiled template for production
feedback = compiled(eval_result=eval, iteration=2).feedback
```

---

## 8. Conclusion

### 8.1 Key Takeaways

1. **Feedback → Prompt Mapping**
   - Use specific, actionable feedback (not generic "match exactly")
   - Prioritize issues: visual first, then accessibility, then performance
   - Extract top 3-5 issues per iteration to manage token budget

2. **Prompt Template Structure**
   - Append refinement constraints to system prompt (not user message)
   - Implement token budget management (max 12% growth across 5 iterations)
   - Use compression/summarization after iteration 3

3. **Convergence Criteria**
   - Hybrid approach: absolute threshold + plateau detection + improvement rate + divergence + max iterations
   - Recommended config: target=0.85, plateau_window=2, min_improvement=0.03, max_iterations=5
   - Implement revert strategy for divergence handling

4. **Implementation Strategy**
   - Start with Phase 1 (basic feedback loop with visual similarity only)
   - Add robust convergence in Phase 2
   - Expand to multi-metric in Phase 3
   - Expect 3-5 iterations to converge for typical cases

### 8.2 Uncertainty Reduction

**Before Research**: 4/5 uncertainty (no clear strategy for feedback loop)
**After Research**: 2/5 uncertainty (clear framework, but implementation details TBD)

**Remaining Uncertainties**:
1. How to extract specific visual differences from perceptual hash/pixel diff?
2. What's the optimal priority weighting for multi-metric scenarios?
3. Will 5 iterations be sufficient for complex designs?

**Next Steps**:
1. Implement Phase 1 MVP with basic visual feedback
2. Test with 10-20 representative designs
3. Measure convergence rate and token costs
4. Refine thresholds based on empirical data

### 8.3 Success Metrics

Track these metrics during implementation:

| Metric | Target | Measurement |
|--------|--------|-------------|
| **Convergence Rate** | >80% of designs reach target score | % of tests that converge |
| **Average Iterations** | 3-4 iterations | Mean iterations to convergence |
| **Improvement per Iteration** | >0.05 average | Mean score delta per iteration |
| **Token Growth** | <12% by iteration 5 | (iter5_tokens - iter1_tokens) / iter1_tokens |
| **Divergence Rate** | <10% of iterations | % of iterations where score decreases |
| **Cost per Refinement** | <$0.15 | Total cost across all iterations |

---

## References

### Academic Research

1. **Self-Refine: Iterative Refinement with Self-Feedback** (Madaan et al., 2023)
   - Framework for LLM self-improvement via feedback loop
   - https://selfrefine.info/

2. **PromptWizard: Feedback-Driven Self-Evolving Prompts** (Microsoft Research, 2024)
   - Automated prompt optimization converging in 3-5 iterations
   - https://www.microsoft.com/en-us/research/blog/promptwizard-the-future-of-prompt-optimization-through-feedback-driven-self-evolving-prompts/

3. **GRACE: Gated Refinement and Adaptive Compression** (2024)
   - Solves local optima and prompt explosion problems
   - https://arxiv.org/html/2509.23387

4. **APO-CF: Prompt Optimization via Confusion Matrix Feedback** (2025)
   - Efficient single-step optimization using structured feedback
   - https://www.mdpi.com/2076-3417/15/9/5198

### Vision-Language Models

5. **Context Optimization (CoOp)** for Vision-Language Models (Zhou et al., 2022)
   - Semantic alignment between image and text features
   - https://openaccess.thecvf.com/content/CVPR2022/papers/Zhou_Conditional_Prompt_Learning_for_Vision-Language_Models_CVPR_2022_paper.pdf

6. **Visual Prompt Engineering for VLMs** (NVIDIA, 2024)
   - Prompt engineering strategies for image understanding
   - https://developer.nvidia.com/blog/vision-language-model-prompt-engineering-guide-for-image-and-video-understanding/

### Industry Practice

7. **Prompt Learning with Natural Language Feedback** (Arize AI, 2024)
   - 10% improvement using text feedback vs. numerical scores
   - https://arize.com/blog/prompt-learning-using-english-feedback-to-optimize-llm-systems/

8. **IBM Prompt Optimization Guide** (2025)
   - Best practices for iterative prompt refinement
   - https://www.ibm.com/think/topics/prompt-optimization

---

**Document Version**: 1.0
**Last Updated**: 2025-12-12
**Author**: Research Spike (Claude Code Agent)
**Status**: Ready for Implementation
