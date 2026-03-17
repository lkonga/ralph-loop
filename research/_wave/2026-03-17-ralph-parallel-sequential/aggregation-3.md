# Aggregation Report 3

## Source Reports

### research-7.md — Sequential Mode Dependency Enforcement
Traces `pickNextTask` vs `pickReadyTasks` — the two task-selection functions with fundamentally different dependency awareness. Shows that sequential mode (the default) uses `pickNextTask` which completely ignores `dependsOn` annotations. Dependency enforcement only occurs in the parallel path when 2+ tasks are DAG-ready. Concrete scenarios demonstrate when file-order execution accidentally works vs when it breaks. [source: research-7.md#L1-L5]

### research-8.md — Sequential Happy Path End-to-End
Maps the complete 10-step sequential execution flow: PRD Parse → Task Pick → Pre-flight Gates → Prompt Build → Execute via Strategy → Nudge Loop → Dual Exit Gate → Mark Complete → Post-Completion Gates → Next Task Transition. Identifies layered verification (dual gate → diff validation → confidence scoring → hooks → review) and several gaps including hardcoded vitest/tsc checks and `--no-verify` on git commits. [source: research-8.md#L1-L5]

### research-9.md — Parallel→Sequential Fallback
Analyzes the three-way branch when parallel mode is active: `readyTasks=0` (fallback to `pickNextTask`), `readyTasks=1` (falls through to `pickNextTask` — potentially picking the wrong task), `readyTasks>1` (true parallel execution). Concludes the fallback is an intentional safety net ("progress over correctness") but identifies it as a design smell that silently degrades DAG-awareness without logging. [source: research-9.md#L1-L5]

---

## Deduplicated Findings

### F1: `pickNextTask` Is Completely Dependency-Unaware
`pickNextTask(snapshot)` at `prd.ts:103` returns the first task with `status === Pending` — no dependency checking whatsoever. This function is used for: (a) the entire sequential mode, (b) the parallel mode fallback when `readyTasks` is empty, and (c) the `readyTasks.length === 1` fall-through. Dependencies parsed via `parseDependsOn` and indentation inference are stored but never consulted by this function. [source: research-7.md#L8-L14] [source: research-9.md#L14-L22]

### F2: Sequential Mode Works Correctly Only When File Order Matches Dependency Order
The sequential happy path succeeds **by accident** — file-order execution is correct when the PRD lists tasks in topological order (dependencies before dependents). Out-of-order `depends:` annotations silently violate the declared dependency contract. Most users write PRDs in natural top-to-bottom order, so this works in practice. [source: research-7.md#L46-L84]

### F3: The Complete Sequential Flow Has 10 Discrete Steps with Layered Verification
The happy path traverses: Loop Entry → PRD Parse → Task Pick → Pre-flight (Checkpoint + Bearings) → Prompt Build → Strategy Execute → Nudge Loop → Dual Exit Gate → Mark Complete (with 5+ sub-gates) → Next Task Transition. Completion goes through dual exit gate, diff validation, confidence scoring, pre-complete hooks, and optional review — each of which can force task re-entry. [source: research-8.md#L13-L122]

### F4: Agent-Driven Completion Is the Primary Mechanism
The normal sequential path relies on the **agent** to mark the PRD checkbox. Ralph monitors via `FileSystemWatcher` and `verifyTaskCompletion()`. `markTaskComplete()` in `prd.ts` is only called directly for checkpoint tasks, not for normal task completion. If the agent fails to mark the checkbox but produces real changes, the dual gate rejects repeatedly. [source: research-8.md#L65-L78] [source: research-8.md#L131-L133]

### F5: Parallel→Sequential Fallback Is Intentional but Silently Violates DAG
When `pickReadyTasks` returns empty (all pending tasks have unmet deps), the parallel path falls back to `pickNextTask`, which ignores dependencies. An explicit comment (`// Fall through to single-task execution below`) confirms the author considered this path. This is a deliberate "progress over correctness" tradeoff — prevents deadlock when dependency annotations are wrong — but no event, log, or warning is emitted when it triggers. [source: research-9.md#L46-L62] [source: research-7.md#L86-L98]

### F6: The `readyTasks.length === 1` Path Has a Distinct Bug
When exactly one task is DAG-ready, the code falls through to `pickNextTask(snapshot)` at L598, which picks the **first pending task** regardless of dependencies. If a dependency-blocked task appears earlier in the file, it gets picked instead of the single DAG-ready task. This is separate from the empty-fallback issue — it's a task-identity mismatch. [source: research-9.md#L40-L47]

### F7: Confidence Scoring Vitest/TSC Checks Are Hardcoded to Pass
The confidence scoring step (orchestrator.ts L940–942) includes vitest and tsc as weighted signals, but they are **hardcoded to `VerifyResult.Pass`** rather than actually executing the tools. The only real bearings check (tsc + vitest) happens in the pre-flight gate, not in the post-completion verification. This makes confidence scoring partially decorative. [source: research-8.md#L127-L129]

### F8: No Test Coverage for Dependency Enforcement or Fallback Paths
Neither `pickNextTask` with dependency scenarios, nor `pickReadyTasks`, nor the parallel fallback path, nor the `readyTasks.length === 1` case have test coverage. `prd.test.ts` only tests that `pickNextTask` returns the first pending task and handles empty/all-complete cases. [source: research-7.md#L100-L105] [source: research-9.md#L69-L70]

### F9: The PRD Instructed Modifying `pickNextTask` — Implementation Created a Separate Function Instead
The PRD task (line 107) said _"modify `pickNextTask` to return ALL tasks whose dependencies are met"_ but implementation created `pickReadyTasks` as a new function, leaving `pickNextTask` unchanged. This preserved backward compatibility but created the semantic gap enabling all the fallback issues. [source: research-9.md#L33-L37]

### F10: `atomicCommit` Uses `--no-verify`
Git commits in `atomicCommit` (gitOps.ts L87) bypass git hooks with `--no-verify`, which could skip pre-commit hooks in projects that use them. [source: research-8.md#L139-L140]

---

## Cross-Report Patterns

### P1: The `pickNextTask` Function Is the Root Cause of Multiple Issues (3/3 reports)
All three reports converge on `pickNextTask` as the central design problem. Research-7 traces its complete lack of dependency awareness. Research-8 shows it anchoring the entire sequential happy path. Research-9 shows it causing incorrect task selection in both the empty-fallback and single-ready-task paths. **A single change — replacing `pickNextTask` calls with `pickReadyTasks(snapshot, 1)` — would fix sequential dependency enforcement, the parallel fallback, and the `readyTasks=1` bug simultaneously.** [source: research-7.md#L108-L110] [source: research-8.md#L23-L28] [source: research-9.md#L14-L47]

### P2: Silent Degradation Is a Recurring Theme (2/3 reports)
Both Research-7 and Research-9 identify that the system silently bypasses dependency contracts without emitting events or warnings. In sequential mode, `dependsOn` is parsed but ignored (R7). In parallel mode, the fallback degrades to dependency-ignorant execution without logging (R9). The user has no signal that declared dependencies were violated. [source: research-7.md#L108-L112] [source: research-9.md#L64-L67]

### P3: "Works By Accident" Fragility (2/3 reports)
Research-7 explicitly calls the sequential path "accidentally correct" when file order matches dependency order. Research-8 implicitly relies on this — the happy path description never mentions dependency checking because none exists. This fragility means any PRD with out-of-order dependencies will silently produce incorrect task ordering. [source: research-7.md#L72-L84] [source: research-8.md#L23-L28]

### P4: Verification Layers Are Impressive but Partially Decorative (Research-8 primarily, confirmed by Research-7)
Research-8 documents 5+ post-completion verification layers, but notes that confidence scoring's vitest/tsc signals are hardcoded to Pass. Research-7 notes that dependency annotations are parsed but not enforced. The system has rich verification infrastructure with some check implementations missing or fake. [source: research-8.md#L127-L129] [source: research-7.md#L100-L105]

---

## Priority Matrix

| Pattern | Impact | Effort | Sources (with line refs) |
|---|---|---|---|
| P1: Replace `pickNextTask` with `pickReadyTasks(snapshot, 1)` | **High** — fixes sequential deps, parallel fallback, single-ready bug | **Small** — 1-line change per call site + cycle detection | [research-7.md#L108-L110](research-7.md#L108-L110), [research-9.md#L14-L47](research-9.md#L14-L47) |
| P2: Emit `DagFallbackTriggered` event on dependency bypass | **Medium** — observability for silent degradation | **Small** — add event kind + yield in fallback path | [research-9.md#L64-L67](research-9.md#L64-L67), [research-7.md#L112-L114](research-7.md#L112-L114) |
| F6: Fix `readyTasks.length === 1` to use the ready task directly | **Medium** — prevents wrong-task-execution | **Trivial** — use `readyTasks[0]` instead of fall-through | [research-9.md#L40-L47](research-9.md#L40-L47) |
| F8: Add test coverage for dependency enforcement paths | **Medium** — prevents regressions | **Medium** — need tests for `pickReadyTasks`, fallback, sequential deps | [research-7.md#L100-L105](research-7.md#L100-L105), [research-9.md#L69-L70](research-9.md#L69-L70) |
| F7: Wire vitest/tsc checks in confidence scoring | **Low-Medium** — makes verification real | **Medium** — need async execution + timeout handling | [research-8.md#L127-L129](research-8.md#L127-L129) |
| F10: Evaluate `--no-verify` on atomicCommit | **Low** — project-specific risk | **Trivial** — make configurable | [research-8.md#L139-L140](research-8.md#L139-L140) |

---

## Gaps

1. **Cycle detection**: If `pickNextTask` is replaced with `pickReadyTasks(snapshot, 1)` globally, circular dependencies would cause zero ready tasks → silent `AllDone` with pending tasks remaining. Research-7 flags this but no report investigates cycle detection implementation.

2. **Crash recovery / session persistence**: Research-8 mentions `SessionPersistence.save()` at end of each iteration but no report examines what happens on crash — whether the loop can resume from the last completed task.

3. **Bearings fix-task injection stability**: Research-8 notes that bearings failure prepends a fix task to the PRD as raw text, which mutates the task list mid-loop. No report analyzes whether this can corrupt task IDs, dependency references, or parsing.

4. **Real-world PRD dependency patterns**: No report contains data on whether actual PRD files use out-of-order `depends:` annotations. If no one does this in practice, the dependency enforcement gap is latent.

5. **Interaction between nudge-with-reset and dependency-blocked tasks**: If a dependency-blocked task (picked via fallback) continuously produces file changes but never succeeds, the nudge counter resets indefinitely — potential infinite loop in the fallback path.

---

## Sources
- research-7.md — Sequential mode dependency enforcement: `pickNextTask` ignores `dependsOn`, traces exact behavior and breakage scenarios
- research-8.md — Sequential happy path E2E: complete 10-step flow from PRD parse through task completion to next-task transition
- research-9.md — Parallel→sequential fallback: analysis of the three-way branch, intentionality determination, and `readyTasks=1` bug identification
