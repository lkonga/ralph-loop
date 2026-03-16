# Research Report: Verification & Completion Patterns Across the Ralph Ecosystem

> **Wave ID:** 2026-03-16-ralph-verification-patterns
> **Report:** 3
> **Date:** 2026-03-16
> **Question:** How do competing forks (ralph-wiggum, ralph-starter, ralph-playbook, ralph-orchestrator, choo-choo-ralph) implement task gates, signs-and-gates, judge agents, and feedback injection differently?
> **Sources:** 13 repositories analyzed via `research/09-ecosystem-patterns-synthesis.md`, `research/07-ralph-wiggum-playbook.md`, `research/07-ralph-starter-architecture.md`, `research/08-ralph-orchestrator-analysis.md`, `research/07-ralph-playbook-analysis.md`, `research/12-detailed-source-analysis.md`, `research/10-adoption-priority-matrix.md`

---

## Findings

### 1. Verification Feedback Injection (vercel-labs/ralph-loop-agent)

The vercel-labs fork implements a closed-loop correction cycle. After each iteration, a `verifyCompletion({ result, iteration })` callback is called that returns `{ complete: boolean, reason?: string }`. When verification fails, `reason` is injected as structured feedback into the next prompt (as a `Feedback: ${reason}` user message), creating a self-correcting loop. This is identified as the **#1 highest-impact improvement** in the adoption priority matrix (P1) because it transforms a one-shot attempt into an iterative convergence process.

### 2. Judge Agent (vercel-labs/ralph-loop-agent)

A dedicated **separate model** (claude-opus-4.5) with **read-only tools** reviews work when the coding agent calls `markComplete`. The judge either calls `approveTask` or `requestChanges({ issues, suggestions })`. Rejection feedback flows back to the coding agent. This two-agent separation enforces objectivity — the implementer cannot rubber-stamp its own work.

### 3. Signs & Gates (ClaytonFarr/ralph-playbook)

The ralph-playbook defines a bidirectional steering methodology:

- **Signs (Upstream/Deterministic):** Discoverable guidance that steers the agent — prompt guardrails, AGENTS.md operational learnings, code patterns in `src/lib/`, and specs. Signs are **reactive, not proactive**: start with minimal signs, observe failures, add signs when Ralph fails in specific repeatable ways. "Tune it like a guitar."
- **Gates (Downstream/Backpressure):** Tests, typechecks, lints, and builds that **reject invalid work** with binary pass/fail. The prompt says "run tests" generically; AGENTS.md specifies project-specific commands.

Key insight: **Automatic sign generation** — when the agent fails a specific way, automatically add a guardrail to prevent that failure pattern in future iterations. Failures become knowledge entries that steer future loops.

### 4. Backpressure Classification (ralph-playbook)

The playbook distinguishes two types of backpressure:
- **Productive backpressure:** Agent fixing test failures = good. Inner loop: attempt → validate → fix → validate.
- **Stagnation:** Agent repeating the same fix = bad. This distinction is critical for knowing when to intervene vs. let the loop self-correct.

### 5. Acceptance-Driven Backpressure (ralph-playbook)

Three-tier separation:
1. **Acceptance criteria** (in specs) = Behavioral outcomes, not implementation details ("Extracts 5-10 dominant colors from any uploaded image")
2. **Test requirements** (in plan) = Verification points derived from criteria
3. **Implementation approach** = Up to Ralph, not prescribed

Non-deterministic criteria (UX, aesthetics) use **LLM-as-Judge** with binary pass/fail: `createReview({ criteria, artifact })` → `{ pass, feedback }`. The loop provides eventual consistency.

### 6. Checkbox Audit (agrimsingh/ralph-wiggum-cursor)

Cross-references the agent's completion claim against actual PRD criteria using `grep -cE '^[[:space:]]*([-*]|[0-9]+\.)[[:space:]]+\[x\]'`. If unchecked criteria remain, the loop continues **regardless of the agent's claim**. This is a simple, deterministic verification that doesn't require LLM judgment.

### 7. Completion Promise System (anthropics/claude-plugins-official)

Uses exact string matching with `<promise>` XML tags. Single completion condition only. Anti-lying safeguards with strongly-worded warnings. Deliberately minimal — no fuzzy scoring, no multi-criteria evaluation.

### 8. Multi-Signal Completion Detection (rubenmarcus/ralph-starter)

A single-pass `detectCompletionWithReason()` checks **four signal categories**:
- **File markers:** `RALPH_COMPLETE`, `.ralph-done`
- **Output markers:** `<TASK_DONE>`, `<TASK_COMPLETE>`, `TASK COMPLETED`
- **Plan markers:** All `[x]` checked in IMPLEMENTATION_PLAN.md
- **Blocked markers:** `<TASK_BLOCKED>`, `Cannot proceed`

### 9. Backpressure Verification Gate (ralph-orchestrator)

Before accepting task completion, requires **concrete evidence**: at least one file modified (git diff non-empty), test files modified if task mentions "test", progress.txt updated. Completion without evidence is rejected with: "Task completion rejected — missing evidence: {missing items}."

### 10. Fix-Instruction Forwarding (giocaizzi/ralph-copilot)

Parses test output to extract **specific** fix instructions like "Test `test_calculate_tax` failed: expected 0.08, got 0.05. The tax rate constant on line 42 needs updating." This transforms generic "test failed" signals into actionable guidance.

### 11. Loop Thrashing Detection (ralph-orchestrator)

Beyond stagnation (no activity), detects **circular behavior** via event signatures. When the same error patterns or edit regions repeat 3+ times, flags thrashing — the agent IS active, just not productive. Distinguished from stagnation because file changes ARE happening but are being reverted.

### 12. Knowledge Harvest Phase (mj-meyer/choo-choo-ralph)

Post-task knowledge consolidation with dedup. The 5-phase workflow (Plan → Spec → Pour → Ralph → Harvest) dedicates an entire phase to extracting learnings. Uses Jaccard similarity on keyword sets for deduplication. Prunes entries older than N iterations without re-use.

---

## Patterns

### Pattern A: Verification Sophistication Spectrum

Forks arrange along a spectrum from simple to complex verification:

| Level | Fork | Mechanism | Complexity |
|-------|------|-----------|------------|
| 1 | anthropics official | Exact string match (`<promise>` tags) | Minimal |
| 2 | ralph-wiggum | Checkbox grep count | Low |
| 3 | ralph-starter | Multi-signal detection (4 categories) | Medium |
| 4 | ralph-orchestrator | Evidence-based backpressure gate | Medium-High |
| 5 | vercel-labs | Judge agent + feedback injection | High |
| 6 | ralph-playbook | LLM-as-Judge + acceptance-driven backpressure | Highest |

**Trend:** Simpler mechanisms (levels 1-3) are deterministic and cheap but can be gamed. Complex mechanisms (4-6) are robust but add latency and cost.

### Pattern B: Two Flavors of Feedback Loops

1. **Structured feedback injection** (vercel-labs, giocaizzi): Failure reasons are parsed and injected as additional prompt context. The agent receives specific guidance on what went wrong.
2. **Binary gate rejection** (ralph-orchestrator, anthropics, ralph-wiggum): Work is simply rejected, and the agent must figure out what went wrong from the original task context. Less helpful but simpler to implement.

### Pattern C: Separation of Concerns in Verification

| Concern | Who Handles It | Examples |
|---------|---------------|----------|
| Deterministic checks | Tooling (tests, lints, types) | All forks |
| Completion claims | Separate judge/auditor | vercel-labs (judge agent), ralph-wiggum (checkbox audit) |
| Subjective quality | LLM-as-Judge | ralph-playbook |
| Evidence of work | Git diff analysis | ralph-orchestrator |

### Pattern D: Guardrail Hierarchy (Priority Numbering)

The ralph-playbook introduces an **escalating 9s numbering convention** for prompt guardrails:
- `99999` = important (documentation)
- `999999999` = critical (keep plan current)
- `999999999999999` = absolute (AGENTS.md must stay operational only)

Higher numbers = higher criticality. This replaces ambiguous "important" labels with a parseable priority ordering.

### Pattern E: Anti-Stagnation vs Anti-Thrashing

| Failure Mode | Detection | Forks |
|--------------|-----------|-------|
| **Stagnation** — No file changes | File change monitoring (60s timeout) | aymenfurter/ralph, ralph-starter |
| **Thrashing** — Same edits repeated | Edit signature dedup across iterations | ralph-orchestrator |
| **Circular** — Same event loop | Event signature matching 3x | ralph-orchestrator |
| **Invalid output** — Apologies/refusals | Output content validation | ralph-orchestrator |

---

## Applicability

### For ralph-loop (VS Code Extension)

**Highest-priority adoptions** (from adoption priority matrix):

1. **P1 — Verification Feedback Injection** (vercel-labs): ralph-loop's `verify.ts` runs checks but doesn't feed structured feedback back into the next prompt. Adding `reason` injection to `prompt.ts` is the single highest-impact change for loop convergence.

2. **P2 — Fix-Instruction Forwarding** (giocaizzi): Parsing vitest/tsc output to extract specific fix instructions (not just "tests failed" but "test X failed because Y") transforms generic signals into actionable guidance. Target: `verify.ts` → `prompt.ts`.

3. **P9 — Loop Thrashing Detection** (ralph-orchestrator): ralph-loop's `stagnationDetector.ts` detects stalls but not circular/thrashing behavior. Tracking edit signatures across iterations catches the case where the agent IS active but not productive.

4. **Backpressure Verification Gate** (ralph-orchestrator): Before accepting completion, require evidence (git diff non-empty, test files modified if task mentions "test"). Maps to ralph-loop's `verify.ts`.

**Lower-priority but valuable:**

5. **Signs & Gates as a Design Philosophy** (ralph-playbook): Not a code pattern but a tuning methodology. Start with minimal guardrails, observe failures, add signs reactively. Applicable to how ralph-loop users configure their AGENTS.md.

6. **Judge Agent** (vercel-labs): High impact but high complexity. Would require dispatching a separate verification prompt to Copilot with read-only constraints. Consider as a future enhancement.

### Translation Challenges for VS Code Context

| CLI Pattern | VS Code Challenge |
|-------------|-------------------|
| Judge agent as separate process | Must use same Copilot session or spawn separate chat |
| File-based state between iterations | Works identically — file-based state is universal |
| Checkbox grep for completion | Works identically — grep on PRD.md |
| Feedback injection into stdin | Must construct as part of Copilot prompt template |
| LLM-as-Judge with binary pass/fail | Requires additional LM API call, cost implications |
| Context clearing (process exit) | Must simulate via prompt construction — no true context reset |

---

## Open Questions

1. **Cost of Judge Agent:** The vercel-labs judge uses claude-opus-4.5 (expensive model). In a VS Code extension context, what's the acceptable cost overhead for a verification pass? Should users opt-in?

2. **Feedback Injection Format:** When injecting verification failure reasons into the next prompt, what format works best with Copilot Agent Mode? XML tags, markdown sections, or inline text?

3. **Thrashing vs. Productive Iteration:** The ralph-playbook distinguishes "productive backpressure" (agent fixing tests = good) from "stagnation" (repeating same fix = bad). How many identical edit signatures should trigger thrashing detection before false-positive risk becomes unacceptable? ralph-orchestrator uses 3, but is that right for VS Code's longer iteration cycles?

4. **Deterministic vs. LLM-Based Verification:** Should ralph-loop default to deterministic gates (checkbox audit, test pass/fail) and only offer LLM-as-Judge as an opt-in for subjective criteria? The anthropics official approach of "simple and strict" suggests so.

5. **Automatic Sign Generation Loop:** The ralph-playbook suggests failures should automatically generate guardrails for future iterations. How does this interact with AGENTS.md size limits? When does the knowledge garbage collector run?

6. **Multi-Signal Completion Priority:** When completion signals conflict (e.g., agent output says TASK_COMPLETE but checkboxes remain unchecked), which signal wins? ralph-wiggum says checkboxes always win; ralph-starter checks all signals with no defined priority.

7. **Evidence Granularity:** The ralph-orchestrator backpressure gate requires "at least one file modified." Is this sufficient, or should evidence requirements be task-type-aware (e.g., implementation tasks require code + test file changes)?
