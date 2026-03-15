# Detailed Source Analysis: Per-Repository Findings

> Date: 2025-07-11
> Purpose: Detailed per-repository patterns with implementation specifics

---

## 1. aymenfurter/ralph

**Architecture:** TypeScript VS Code extension, PRD-driven loop

**Key Patterns:**
- **PRD FileSystemWatcher:** Uses `vscode.workspace.createFileSystemWatcher` on PRD.md for instant completion detection. Fires on external edits too.
- **Inter-Task Cooldown:** 5-second configurable pause between tasks. Simple `setTimeout` with user-configurable duration in settings.
- **Filesystem Activity Signal:** Monitors file changes during execution. 60 seconds of no file changes while the loop is active = struggle signal.

**Implementation Notes:**
- FileSystemWatcher is straightforward VS Code API. Low effort to adopt.
- Cooldown is a single `await delay(config.cooldownMs)` in the task loop.

---

## 2. giocaizzi/ralph-copilot

**Architecture:** Python-based, focused on Copilot integration

**Key Patterns:**
- **Fix-Instruction Forwarding:** Parses test output to extract failure details. Constructs specific fix instructions like "Test `test_calculate_tax` failed: expected 0.08, got 0.05. The tax rate constant on line 42 needs updating." Injected into next prompt.
- **Separate Review Context:** Reviewer uses a different prompt template with read-only constraints. Cannot see implementation details, only the diff and test results.
- **Notes for Next Iteration:** Agent writes structured notes at end of each iteration: what was attempted, what succeeded, what to try next. Stored in a field and injected into next iteration's prompt.
- **Git Log Injection:** `git log --oneline -5` output appended to prompt. ~300 bytes of context for high-value recent history.

**Implementation Notes:**
- Fix-instruction extraction requires parsing test framework output (vitest, jest, pytest). Pattern matching on error messages.
- Notes are a simple string field accumulated across iterations.

---

## 3. vinitm/ralph-loop

**Architecture:** TypeScript, VS Code extension fork

**Key Patterns:**
- **Sliding Window Rate Limiter:** Tracks API calls in a time window. Delays requests when approaching limit. `class RateLimiter { private timestamps: number[]; private windowMs: number; private maxRequests: number; }`.
- **JSON-Lines Structured Logging:** Each event emitted as a single JSON line: `{"timestamp":"...","event":"iteration_start","data":{...}}`. Enables machine parsing for analytics.

**Implementation Notes:**
- Rate limiter is a standalone class. ~50 lines.
- JSONL logging requires wrapping existing event emissions.

---

## 4. mikeyobrien/ralph-orchestrator

**Architecture:** Rust, multi-backend (7 AI providers)

**Key Patterns:**
- **Event-Driven Hat System:** Specialized agent personas activated via EventBus. "Architect hat" for planning, "coder hat" for implementation, "reviewer hat" for verification. Each hat has different prompt templates and tool access.
- **Loop Thrashing Detection:** Tracks edit signatures (file + region hash) across iterations. If the same regions are being edited/reverted 3+ times, flags thrashing. Distinguishes from stagnation because the agent IS active.
- **Multi-Strategy Backends:** Supports 7 AI providers with unified interface. Strategy pattern for provider selection.

**Implementation Notes:**
- Thrashing detection tracks `Map<string, number>` of edit region hashes. When any hash exceeds threshold, fires.
- Hat system is a larger architecture change — consider as future Phase 10+.

---

## 5. mj-meyer/choo-choo-ralph

**Architecture:** TypeScript, 5-phase workflow

**Key Patterns:**
- **5-Phase Workflow:** Plan → Spec → Pour → Ralph → Harvest. The "Pour" phase is context injection, "Harvest" is post-task knowledge extraction.
- **Knowledge Harvest with Dedup:** After task completion, scans all outputs for learnings. Deduplicates against existing knowledge base using keyword similarity. Prunes entries older than N iterations without re-use.
- **Per-Project Workflow Templates:** Different project types get different phase configurations. A web project might skip "Spec" but add "Test" phase.
- **Parallel Instance Safety:** Mutex-based locking when multiple loop instances operate on the same workspace. State file includes PID for lock validation.

**Implementation Notes:**
- Harvest phase is a dedicated pass over iteration outputs — ~100 lines.
- Dedup uses Jaccard similarity on keyword sets — simple and effective.

---

## 6. tzachbon/smart-ralph

**Architecture:** TypeScript, spec-driven

**Key Patterns:**
- **Epic Triage Decomposition:** Large tasks auto-decomposed into sub-tasks via LLM analysis. Each sub-task gets its own spec and acceptance criteria.
- **Spec-Driven Phases:** Every implementation phase starts from a spec. Specs are committed alongside code.
- **Token-Efficient Output Suppression:** Prompt includes: "Do not use emphatic language. Do not repeat the task description. Do not explain what you're about to do." Reduces agent verbosity by ~30%.

**Implementation Notes:**
- Output suppression is 3 prompt lines. Zero implementation effort.
- Epic triage is already partially implemented in ralph-loop's strategy decomposition.

---

## 7. rubenmarcus/ralph-starter

**Architecture:** TypeScript, comprehensive configuration

**Key Patterns:**
- **19+ Workflow Presets:** Named configurations: `minimal`, `standard`, `thorough`, `feature`, `bugfix`, `refactor`, `migration`, `security-audit`, `performance`, etc. Each adjusts: max iterations, verification strictness, cost ceiling, context budget.
- **Cost Tracking:** `class CostTracker { private usage: { inputTokens: number; outputTokens: number; estimatedCost: number }[]; }`. Per-iteration tracking with model-specific pricing tables.
- **Budget Enforcement:** Pre-loop cost estimation. Mid-loop budget check. Hard stop when budget exceeded. `if (totalCost > config.maxBudget) { return { exitReason: 'budget_exceeded' }; }`.
- **Exit Reason Taxonomy:** `type ExitReason = 'completed' | 'max_iterations' | 'budget_exceeded' | 'stagnation' | 'user_abort' | 'error_rate' | 'time_budget' | 'repeated_error' | 'thrashing';`
- **Iteration Log Injection:** `const iterationSummary = iterations.map(i => \`[${i.num}] ${i.action} → ${i.result}\`).join('\n');` Injected into prompt.

**Implementation Notes:**
- Presets are a config map — ~200 lines for definitions, ~30 lines for application.
- Cost tracker is a standalone module — ~150 lines.
- Exit reason is a type change + return value modification.

---

## 8. agrimsingh/ralph-wiggum-cursor

**Architecture:** Bash scripts, cursor-focused

**Key Patterns:**
- **Two-Tier Token Thresholds:** WARN at 70K, ROTATE at 80K. Token counting via bytes read/written from stream parser.
- **Signal-Based Loop Control:** 5 signals: ROTATE (context full), GUTTER (stuck), COMPLETE (done), DEFER (rate limit), empty (natural end).
- **DEFER with Exponential Backoff:** `backoff_delay = base * 2^attempt`. On rate limit response, wait and retry.
- **File-Based State Persistence:** All state in `.ralph/` directory. Git commits as durable checkpoints.

---

## 9. vercel-labs/ralph-loop-agent

**Architecture:** TypeScript, AI SDK-based

**Key Patterns:**
- **verifyCompletion Callback:** `async ({ result, iteration, allResults, originalPrompt }) => { complete: boolean, reason?: string }`. Reason injected as `Feedback: ${reason}` user message.
- **Judge Agent:** Separate model (claude-opus-4.5) with read-only tools reviews work. Calls `approveTask` or `requestChanges`.
- **RalphContextManager:** Three budgets (context: 180K, files: 60K, changelog: 8K). LRU eviction. Auto-summarization at 70%.
- **Context-Aware Tool Wrappers:** `readFile`/`writeFile`/`editFile` automatically update context manager.
- **Multi-Dimensional Stop Conditions:** `iterationCountIs(N)`, `tokenCountIs(N)`, `costIs(maxDollars, model)`.
- **Abort/Resume:** `preserveContext: boolean`, `startIteration: number`. Context manager retains state on resume.
- **Anthropic Caching:** Auto-add `cacheControl: { type: 'ephemeral' }` for Anthropic models.

---

## 10. humanlayer/advanced-context-engineering

**Architecture:** Documentation + reference implementation

**Key Patterns:**
- **Frequent Intentional Compaction (FIC):** 40-60% context utilization target. Phase artifacts feed next phase.
- **Context Optimization Hierarchy:** Correctness > Completeness > Size > Trajectory.
- **Subagents for Context Control:** Fresh context windows for search tasks. Return compacted summaries.
- **High-Leverage Review Points:** Bad plan = hundreds of bad lines. Review research and plans, not code.

---

## 11. ClaytonFarr/ralph-playbook

**Architecture:** Documentation, methodology guide

**Key Patterns:**
- **Signs & Gates:** Upstream (deterministic setup, 5K token budget for specs) + downstream (tests/typechecks/lints as gates).
- **Backpressure Classification:** Productive (agent fixing tests = good) vs stagnation (same fix repeated = bad).
- **Acceptance-Driven Backpressure:** Specs → plan → tests. Behavioral outcomes, not implementation details.
- **Disposable Plans:** Wrong plan? Throw out and regenerate. Cost = one planning loop.
- **"Don't Assume Not Implemented":** Search codebase before implementing. Ralph's Achilles' heel.
- **Knowledge Garbage Collection:** Size budget on knowledge. Prune stale entries.
- **Automatic Sign Generation:** Failures → guardrails for future iterations.
- **LLM-as-Judge:** `createReview({ criteria, artifact })` → `{ pass, feedback }` for subjective criteria.

---

## 12. anthropics/claude-plugins-official (ralph-loop plugin)

**Architecture:** Bash hooks, YAML+Markdown state files

**Key Patterns:**
- **Stop Hook:** Intercepts exit, re-feeds prompt. `{"decision": "block", "reason": $prompt}`.
- **Completion Promise:** `<promise>` XML tags, exact string match. Single condition only.
- **Atomic State Update:** `tmp.$$ + mv`. Crash-safe.
- **Session Isolation:** `session_id` comparison. Only starting session can control loop.
- **Hookify Rule Engine:** Config-driven rules with event/pattern/action/conditions.
- **Hook Event Lifecycle:** SessionStart, PreToolUse, PostToolUse, Stop, UserPromptSubmit, PreCompact, Notification.
