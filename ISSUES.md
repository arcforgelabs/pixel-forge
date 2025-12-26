# Issues & Spike Tasks

**Last Updated**: 2025-12-27
**Purpose**: Track high-uncertainty items and blocking issues

---

## Completed Spikes

| Spike | Output | Completed |
|-------|--------|-----------|
| Eval Metrics Research | [docs/SPIKE-eval-metrics-research.md](docs/SPIKE-eval-metrics-research.md) | 2025-12-12 |
| Prompt Optimization | [docs/SPIKE-prompt-optimization-strategies.md](docs/SPIKE-prompt-optimization-strategies.md) | 2025-12-12 |

All Phase 5 features (Eval Framework, Feedback Loop) are now unblocked.

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

- **Spikes**: 2 complete (see Completed Spikes section)
- **High-Risk Issues**: 4 (all mitigated, monitoring pending)
- **Blocked Features**: None
