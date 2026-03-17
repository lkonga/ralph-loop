# Aggregation Report 1

**Wave**: 2026-03-17-ralph-checkpoint-patterns  
**Sources**: research-1.md, research-2.md, research-3.md  
**Date**: 2026-03-17

---

## Source Reports

### research-1.md — Human Checkpoint Patterns (Behavioral Analysis)
Deep audit of all human interaction surfaces in ralph-loop. Key findings: `HumanCheckpointRequested` is exclusively reactive (2 triggers: stagnation tier 3, diff validation exhausted). Cooldown dialog is closest to proactive but auto-continues on timeout. BearingsFailed has no UI handler (gap). No proactive/milestone/scheduled checkpoints exist anywhere in the codebase. [source: research-1.md#L1-L5]

### research-2.md — Explicit Checkpoints vs Dependency-Chain-with-Failing-Verifier (Design Analysis)
Compares three DSL approaches for adding checkpoints: (A) explicit `[CHECKPOINT]` annotation, (B) dependency + deliberate failing verifier, (C) hybrid `[GATE: condition]`. Recommends Approach A with optional verifier escape hatch. Includes implementation sketch (~40 lines across 3 files). [source: research-2.md#L1-L7]

### research-3.md — Agent-Initiated Clarification vs Human-Predefined Checkpoints (Tradeoff Analysis)
Full escalation chain breakdown (Tier 0–5), all 9 `additionalContext` injection points cataloged, and comparison matrix of reactive vs proactive checkpoint patterns. Recommends hybrid: keep reactive for genuine failures, add DSL checkpoints for human-declared gates. Identifies guidance persistence bug. [source: research-3.md#L1-L6]

---

## Deduplicated Findings

### Finding 1: HumanCheckpointRequested Is Exclusively Reactive (2 Triggers)

All three reports confirm `HumanCheckpointRequested` fires from exactly **two** code paths, both failure-driven:

| Trigger | Location | Condition |
|---------|----------|-----------|
| Stagnation Tier 3 | orchestrator.ts ~L760 | `staleIterations >= maxStaleIterations + 2` (default: ≥4) |
| Diff validation exhausted | orchestrator.ts ~L870 | `diffAttempt >= maxDiffValidationRetries` (default: 3) |

**Zero proactive checkpoint triggers exist in the codebase.** The PRD (line ~134) only specifies failure-driven checkpoints. [source: research-1.md#L13-L35] [source: research-2.md#L35-L42] [source: research-3.md#L18-L32]

### Finding 2: Complete Escalation Chain (6 Tiers)

Research-3 provides the most complete escalation taxonomy, confirmed by details in research-1:

| Tier | Mechanism | Human? |
|------|-----------|--------|
| 0 — Nudge | Re-send prompt with continuation suffix (up to `maxNudgesPerTask`) | No |
| 1 — Stagnation/Struggle | Inject "try different approach" / "completely different approach" | No |
| 1.5 — Confidence/Gate rejection | Re-enter task with feedback on failures | No |
| 2 — Circuit breaker / Stagnation Tier 2 | Skip task or stop loop | No |
| 3 — Auto-decompose | Split task into sub-tasks in PRD | No |
| 4 — HumanCheckpoint | Pause loop, show 4-option dialog | **Yes** |
| 5 — Stop | Terminate loop | **Yes**/Auto |

[source: research-3.md#L78-L100] [source: research-1.md#L27-L35]

### Finding 3: Cooldown Dialog — Semi-Proactive but Not a Checkpoint

All reports agree the cooldown dialog (`showCooldownDialog()`) is the closest thing to a proactive checkpoint but fundamentally different:
- Fires between every task (when `cooldownShowDialog !== false`)
- **Auto-continues on timeout** — non-blocking by design
- Does NOT yield `HumanCheckpointRequested`
- "Edit Next Task" correctly uses `injectContext()` (one-shot)
- Philosophically a "speak now or forever hold your peace" window, not a gate

[source: research-1.md#L37-L47] [source: research-3.md#L10-L17]

### Finding 4: HumanCheckpointRequested State Machine

When triggered, the full flow is:
```
yield HumanCheckpointRequested → pauseRequested=true → spin-wait loop
→ VS Code warning with 4 options:
  ├── Continue    → resume()
  ├── Skip Task   → resume() [IDENTICAL to Continue — see Finding 7]
  ├── Stop Loop   → stop()
  └── Provide Guidance → inputBox → appends to promptBlocks → resume()
```
[source: research-1.md#L49-L62] [source: research-3.md#L33-L44]

### Finding 5: Nine additionalContext Injection Points

Research-3 uniquely catalogs all sources that inject one-shot context into the agent prompt:

| Source | Context | When |
|--------|---------|------|
| SessionStart hook | Hook-provided context | Loop startup |
| Shell command blocked | Block reason | PostToolUse hook returns blocked |
| Stagnation Tier 1 | "You appear to be stuck..." | Below escalation threshold |
| Struggle detected | Struggle signals | StruggleDetector fires |
| Confidence score low | Score breakdown | Confidence check fails |
| Dual exit gate rejection | Gate reason + verification feedback | Model done but machine disagrees |
| TaskComplete hook (success) | Hook context | Hook chain passes |
| TaskComplete hook (failure) | Hook context | Hook chain fails/timeout |
| Pre-complete chain | Inherited from hooks | preCompleteHooks chain |

Key property: `additionalContext` is always one-shot and agent-facing (never shown to user). [source: research-3.md#L56-L76]

### Finding 6: BearingsFailed Has No UI Handler (Gap)

Research-1 uniquely identifies that `BearingsFailed` sets `pauseRequested = true` but has **no corresponding UI handler** in extension.ts — the loop silently pauses with no user dialog and no way to unpause except programmatic `resume()`. This is likely a bug. [source: research-1.md#L76-L79]

### Finding 7: "Skip Task" and "Continue" Are Functionally Identical (Bug)

Both research-1 and research-3 flag that in the `HumanCheckpointRequested` handler, "Skip Task" calls `resume()` identically to "Continue." There is no explicit skip mechanism — the task stays in its current state and the orchestrator re-attempts it. [source: research-1.md#L60-L62] [source: research-3.md#L167-L168]

### Finding 8: Guidance Persistence Bug

Research-3 identifies (and research-1 hints at) a bug: "Provide Guidance" in the HumanCheckpointRequested handler appends text to `promptBlocks` via `updateConfig()`, making it **permanent for ALL subsequent tasks**. This should use `injectContext()` (one-shot) to match the cooldown dialog's "Edit Next Task" behavior. [source: research-3.md#L163-L165] [source: research-1.md#L162-L163]

### Finding 9: Three Approaches for Explicit Checkpoints (Design Space)

Research-2 evaluates three design approaches:

| Approach | Mechanism | Pros | Cons |
|----------|-----------|------|------|
| **A: `[CHECKPOINT]` annotation** | Parser recognizes bracket marker, orchestrator emits checkpoint before execution | Zero wasted compute, intent clear, ~40 LOC | Not machine-verifiable, rigid |
| **B: Dependency + failing verifier** | Normal task with always-fail verifier exhausts retries → checkpoint | No DSL changes, machine-verifiable | Up to 7 wasted Copilot invocations, intent opaque, ~7 min wall clock waste |
| **C: Hybrid `[GATE: condition]`** | Annotation + inline verifier | Combines clarity with verifiability | Most complex, novel syntax |

[source: research-2.md#L55-L134]

### Finding 10: Existing Annotation Pattern Supports Extension

The `[DECOMPOSED]` annotation in the current parser already demonstrates the "bracket annotation → behavior change" pattern. `[CHECKPOINT]` would follow the same idiom — cheapest extension point. [source: research-2.md#L138-L139]

---

## Cross-Report Patterns

### Pattern 1: Purely Reactive Checkpoint Philosophy (3/3 reports)
**Confidence: HIGH** — All three reports independently confirm ralph-loop's checkpoint philosophy: the agent tries everything before involving the human. There are zero proactive checkpoints. This is by design (PRD only specifies failure-driven checkpoints), not an oversight. [source: research-1.md#L84-L91] [source: research-2.md#L35-L42] [source: research-3.md#L116-L123]

### Pattern 2: Cooldown Dialog as Proto-Checkpoint (3/3 reports)
**Confidence: HIGH** — All reports identify the cooldown dialog as the structural location where a proactive checkpoint could be added. Its auto-timeout mechanism and `injectContext()` integration demonstrate the UX pattern, but the non-blocking semantics need to change for true gating. [source: research-1.md#L37-L47] [source: research-2.md#L35-L42] [source: research-3.md#L10-L17]

### Pattern 3: Consensus on Explicit DSL Checkpoint (2/3 reports)
**Confidence: HIGH** — Research-2 and research-3 both recommend adding explicit DSL checkpoint syntax (research-2 recommends `[CHECKPOINT]`, research-3 suggests `[?]` or `⏸`). Both emphasize the need for CI/headless auto-approve mechanisms. Both reject pure verifier-as-gate due to wasted compute. [source: research-2.md#L149-L175] [source: research-3.md#L152-L161]

### Pattern 4: Guidance Path Bug (2/3 reports)
**Confidence: HIGH** — Research-1 and research-3 both flag the `promptBlocks` persistence issue. "Provide Guidance" should be one-shot (via `injectContext()`) not permanent (via `updateConfig()`). The cooldown dialog already does this correctly, proving the fix is straightforward. [source: research-1.md#L162-L163] [source: research-3.md#L163-L165]

### Pattern 5: Escalation Ladder is Well-Designed but Diagnostically Poor (2/3 reports)
**Confidence: MEDIUM** — Research-1 and research-3 agree the escalation chain is architecturally sound (graduated severity, multiple recovery attempts) but the human-facing context at checkpoint time is poor. The human sees "Stagnation detected" without knowing *why* the agent is stuck. The struggle signals, error hashes, and failed verification items are available internally but not surfaced. [source: research-1.md#L49-L62] [source: research-3.md#L102-L115]

---

## Priority Matrix

| Pattern | Impact | Effort | Sources |
|---------|--------|--------|---------|
| Add `[CHECKPOINT]` DSL annotation | **High** — enables proactive safety gates for destructive/sensitive operations | **Low** (~40 LOC across 3 files) | [research-2.md#L149-L175](research-2.md#L149-L175), [research-3.md#L152-L161](research-3.md#L152-L161) |
| Fix guidance persistence bug (`promptBlocks` → `injectContext`) | **Medium** — prevents stale guidance polluting all subsequent tasks | **Trivial** (1 line change) | [research-3.md#L163-L165](research-3.md#L163-L165), [research-1.md#L162-L163](research-1.md#L162-L163) |
| Fix "Skip Task" semantics | **Medium** — Skip should actually skip, not resume same task | **Low** (mark task skipped + advance) | [research-1.md#L60-L62](research-1.md#L60-L62), [research-3.md#L167-L168](research-3.md#L167-L168) |
| Add BearingsFailed UI handler | **Medium** — silent pause with no user dialog is a bug | **Low** (add handler in extension.ts) | [research-1.md#L76-L79](research-1.md#L76-L79) |
| Enrich checkpoint diagnostic context | **Medium** — surface struggle signals, error hashes, failed verifiers to human | **Medium** (aggregate + format diagnostic data) | [research-3.md#L102-L115](research-3.md#L102-L115), [research-1.md#L49-L62](research-1.md#L49-L62) |
| Add checkpoint auto-approve for CI/headless | **Medium** — enables non-interactive runs with checkpoints | **Low** (config flag + skip logic) | [research-2.md#L170-L173](research-2.md#L170-L173), [research-3.md#L157-L158](research-3.md#L157-L158) |
| Capture agent response text for diagnostics | **Low** (enhancement) — currently only side effects tracked | **Medium** (add response capture pipeline) | [research-3.md#L173-L174](research-3.md#L173-L174) |

---

## Gaps

1. **No report analyzed the `decisions.ts` decision engine** in relation to checkpoints. Research-2 mentions `src/decisions.ts` in scope but doesn't explore how the decision system could inform checkpoint triggers (e.g., "decision confidence below threshold → checkpoint").

2. **No report examined parallel task execution** and checkpoint interaction beyond a brief mention in research-2 (open question 4). If ralph adds parallel task execution, checkpoint semantics at convergence points need design.

3. **No report quantified the token/cost waste** of the current reactive approach — how many tokens are consumed between "agent gets stuck" and "human gets asked." This would strengthen the case for proactive checkpoints with concrete data.

4. **No report analyzed the `hookBridge.ts` pre-complete chain** as a potential checkpoint surface. Research-2 mentions it as an existing mechanism but doesn't explore using hooks as lightweight checkpoint triggers (e.g., a pre-complete hook that conditionally pauses for review).

5. **Agent self-awareness limitation**: Research-3 notes the prompt says "Do not ask questions — act," preventing agent-initiated clarification at the LLM level. No report explores whether a tool-based escape hatch (e.g., `request_review` tool) could bridge this without breaking the autonomous mandate.

---

## Sources

- **research-1.md** — Human Checkpoint Patterns: behavioral audit of all interaction surfaces, state machine documentation, BearingsFailed gap, adaptation opportunities for vscode-copilot-chat
- **research-2.md** — Explicit Checkpoints vs Dependency+Verifier: DSL design analysis, three-approach comparison, implementation sketch, recommendation for `[CHECKPOINT]` annotation
- **research-3.md** — Agent-Initiated vs Human-Predefined Checkpoints: full escalation chain (Tier 0–5), 9 additionalContext injection points, reactive vs proactive comparison matrix, hybrid recommendation
