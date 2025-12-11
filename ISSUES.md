# Issues & Spike Tasks

**Last Updated**: 2025-12-12
**Purpose**: Track spike tasks, high-uncertainty items, and blocking issues

---

## Spike Tasks (CRITICAL - Must Complete Before Implementation)

Spike tasks are time-boxed research efforts to reduce uncertainty before implementing dependent features.

### Spike 1: Research Eval Metrics for Iterative Refinement

**ID**: `spike_6_1_1` (maps to task_6_1_1 in PROGRESS.md)
**Status**: 🔴 Not Started
**Duration**: 3-5 days (time-boxed)
**Start Blocker**: Must complete before implementing Epic 6.1 (Eval Framework)
**Reduces Uncertainty**: task_6_1_1 UA: 4/5 → 2/5

**Research Questions**:
1. Which visual similarity metrics best correlate with user satisfaction?
   - SSIM (Structural Similarity Index) - standard but may miss perceptual details
   - pHash (Perceptual Hashing) - faster, good for near-duplicates
   - LPIPS (Learned Perceptual Image Patch Similarity) - deep learning based, may be expensive

2. What accessibility metrics matter most?
   - WCAG 2.1 Level AA compliance (binary)?
   - Weighted violation severity scoring?
   - Impact-based scoring (high-impact violations only)?

3. How to combine visual, accessibility, and performance scores into single composite?
   - Equal weights (1/3 each)?
   - Visual-dominant (0.5 visual, 0.25 accessibility, 0.25 performance)?
   - User-configurable?

**Deliverables**:
1. **Metric comparison table**
   - Runtime (ms per image)
   - Accuracy/correlation with user feedback
   - Implementation complexity
   - Cost (if external API required)

2. **Recommended metric set**
   - Primary visual similarity metric (SSIM vs pHash vs LPIPS)
   - Accessibility scoring approach
   - Performance thresholds
   - Composite score formula

3. **POC implementation**
   - Small test with 5 generated outputs
   - Run selected metrics
   - Validate correlation with expected quality

**Acceptance Criteria**:
- ✅ Metric selection documented with rationale
- ✅ Trade-offs analyzed (accuracy vs speed)
- ✅ POC demonstrates metric correlation with quality
- ✅ Uncertainty reduced: 4/5 → 2/5
- ✅ Ready to implement task_6_1_2 (eval metric computation)

**Recommended Approach**:
1. Day 1: Research metric options, survey existing implementations
2. Day 1-2: Implement POC with SSIM (simplest, established)
3. Day 2: Test alternative (pHash) for comparison
4. Day 3: Accessibility scoring approach research
5. Day 4: Composite score formula design
6. Day 5: Document findings and recommendation

---

### Spike 2: Investigate Prompt Optimization Strategies

**ID**: `spike_6_2_1` (maps to task_6_2_1 in PROGRESS.md)
**Status**: 🔴 Not Started
**Duration**: 4-5 days (time-boxed)
**Start Blocker**: Must complete before implementing Epic 6.2 (Feedback Loop)
**Reduces Uncertainty**: task_6_2_1 UA: 4/5 → 2/5

**Research Questions**:
1. Which eval feedback signals should modify the prompt?
   - Low visual similarity → "Look at reference image X, match colors exactly"
   - Low accessibility → "Ensure WCAG 2.1 AA compliance: add alt text, semantic HTML"
   - High bundle size → "Minimize CSS, use minimal HTML structure"

2. How to inject feedback without prompt explosion?
   - Simply append violations to prompt? (risk: exceeds token budget)
   - Summarize top 3 most impactful violations?
   - Build constraint template that grows iteratively?

3. What are convergence criteria?
   - Score improvement <0.05 for 2 iterations = plateau?
   - Absolute threshold (e.g., composite score >0.85) = good enough?
   - Max iterations (3, 5, 10) = hard limit?

4. How to handle divergence (score goes DOWN)?
   - Revert to previous prompt?
   - Stop iteration immediately?
   - Log as warning and continue?

**Deliverables**:
1. **Prompt feedback strategy document**
   - Which metrics → which prompt constraints (mapping table)
   - Constraint template with examples
   - Token growth estimates

2. **Convergence algorithm specification**
   - Plateau detection logic
   - Threshold vs improvement criteria comparison
   - Max iteration strategy
   - Divergence handling

3. **POC implementation**
   - Generate output, check eval, modify prompt once
   - Verify second generation improves on issue
   - Test convergence detection with 3-5 iterations

**Acceptance Criteria**:
- ✅ Feedback signals identified and mapped to prompt modifications
- ✅ Convergence criteria defined with logic
- ✅ POC demonstrates prompt refinement improving eval score
- ✅ Uncertainty reduced: 4/5 → 2/5
- ✅ Ready to implement task_6_2_2 (feedback loop pipeline)

**Recommended Approach**:
1. Day 1: Survey existing prompt optimization techniques
2. Day 1-2: Design feedback→prompt mapping (which signals change what)
3. Day 2: Implement POC refinement (eval violation → constraint)
4. Day 3: Test with 3-5 iterations, observe convergence
5. Day 3-4: Design convergence detection algorithm
6. Day 5: Document strategy and acceptance criteria

---

## High-Risk Issues (Requires Monitoring)

### Issue 1: Cross-Platform Terminal Automation Complexity

**ID**: `risk_2_1_1`
**Severity**: High
**Affects**: Subtask_2_1_1 (terminal spawning)

**Problem**:
Terminal spawning varies significantly by OS:
- Linux: Multiple terminal options (gnome-terminal, konsole, xterm) with different CLI args
- macOS: AppleScript via `osascript`, requires proper focus handling
- Windows: Windows Terminal, cmd.exe, PowerShell all have different APIs

**Risks**:
1. Fragile cross-platform code → maintenance burden
2. Missing terminal emulator → silent failure
3. Encoding issues (non-ASCII prompts) on Windows
4. Timing issues with terminal launch and focus

**Mitigation**:
- ✅ Break into platform-specific subtasks (subtask_2_1_1_1/2/3)
- ✅ Abstraction layer (subtask_2_1_1_4) to isolate logic
- ✅ Comprehensive CI/CD testing on all 3 platforms (GitHub Actions matrix)
- ⏭️ Early POC testing on all platforms (first dev iteration)

**Status**: 🟡 Mitigated (architecture planned, implementation pending)

---

### Issue 2: Real-Time Output Streaming Performance

**ID**: `risk_2_1_3`
**Severity**: High
**Affects**: Subtask_2_1_3 (output capture and streaming)

**Problem**:
Streaming large, rapidly-emitted output via WebSocket while maintaining UI responsiveness:
- Buffer overflows if client is slow
- Latency spikes if chunks too large (>64KB)
- Incomplete UTF-8 sequences at chunk boundaries
- ANSI escape code handling complexity

**Risks**:
1. Loss of output data if buffer fills
2. UI freezes from large WebSocket messages
3. Garbled output from UTF-8 mishandling
4. Color codes disappearing in output

**Mitigation**:
- ✅ Backpressure handling in subtask_2_1_3_2 (buffer with flow control)
- ✅ Chunking strategy in subtask_2_1_3_3 (<64KB per message)
- ✅ UTF-8 boundary handling in subtask_2_1_3_3
- ✅ ANSI code preservation in subtask_2_1_3_3
- ⏭️ Load testing with large outputs (>100MB) and slow clients

**Status**: 🟡 Mitigated (architecture planned, implementation pending)

---

### Issue 3: LLM Cost Management in Multi-Pass Loop

**ID**: `risk_6_2_2`
**Severity**: Medium
**Affects**: Subtask_6_2_2_2 (rate limiting and cost tracking)

**Problem**:
Iterative refinement loops can become expensive:
- Each iteration requires full LLM call (~0.02-0.04 USD for Sonnet 4.5)
- 5 iterations = $0.10-0.20 per generation
- Uncontrolled loops could multiply cost

**Risks**:
1. Unexpected cost spikes if convergence tuning is off
2. Budget overruns from users running many iterations
3. Feedback loop spending more than single-pass baseline

**Mitigation**:
- ✅ Hard limits: max 5 iterations per generation (subtask_6_2_2_2)
- ✅ Cost tracking and budget enforcement: default $1.00 max spend (subtask_6_2_2_2)
- ✅ Convergence detection: abort on plateau (subtask_6_2_2_3)
- ⏭️ Cost breakdown reporting to user (in milestone 3 iteration tracking)
- ⏭️ A/B test convergence thresholds to find cost-quality sweet spot

**Status**: 🟡 Mitigated (cost controls planned, threshold tuning pending)

---

### Issue 4: Eval Metric Correlation with User Satisfaction

**ID**: `risk_6_1`
**Severity**: High (affects entire feedback loop)
**Affects**: Spike_1 and Epic 6.1 (eval framework)

**Problem**:
No guarantee that selected metrics (visual similarity, accessibility, performance) actually correlate with what users find satisfying.

**Risks**:
1. Feedback loop optimizes for wrong metrics
2. High eval scores don't translate to better user experience
3. Wasted iteration cycles

**Mitigation**:
- ✅ Spike 1 includes POC validation (test metric correlation)
- ⏭️ Post-launch: gather user feedback on generated outputs
- ⏭️ Iterate metric weights based on user feedback
- ⏭️ A/B test different metric combinations

**Status**: 🟡 Mitigated (spike research scheduled, user validation post-launch)

---

## Blocked Features (Awaiting Spikes)

### Feature 6.1: Eval Framework Setup

**Status**: ⏹️ **BLOCKED** - Awaiting Spike 1

**Unblocks When**: Spike 1 complete (metric selection report delivered)

**Dependent Tasks**:
- subtask_6_1_2_1: Playwright screenshot capture
- subtask_6_1_2_2: Image similarity metric
- subtask_6_1_2_3: Accessibility scoring
- subtask_6_1_2_4: Bundle size analysis
- subtask_6_1_2_5: Unified eval report

**Time to Unblock**: 3-5 days

---

### Feature 6.2: Feedback Loop & Iteration

**Status**: ⏹️ **BLOCKED** - Awaiting Spike 2

**Unblocks When**: Spike 2 complete (prompt optimization strategy delivered)

**Dependent Tasks**:
- subtask_6_2_2_1: State machine
- subtask_6_2_2_2: Rate limiting
- subtask_6_2_2_3: Convergence detection
- subtask_6_2_2_4: Prompt refinement
- subtask_6_2_2_5: Pipeline orchestration

**Time to Unblock**: 4-5 days

---

## Post-Launch Issues (Tracked for Future)

### Future: User Satisfaction Feedback Loop

**ID**: `future_user_feedback`
**Priority**: Medium
**Timeline**: Post-launch (after Phase 5 complete)

**Objective**: Validate that improved eval scores correlate with better user experience

**Action Items**:
1. Collect user feedback on generated outputs
2. Correlate with eval metric scores
3. Adjust metric weights if correlation weak
4. A/B test different metric combinations

---

## Decision Log

### Decision 1: Spike Tasks Required Before Implementation

**Made**: 2025-12-12 (during blueprint planning)
**Decision**: Two spike tasks must complete before implementing Phase 5 (eval and feedback loop)
**Rationale**: High uncertainty (UA ≥4) in metric selection and prompt optimization strategy; 3-5 day research time-box prevents scope creep
**Owner**: Project architect
**Status**: ✅ Accepted

### Decision 2: Cost Cap of $1.00 per Generation

**Made**: 2025-12-12 (during decomposition)
**Decision**: Rate limiting in subtask_6_2_2_2 enforces $1.00 max spend per generation run
**Rationale**: Prevents uncontrolled cost growth in iterative loops; can be adjusted per user
**Owner**: Infrastructure team
**Status**: ✅ Accepted

---

## Summary

**Total Spike Tasks**: 2 (8-10 days total blocking time)
**Total High-Risk Issues**: 4 (all mitigated with architecture, monitoring pending)
**Blocked Features**: 2 (Epic 6.1, Epic 6.2 - unblocks after spikes complete)
**Ready-to-Implement Features**: 7 (Milestone 1-4, Phase 5.1)

**Critical Path Impact**: Spikes add ~2 weeks to timeline, but must complete before feedback loop implementation
