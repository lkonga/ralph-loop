---
type: research
id: 9
date: 2025-07-11
sources:
  - 13 repositories analyzed across the ralph ecosystem
---
# Ecosystem Patterns Synthesis

> Date: 2025-07-11
> Sources: 13 repositories analyzed across the ralph ecosystem
> Purpose: Consolidated findings organized by pattern category

## Sources Analyzed

| # | Repository | Key Focus |
|---|---|---|
| 1 | aymenfurter/ralph | PRD watcher, cooldown, filesystem struggle |
| 2 | giocaizzi/ralph-copilot | Fix forwarding, review context, git log injection |
| 3 | vinitm/ralph-loop | Rate limiter, JSON-lines logging |
| 4 | hehamalainen/Ralph | Baseline implementation |
| 5 | mikeyobrien/ralph-orchestrator | Event-driven hats, multi-backend, thrashing detection |
| 6 | mj-meyer/choo-choo-ralph | 5-phase workflow, knowledge harvest, parallel safety |
| 7 | tzachbon/smart-ralph | Epic triage, spec-driven phases, token-efficient output |
| 8 | rubenmarcus/ralph-starter | Workflow presets, cost tracking, exit reason taxonomy |
| 9 | agrimsingh/ralph-wiggum-cursor | Two-tier token thresholds, signal-based control |
| 10 | vercel-labs/ralph-loop-agent | Context manager, judge agent, feedback injection |
| 11 | humanlayer/advanced-context-engineering | FIC, context hierarchy, subagent patterns |
| 12 | ClaytonFarr/ralph-playbook | Signs & gates, backpressure, disposable plans |
| 13 | anthropics/claude-plugins-official | Stop hook, promise system, hookify rules |

---

## Category 1: Context Management

### 1.1 Budget-Aware Context Manager (vercel-labs)

Track three budgets: `maxContextTokens` (180K), `fileContextBudget` (60K), `changeLogBudget` (8K). Token estimation: `Math.ceil(text.length / 3.5)`. LRU-evict tracked files when budget exceeded. Auto-summarize older iterations at 70% capacity, keeping only last N iterations in full detail.

### 1.2 Frequent Intentional Compaction (humanlayer)

Design workflow around 40-60% context utilization. Split into Research → Plan → Implement phases. Each phase produces a compacted markdown artifact that feeds the next, discarding tool call noise. Track context utilization percentage and trigger compaction at 60%.

### 1.3 Context Optimization Hierarchy (humanlayer)

Priority order: Correctness > Completeness > Size > Trajectory. Never trim correctness-critical info. Noise is trimmable. The worst context problem is incorrect info, not too much info.

### 1.4 Two-Tier Token Thresholds (ralph-wiggum-cursor)

WARN at 70K tokens, ROTATE at 80K tokens. At WARN, agent gets wrapup message. At ROTATE, context is forcibly rotated to fresh session. Simple signal-based approach: `WARN`, `ROTATE`, `COMPLETE`, `GUTTER`, `DEFER`.

### 1.5 Fresh Context Per Iteration (ralph-playbook)

200K+ advertised = ~176K usable. At 40-60% "smart zone" utilization, tight tasks + 1 task per loop = 100% smart zone usage. Each iteration clears context; disk files persist state between isolated loop executions.

### 1.6 Context-Aware Tool Wrappers (vercel-labs)

Wrap `readFile`, `writeFile`, `editFile` to automatically track file operations in the context manager. Reads update LRU cache; writes update change log with truncated diffs.

---

## Category 2: Verification & Completion

### 2.1 Verification Feedback Injection (vercel-labs)

After each iteration, `verifyCompletion({ result, iteration })` is called. Returns `{ complete: boolean, reason?: string }`. On failure, `reason` is injected as feedback into the next prompt, creating a closed-loop correction cycle.

### 2.2 Judge Agent (vercel-labs)

When coding agent calls `markComplete`, a separate Judge Agent reviews using read-only tools. Returns `approveTask` or `requestChanges({ issues, suggestions })`. Rejection feedback flows back to coding agent.

### 2.3 Completion Promise System (anthropics official)

Exact string matching with `<promise>` XML tags. Single completion condition only. Anti-lying safeguards with strongly-worded warnings. Simple and strict — no fuzzy scoring.

### 2.4 Checkbox Audit (ralph-wiggum-cursor)

Cross-reference agent's completion claim against actual PRD criteria. Count markdown checkboxes: `grep -cE '^[[:space:]]*([-*]|[0-9]+\.)[[:space:]]+\[x\]'`. If unchecked criteria remain, loop continues regardless of agent's claim.

### 2.5 LLM-as-Judge for Subjective Criteria (ralph-playbook)

For non-deterministic criteria (UX, aesthetics), use LLM-as-Judge with binary pass/fail. `createReview({ criteria, artifact })` returns `{ pass: boolean, feedback?: string }`. Loop provides eventual consistency.

### 2.6 Acceptance-Driven Backpressure (ralph-playbook)

Three-phase connection: specs → plan → tests. Define acceptance criteria as behavioral outcomes (not implementation details). Derive test requirements from acceptance criteria during planning. Tests verify WHAT works, not HOW.

---

## Category 3: Loop Control & Safety

### 3.1 Multi-Dimensional Stop Conditions (vercel-labs)

Beyond iteration count: `iterationCountIs(N)`, `tokenCountIs(N)`, `costIs(maxDollars, model)`. Track `totalUsage` across iterations. Multiple conditions can be combined.

### 3.2 DEFER with Exponential Backoff (ralph-wiggum-cursor)

On rate limit: `backoff_delay = base * 2^attempt`. Missing from most implementations. Circuit breaker handles errors but not transient rate-limit retries with calculated backoff.

### 3.3 Inter-Task Cooldown (aymenfurter/ralph)

Configurable 5s pause between tasks for human review window. Simple but effective for maintaining oversight.

### 3.4 Loop Thrashing Detection (ralph-orchestrator)

Detect circular behavior via event signatures. When the same error patterns repeat across iterations, flag thrashing instead of continuing retries.

### 3.5 Session Isolation (anthropics official)

Compare `session_id` from state file vs hook input. Only the session that started the loop can control it. Prevents cross-session interference.

### 3.6 Atomic State Updates (anthropics official)

Write to `${FILE}.tmp.$$` then `mv`. Portable, crash-safe. Critical for session persistence reliability.

---

## Category 4: Knowledge & Learning

### 4.1 Knowledge Harvest Phase (choo-choo-ralph)

Post-loop knowledge consolidation with dedup. 5-phase workflow: Plan → Spec → Pour → Ralph → Harvest. The harvest phase extracts and deduplicates learnings.

### 4.2 Fix-Instruction Forwarding (giocaizzi/ralph-copilot)

On verify failure, extract specific fix instructions and inject into next prompt. Not just "tests failed" but "test X failed because Y — fix by Z."

### 4.3 Notes for Next Iteration (giocaizzi/ralph-copilot)

Structured context handoff between iterations. Agent writes explicit notes about what was tried, what worked, what to try next.

### 4.4 Git Log Injection (giocaizzi/ralph-copilot)

Include `git log --oneline -5` in each iteration prompt. Gives agent recent commit context without consuming much token budget.

### 4.5 Iteration Log Injection (ralph-starter)

Previous iteration summaries in prompts. Compact one-line summaries of what each prior iteration attempted and achieved.

### 4.6 Knowledge Garbage Collection (ralph-playbook)

Enforce size budget on knowledge entries. Prune stale/resolved entries between iterations. `AGENTS.md` must stay operational only — status updates pollute every future loop.

### 4.7 Automatic Sign Generation (ralph-playbook)

When agent fails a specific way, automatically add a guardrail to prevent that failure pattern in future iterations. Struggles → knowledge entries that steer future iterations.

---

## Category 5: Workflow & Configuration

### 5.1 Workflow Presets (ralph-starter)

Named presets (feature, bugfix, refactor, migration) configuring thresholds. 19+ built-in presets. Each preset adjusts iteration limits, verification strictness, and cost budgets.

### 5.2 Cost/Token Tracking (ralph-starter)

Token estimation, budget enforcement, pre-loop cost display. Pre-loop cost estimation before starting. Track actual vs estimated cost.

### 5.3 Exit Reason Taxonomy (ralph-starter)

Track WHY loop stopped with categorized reasons. Not just "stopped" but "stopped:budget_exceeded", "stopped:max_iterations", "stopped:stagnation", "stopped:user_abort", "stopped:completed".

### 5.4 Hookify Rule Engine (anthropics official)

Generic rule engine loading config files. Each rule has: event type, pattern, action (warn/block), conditions. Users define rules for configurable pre/post-loop checks.

### 5.5 Per-Project Workflow Templates (choo-choo-ralph)

Different projects get different workflow configurations. Parallel instance safety when running multiple loops.

### 5.6 Disposable Plans with Regeneration (ralph-playbook)

If plan is wrong, throw it out and regenerate. Regeneration cost is one planning loop — cheap vs going in circles. Trigger on: off track, stale plan, too much clutter, spec changes.

---

## Category 6: Prompt Engineering

### 6.1 Token-Efficient Output Suppression (smart-ralph)

Remove emphatic language, suppress banned output patterns. Reduce token waste on verbose agent responses.

### 6.2 Separate Review Context (giocaizzi/ralph-copilot)

Dedicated reviewer prompt with read-only constraints. Reviewer sees different context than implementer.

### 6.3 Signs & Gates (ralph-playbook)

Upstream (signs): Deterministic setup — allocate first ~5K tokens for specs. Downstream (gates): Tests, typechecks, lints, builds reject invalid work.

### 6.4 "Don't Assume Not Implemented" (ralph-playbook)

Before implementing anything, search codebase first to confirm it doesn't already exist. Ralph's "Achilles' heel" — duplicating existing functionality.

### 6.5 Priority Numbering for Guardrails (ralph-playbook)

Escalating 9s: `99999` (important) → `999999999` (critical) → `999999999999` (absolute). Higher numbers = more critical invariants.

### 6.6 Anthropic Prompt Caching (vercel-labs)

Auto-add `cacheControl: { type: 'ephemeral' }` to last message for Anthropic models. Low-effort cost reduction on repeated system prompts.

---

## Category 7: Architecture

### 7.1 Event-Driven Hat System (ralph-orchestrator)

Specialized agent personas via EventBus. Different "hats" (roles) activated by events. Decoupled architecture.

### 7.2 PRD File Watcher (aymenfurter/ralph)

`FileSystemWatcher` on PRD.md as fast completion signal. Instant detection of task checkbox changes.

### 7.3 Filesystem Activity as Struggle Signal (aymenfurter/ralph)

60s no-file-change detection as 4th struggle signal alongside existing signals.

### 7.4 Rate Limiter (vinitm/ralph-loop)

Sliding window rate limiting for API calls. Prevents hitting provider rate limits.

### 7.5 Stop Hook Architecture (anthropics official)

State file + stop hook + transcript parsing. `block`/`approve` JSON protocol. Session isolation. The official approach is deliberately minimal.

### 7.6 Backpressure as Self-Correction (ralph-playbook)

Distinguish productive backpressure (agent fixing test failures = good) from stagnation (repeating same fix = bad). Inner loop: attempt → validate → fix → validate.

### 7.7 Subagents for Context Control (humanlayer)

Subagents are about context control, not role-playing. Fresh context windows for search/summarize tasks. Return compacted summaries, not raw data.

### 7.8 JSON-Lines Structured Logging (vinitm/ralph-loop)

Machine-parseable event logging for analysis and debugging.
