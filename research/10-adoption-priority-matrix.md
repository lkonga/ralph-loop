---
type: research
id: 10
date: 2025-07-11
---
# Adoption Priority Matrix

> Date: 2025-07-11
> Purpose: Prioritized adoption recommendations for ralph-loop, organized by impact and effort

## Tier 1: High Impact, Low-Medium Effort

These patterns address the most significant gaps in ralph-loop and can be implemented within 1-2 tasks each.

### P1. Verification Feedback Injection
- **Source:** vercel-labs/ralph-loop-agent
- **Gap:** `verify.ts` runs checks but doesn't feed structured feedback back into the next prompt
- **Target:** `orchestrator.ts`, `prompt.ts`
- **Change:** When verification fails, inject failure reason as structured feedback in next Copilot prompt
- **Why #1:** Creates a closed-loop correction cycle — the single highest-impact improvement for loop convergence

### P2. Fix-Instruction Forwarding
- **Source:** giocaizzi/ralph-copilot
- **Gap:** On verify failure, ralph-loop logs the error but doesn't extract actionable fix instructions
- **Target:** `verify.ts`, `prompt.ts`
- **Change:** Parse test/lint/typecheck output to extract specific fix instructions, inject them as structured guidance
- **Why:** Transforms generic "test failed" signals into actionable "fix function X because assertion Y failed" guidance

### P3. Exit Reason Taxonomy
- **Source:** rubenmarcus/ralph-starter
- **Gap:** Loop stops are binary (completed vs circuit-broken) without granular categorization
- **Target:** `types.ts`, `orchestrator.ts`, `circuitBreaker.ts`
- **Change:** Add `exitReason` field with categories: `completed`, `budget_exceeded`, `max_iterations`, `stagnation`, `user_abort`, `error_rate`, `time_budget`, `repeated_error`
- **Why:** Essential for analytics and debugging — knowing WHY loops stop drives improvement

### P4. Iteration Log Injection
- **Source:** rubenmarcus/ralph-starter, giocaizzi/ralph-copilot
- **Gap:** Each iteration starts fresh without compact summaries of prior attempts
- **Target:** `prompt.ts`, `orchestrator.ts`
- **Change:** Maintain a compact log of previous iteration summaries (1-2 lines each), inject into prompt
- **Why:** Prevents the agent from repeating failed approaches across iterations

### P5. Git Log Injection
- **Source:** giocaizzi/ralph-copilot
- **Gap:** Agent lacks recent commit context
- **Target:** `prompt.ts`, `gitOps.ts`
- **Change:** Include `git log --oneline -5` in iteration prompts
- **Why:** Low-cost, high-value context that prevents the agent from conflicting with recent changes

---

## Tier 2: High Impact, Medium Effort

These patterns require more significant implementation but address important architectural gaps.

### P6. Context Budget Tracker
- **Source:** vercel-labs/ralph-loop-agent, humanlayer/advanced-context-engineering
- **Gap:** No token budget tracking or management
- **Target:** New `contextBudget.ts`, `orchestrator.ts`, `prompt.ts`
- **Change:** Track token usage with `Math.ceil(text.length / 3.5)`, implement LRU eviction for file context, auto-summarize old iterations at 70% capacity
- **Why:** Prevents context overflow in long sessions — the #1 failure mode for extended loops

### P7. Knowledge Harvest Phase
- **Source:** mj-meyer/choo-choo-ralph
- **Gap:** Knowledge accumulates during loop but isn't consolidated or deduplicated post-task
- **Target:** `knowledge.ts`, `orchestrator.ts`
- **Change:** Add post-task harvest phase that consolidates learnings, deduplicates, and prunes stale entries
- **Why:** Prevents knowledge bloat while preserving valuable discoveries

### P8. Workflow Presets
- **Source:** rubenmarcus/ralph-starter
- **Gap:** All tasks use the same configuration regardless of type
- **Target:** `types.ts`, `orchestrator.ts`
- **Change:** Named presets (feature, bugfix, refactor, migration) that configure iteration limits, verification strictness, and cost budgets
- **Why:** Different task types need different loop parameters — a bugfix needs tight limits, a migration needs more iterations

### P9. Loop Thrashing Detection
- **Source:** mikeyobrien/ralph-orchestrator
- **Gap:** `stagnationDetector.ts` detects stalls but not circular/thrashing behavior
- **Target:** `stagnationDetector.ts` or new `thrashingDetector.ts`
- **Change:** Track edit signatures across iterations. If the same file regions are being edited/reverted repeatedly, flag thrashing
- **Why:** Thrashing wastes iterations without triggering the stagnation detector (agent IS active, just not productive)

### P10. Disposable Plan Regeneration
- **Source:** ClaytonFarr/ralph-playbook
- **Gap:** When agent is stuck, it retries the same approach. No mechanism to regenerate the plan
- **Target:** `orchestrator.ts`, `circuitBreaker.ts`
- **Change:** When stagnation detector fires 3+ times on the same task, trigger plan regeneration instead of continued retries
- **Why:** Sometimes the plan is wrong. Regeneration cost is one planning loop — cheap vs going in circles

---

## Tier 3: Medium Impact, Low Effort

Quick wins that improve robustness and observability.

### P11. Inter-Task Cooldown
- **Source:** aymenfurter/ralph
- **Gap:** Tasks execute back-to-back with no review window
- **Target:** `orchestrator.ts`
- **Change:** Configurable pause (default 5s) between tasks for human review
- **Why:** Simple oversight mechanism, easy to implement

### P12. Filesystem Activity as Struggle Signal
- **Source:** aymenfurter/ralph
- **Gap:** Struggle detection uses 3 signals, missing filesystem activity
- **Target:** `struggleDetector.ts`
- **Change:** Monitor file system changes. 60s with no file changes during active execution = struggle signal
- **Why:** Adds a 4th independent signal to the struggle detector

### P13. Atomic State Updates
- **Source:** anthropics/claude-plugins-official
- **Gap:** Session persistence may not be crash-safe
- **Target:** `sessionPersistence.ts`
- **Change:** Write to `${file}.tmp.${pid}` then `rename()`. Atomic on all platforms
- **Why:** Prevents corrupted state files on crash/kill

### P14. Session Isolation
- **Source:** anthropics/claude-plugins-official
- **Gap:** No guard against cross-session interference
- **Target:** `sessionPersistence.ts`, `orchestrator.ts`
- **Change:** Tag sessions with unique ID, validate on state file read
- **Why:** Prevents interference when multiple VS Code windows reference the same workspace

### P15. PRD File Watcher
- **Source:** aymenfurter/ralph
- **Gap:** PRD completion detection relies on polling/parsing within the loop
- **Target:** `prd.ts`, `orchestrator.ts`
- **Change:** Use `vscode.workspace.createFileSystemWatcher` on PRD.md for instant checkbox change detection
- **Why:** Faster completion signal than polling, enables external PRD edits to be detected

---

## Tier 4: Medium Impact, Medium-High Effort

Valuable but requires more significant architecture work.

### P16. Cost/Token Tracking with Budget Enforcement
- **Source:** rubenmarcus/ralph-starter
- **Gap:** No cost tracking or budget limits
- **Target:** New `costTracker.ts`, `types.ts`, `orchestrator.ts`
- **Change:** Track token usage per iteration, estimate costs based on model pricing, enforce configurable budget limits, display pre-loop cost estimates
- **Why:** Prevents runaway spending in long sessions

### P17. Hookify Rule Engine
- **Source:** anthropics/claude-plugins-official
- **Gap:** Verification logic is hardcoded
- **Target:** `hookBridge.ts`
- **Change:** Support user-defined rules with event/pattern/action/conditions. Rules loaded from config files
- **Why:** Makes verification configurable without code changes

### P18. Separate Review Context
- **Source:** giocaizzi/ralph-copilot
- **Gap:** Review/verification uses the same context as implementation
- **Target:** `verify.ts`, `prompt.ts`
- **Change:** Dedicated reviewer prompt with read-only constraints and different context window
- **Why:** Independent review with fresh perspective catches issues the implementer's context would miss

### P19. Backpressure Classification
- **Source:** ClaytonFarr/ralph-playbook
- **Gap:** `struggleDetector.ts` doesn't distinguish productive backpressure from stagnation
- **Target:** `struggleDetector.ts`
- **Change:** Classify backpressure: agent actively fixing test failures = productive (don't interrupt), agent repeating same fix = stagnation (intervene)
- **Why:** Prevents premature intervention when agent is productively fixing issues

### P20. "Don't Assume Not Implemented" Gate
- **Source:** ClaytonFarr/ralph-playbook
- **Gap:** No pre-implementation search for existing implementations
- **Target:** `prompt.ts`, `orchestrator.ts`
- **Change:** Add mandatory prompt instruction: "Before implementing, search the codebase to confirm it doesn't already exist"
- **Why:** Prevents ralph's "Achilles' heel" — duplicating existing functionality

---

## Tier 5: Lower Priority / Future Consideration

### P21. JSON-Lines Structured Logging (vinitm/ralph-loop)
### P22. Token-Efficient Output Suppression (smart-ralph)
### P23. Event-Driven Hat System (ralph-orchestrator)
### P24. Rate Limiter (vinitm/ralph-loop)
### P25. Anthropic Prompt Caching (vercel-labs)

---

## Mapping to Existing Modules

| Module | Patterns to Adopt |
|---|---|
| `orchestrator.ts` | P1, P3, P4, P8, P9, P10, P11, P14, P15 |
| `verify.ts` | P1, P2, P18 |
| `prompt.ts` | P1, P2, P4, P5, P6, P20 |
| `types.ts` | P3, P8, P16 |
| `stagnationDetector.ts` | P9, P12, P19 |
| `circuitBreaker.ts` | P3, P10 |
| `knowledge.ts` | P7 |
| `sessionPersistence.ts` | P13, P14 |
| `hookBridge.ts` | P17 |
| `gitOps.ts` | P5 |
| `prd.ts` | P15 |
| New: `contextBudget.ts` | P6 |
| New: `costTracker.ts` | P16 |
