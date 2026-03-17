# Final Report: Ralph-Loop Parallel & Sequential Execution Deep Analysis

## Executive Summary

Comprehensive analysis of ralph-loop's parallel and sequential task execution across 12 research reports (4 aggregations). Ralph implements DAG-aware batch parallelism — the same pattern as Make, Bazel, and Airflow — making it **unique among VS Code AI coding agents**. However, the implementation has critical gaps at integration points. The **single most impactful finding**: `pickNextTask()` ignores `dependsOn` annotations, meaning the entire sequential mode (the default) silently bypasses declared dependencies. A **1-line fix** (delegate to `pickReadyTasks(snapshot, 1)[0]`) resolves sequential dependency enforcement, the parallel fallback bug, and the `readyTasks=1` wrong-task bug simultaneously. The second critical issue: `atomicCommit()` has no serialization, causing git race conditions in parallel mode (fixable with `p-limit(1)`). Parallel mode is off by default (triple feature gate), so most users are shielded from the worst bugs. The system's design foundation is sound — DAG scheduling, layered verification, event-driven observability — but execution is incomplete: zero test coverage for dependency/parallel subsystems, silent failure as default behavior, and shared-everything architecture under concurrency.

---

## Consolidated Findings (by category, deduplicated)

### A. Task Scheduling & Dependency Enforcement

**A1: `pickNextTask` Is Completely Dependency-Unaware (CRITICAL)**
Returns the first pending task by document order. Ignores `dependsOn` entirely. Used for: (a) all of sequential mode, (b) parallel fallback when `pickReadyTasks → []`, (c) `readyTasks.length === 1` fall-through. The PRD instructed modifying this function to be DAG-aware; implementation created a separate `pickReadyTasks` instead, leaving the original unchanged.
[via: aggregation-3.md#F1 ← research-7.md#L8-L14, research-9.md#L14-L22]
[via: aggregation-3.md#F9 ← research-9.md#L33-L37]

**A2: Sequential Mode Works Only When File Order Matches Dependency Order**
Dependencies are parsed and stored but never consulted. Correct execution is accidental — it works when the PRD author lists tasks in topological order (the common case).
[via: aggregation-3.md#F2 ← research-7.md#L46-L84]

**A3: 1-Line Fix Available — Replace `pickNextTask` Body**
Redefine `pickNextTask(snapshot)` to return `pickReadyTasks(snapshot, 1)[0]`. All 3 call sites (orchestrator.ts L494, L524, L596) are automatically fixed. All 3 existing tests continue to pass. Identical behavior when no deps exist, strict improvement when deps exist.
[via: aggregation-4.md#F1 ← research-11.md#L7-L50, research-12.md#L142-L144]

**A4: `readyTasks.length === 1` Path Has a Distinct Bug**
When exactly one task is DAG-ready, code falls through to `pickNextTask(snapshot)` which picks the first pending task — potentially a dependency-blocked task appearing earlier in the file, not the single ready task.
[via: aggregation-3.md#F6 ← research-9.md#L40-L47]

**A5: Zero Cycle Detection**
No DFS, Kahn's algorithm, topological sort, or visited-set tracking in the codebase. Circular `dependsOn` annotations silently deadlock `pickReadyTasks` (returns `[]` forever). Sequential mode can't detect cycles because it ignores dependencies. Every production DAG scheduler detects and reports cycles.
[via: aggregation-2.md#F5 ← research-5.md#L7-L20, research-5.md#L51-L69]
[via: aggregation-4.md#F5 ← research-12.md#L145-L147]

**A6: Phantom Dependencies from Identity Mismatch**
`parseTaskId()` extracts bold text or generates a slug from first 30 chars. Typos, case differences, or partial matches in `depends:` annotations create permanently unresolvable dependencies that behave identically to cycles.
[via: aggregation-2.md#F7 ← research-5.md#L71-L90]

**A7: Fragile Positional Task IDs**
`completedTasks` set uses positional numeric `id` values assigned during PRD parsing. If PRD is re-read between iterations, IDs shift — making the latch stale. Precondition for false AllDone.
[via: aggregation-2.md#F9 ← research-6.md#L99-L105]

### B. Git Operations Under Concurrency

**B1: `atomicCommit()` Has No Serialization (CRITICAL)**
`git add -A` → `git diff --cached` → `git commit` with no inter-task locking. `git add -A` stages ALL working tree changes, not just the calling task's files. Concurrent calls from parallel tasks create two failure modes:
- **Lock contention**: `.git/index.lock` — second call fails, not retried
- **Semantic mis-staging**: Fast-completing task scoops up slow task's files, producing misattributed commits and "nothing to commit" failures

Fix: `p-limit(1)` or async mutex around `atomicCommit()` serializes commits without blocking parallel task execution.
[via: aggregation-1.md#F1 ← research-1.md#L89-L95, research-2.md#L45-L58]
[via: aggregation-4.md#F2 ← research-10.md#L32-L52]

**B2: `atomicCommit` Uses `--no-verify`**
Git hooks bypassed on all commits. Project-specific risk if pre-commit hooks are relied upon.
[via: aggregation-3.md#F10 ← research-8.md#L139-L140]

### C. Parallel Mode Architecture

**C1: Triple Feature Gate (Off by Default)**
Requires `useParallelTasks: true` + `maxParallelTasks > 1` + parallel code path in orchestrator.ts. Defaults: `false` and `1`. Most users never encounter parallel execution.
[via: aggregation-1.md#F3 ← research-1.md#L9-L19]
[via: aggregation-4.md#CP3 ← research-12.md#L139-L140]

**C2: DAG-Aware Scheduling via `pickReadyTasks()`**
Collects completed IDs, checks if all `dependsOn` entries are satisfied, caps at `maxTasks`. Well-designed but only called in the parallel path.
[via: aggregation-1.md#F4 ← research-1.md#L21-L30]

**C3: No Pre-Dispatch Conflict Analysis**
`Promise.all` fires immediately after `pickReadyTasks()`. No file-overlap detection, scope analysis, or workspace partitioning. Grep of `src/` for conflict/overlap/partition returns zero matches.
[via: aggregation-2.md#F1 ← research-4.md#L12-L38]

**C4: `Promise.all` Batch Semantics Waste Time**
All tasks in a batch must complete before next batch starts. Reactive dispatch (process next-ready task as each completes) would improve throughput. Matches how Airflow and modern CI systems work.
[via: aggregation-4.md#F4 ← research-12.md#L131-L132]

**C5: Shared-Everything Architecture Under Concurrency**
All parallel tasks share: workspace directory, PRD file, `progress.txt`, git repository. No isolation boundaries between concurrent operations on shared mutable state.
[via: aggregation-2.md#F4 ← research-4.md#L87-L95]

**C6: Bearings Check Bypassed for Parallel Batches**
Pre-flight tsc + vitest health check runs only in single-task path. Parallel branch `continue`s back to loop top before reaching it. Parallel tasks execute against potentially unhealthy workspace state.
[via: aggregation-2.md#F2 ← research-4.md#L64-L73]

**C7: No Monitoring for Parallel Tasks**
`startMonitor()` invoked only in single-task path. Hung parallel tasks are undetectable.
[via: aggregation-1.md#F6 ← research-1.md#L56-L62, research-1.md#L96-L98]

**C8: No Diff Validation or Backpressure in Parallel Path**
`DiffValidator`, `BackpressureClassifier`, and `StruggleDetector` not engaged in parallel execution.
[via: aggregation-1.md#F6 ← research-1.md#L103-L104, research-1.md#L110-L111]

### D. Parallel→Sequential Fallback

**D1: Silent Dependency Violation via Fallback**
When `pickReadyTasks() → []`, orchestrator falls back to `pickNextTask()` which ignores `dependsOn`. Intentional "progress over correctness" tradeoff (confirmed by inline comment). No event, log, or warning emitted.
[via: aggregation-2.md#F6 ← research-5.md#L23-L49, research-6.md#L42-L60]
[via: aggregation-3.md#F5 ← research-9.md#L46-L62]

**D2: False AllDone Bug in Parallel Fallback Path**
When `pickReadyTasks() → []` AND `pickNextTask()` returns a task already in `completedTasks` latch (status mismatch with PRD file), AllDone fires with `snapshot.remaining > 0`. Preconditions: `markTaskComplete` fails to update PRD (wrong line number after edits) or verification retry logic deletes/re-adds latch entries.
[via: aggregation-2.md#F8 ← research-6.md#L15-L80]

### E. Sequential Happy Path

**E1: Complete 10-Step Flow with Layered Verification**
PRD Parse → Task Pick → Pre-flight (Checkpoint + Bearings) → Prompt Build → Strategy Execute → Nudge Loop → Dual Exit Gate → Mark Complete (5+ sub-gates) → Next Task Transition. Each post-completion gate can force re-entry.
[via: aggregation-3.md#F3 ← research-8.md#L13-L122]

**E2: Agent-Driven Completion Is Primary Mechanism**
The agent marks the PRD checkbox; ralph monitors via `FileSystemWatcher`. `markTaskComplete()` only called directly for checkpoint tasks.
[via: aggregation-3.md#F4 ← research-8.md#L65-L78]

**E3: Confidence Scoring Vitest/TSC Checks Are Hardcoded to Pass**
Vitest and tsc signals in confidence scoring are hardcoded `VerifyResult.Pass` rather than actually executing. Real bearings check only happens in pre-flight gate, making confidence scoring partially decorative.
[via: aggregation-3.md#F7 ← research-8.md#L127-L129]

### F. Origin & Ecosystem Position

**F1: Parallel Mode Is Original to Ralph-Loop**
Synthesized from vinitm/ralph-loop's DAG dependency concept and VS Code Copilot Chat's `SearchSubagentToolCallingLoop` background pipeline. No other ralph fork (6 analyzed) has parallel execution.
[via: aggregation-1.md#F9 ← research-3.md#L7-L43]

**F2: Read-Only vs Write-Heavy Analogy Gap**
VS Code's background pipeline runs read-only reviewers in parallel. Ralph runs write-heavy code-editing tasks. The concurrent file modification race conditions have no counterpart in the original pattern.
[via: aggregation-1.md#F10 ← research-3.md#L58-L60]

**F3: Unique Among VS Code AI Coding Extensions**
Among 7 compared tools (Aider, Continue, Cursor, Cline, AutoGen, CrewAI, LangGraph), only LangGraph and CrewAI offer comparable parallel capabilities — as general-purpose frameworks, not VS Code extensions.
[via: aggregation-4.md#F3 ← research-12.md#L107-L125]

### G. Test Coverage

**G1: Zero Test Coverage for Dependency/Parallel Subsystems**
Not tested: `pickReadyTasks`, dependency resolution, cycle detection, parallel dispatch, fallback paths, AllDone parallel path, `readyTasks=1` case, concurrent git operations. Only `pickNextTask` basic behavior and `startMonitor` cap behavior have tests.
[via: aggregation-1.md#F11 ← research-1.md#L113-L114]
[via: aggregation-2.md#F10 ← research-5.md#L93-L104, research-6.md#L107-L110]
[via: aggregation-3.md#F8 ← research-7.md#L100-L105]

---

## Pattern Catalog

### PAT-1: Silent Failure as Default Behavior
**Confidence**: HIGH (identified in 4/4 aggregations, sourced from 8+ research reports)
**Description**: The system silently degrades rather than reporting errors across every subsystem: pre-flight checks silently skipped in parallel, cycles silently fall back to sequential, AllDone silently fires with pending tasks, dependency violations have no log or event.
**Implementation detail**: No warning logs, no `LoopEventKind` for fallback triggers, no user-facing indication of degraded operation.
[via: aggregation-1.md#P3 ← research-1.md#L43-L63]
[via: aggregation-2.md#P1 ← research-4.md#L64-L73, research-5.md#L107-L115, research-6.md#L82-L90]
[via: aggregation-3.md#P2 ← research-7.md#L108-L112, research-9.md#L64-L67]

### PAT-2: `pickNextTask` as Central Design Flaw
**Confidence**: HIGH (identified in 3/4 aggregations, sourced from 6+ research reports)
**Description**: A single naive function (`.find(status === Pending)`) anchors sequential mode, parallel fallback, and single-ready-task paths. It ignores `dependsOn` and is the root cause of at least 4 distinct bugs.
**Fix**: Replace body with `return pickReadyTasks(snapshot, 1)[0]` — 1 line of production code.
[via: aggregation-3.md#P1 ← research-7.md#L108-L110, research-8.md#L23-L28, research-9.md#L14-L47]
[via: aggregation-4.md#F1 ← research-11.md#L7-L50]

### PAT-3: Git Commit Architecture as Critical Weakness
**Confidence**: HIGH (identified in 3/4 aggregations, sourced from 5+ research reports)
**Description**: `atomicCommit()` is atomic within a single call but provides no atomicity across concurrent calls. `git add -A` stages all workspace changes indiscriminately. The function name is misleading.
**Fix**: `p-limit(1)` wrapper around `atomicCommit()` calls + replace `git add -A` with `git add <specific-files>`.
[via: aggregation-1.md#P1 ← research-1.md#L89-L95, research-2.md#L45-L58, research-3.md#L58-L60]
[via: aggregation-4.md#F2 ← research-10.md#L32-L52]

### PAT-4: Accidental Serialization Masks Latent Bugs
**Confidence**: HIGH (identified in 2/4 aggregations, sourced from 4 research reports)
**Description**: VS Code's single-threaded chat panel likely serializes parallel task execution, accidentally preventing the worst race conditions. Bugs are latent — they would manifest with a truly concurrent execution strategy (e.g., `DirectApiStrategy`).
[via: aggregation-1.md#P2 ← research-2.md#L71-L75, research-3.md#L55-L57]
[via: aggregation-1.md#F8 ← research-2.md#L71-L75]

### PAT-5: Sound Design, Incomplete Execution
**Confidence**: HIGH (identified in 3/4 aggregations)
**Description**: The system has well-designed infrastructure — triple feature gates, DAG scheduling, layered verification (5+ post-completion layers), event-driven observability, clear lineage from proven patterns. But integration points have gaps: no locking, no timeouts, no monitoring in parallel, partially hardcoded verification, zero test coverage. Small, targeted fixes would bring it to production quality.
[via: aggregation-1.md#P3 ← research-1.md#L43-L63, research-2.md#L9-L14, research-3.md#L37-L43]
[via: aggregation-4.md#CP2 ← research-11.md#L75-L81, research-10.md#L74-L76]

### PAT-6: Task Identity Fragility
**Confidence**: MEDIUM (identified in 2/4 aggregations)
**Description**: Two separate identity systems are each single points of failure: `parseTaskId()` string matching (phantom deps from typos) and positional numeric `id` (stale across PRD re-reads). Both feed into different subsystems — dependency resolution and completion tracking respectively.
[via: aggregation-2.md#P5 ← research-5.md#L71-L90, research-6.md#L99-L105]

---

## Priority Matrix

| # | Fix | Impact | Effort | Priority | Sources (with line refs) |
|---|-----|--------|--------|----------|--------------------------|
| 1 | **Replace `pickNextTask` body with `pickReadyTasks(snapshot, 1)[0]`** | Critical — fixes sequential deps, parallel fallback, `readyTasks=1` bug | Trivial — 1 line prod code | **P0** | [via: aggregation-4.md#F1 ← research-11.md#L75-L81] [via: aggregation-3.md#P1 ← research-7.md#L108-L110, research-9.md#L14-L47] |
| 2 | **Add `p-limit(1)` mutex to `atomicCommit()` calls** | Critical — prevents misattributed commits, lost changes | Low — wrapper function | **P0** | [via: aggregation-4.md#F2 ← research-10.md#L56-L76] [via: aggregation-1.md#P1 ← research-1.md#L89-L95, research-2.md#L45-L58] |
| 3 | **Emit `DagFallbackTriggered` event + log warning on dependency bypass** | High — makes silent degradation visible | Low — add event kind + yield | **P1** | [via: aggregation-3.md#P2 ← research-9.md#L64-L67, research-7.md#L112-L114] [via: aggregation-2.md#P1 ← research-5.md#L107-L115] |
| 4 | **Guard false AllDone: check `snapshot.remaining > 0` before AllDone emit** | High — prevents premature termination | Low — 1 conditional | **P1** | [via: aggregation-2.md#F8 ← research-6.md#L15-L80] |
| 5 | **Fix `readyTasks.length === 1`: use `readyTasks[0]` directly** | Medium — prevents wrong-task execution | Trivial — use array value | **P1** | [via: aggregation-3.md#F6 ← research-9.md#L40-L47] |
| 6 | **Add cycle detection (Kahn's algorithm or remaining > 0 && ready === 0 guard)** | Medium — prevents silent deadlocks | Low — ~20 lines | **P1** | [via: aggregation-2.md#F5 ← research-5.md#L7-L20] [via: aggregation-4.md#F5 ← research-12.md#L145-L147] |
| 7 | **Add per-task timeout in parallel path** | High — prevents indefinite hangs | Low — `AbortSignal.timeout()` | **P1** | [via: aggregation-1.md#F6 ← research-1.md#L99-L101] |
| 8 | **Start `startMonitor()` per-task in parallel path** | High — enables hung-task detection | Low — move invocation | **P2** | [via: aggregation-1.md#F6 ← research-1.md#L56-L62] |
| 9 | **Run bearings check once before parallel dispatch** | Medium — prevents unhealthy-state fan-out | Low — reorder code | **P2** | [via: aggregation-2.md#F2 ← research-4.md#L64-L73] |
| 10 | **Write integration tests for dependency/parallel subsystems** | High (systemic) — all fixes are unprotectable without tests | Medium — ~100-150 lines | **P2** | [via: aggregation-2.md#P4 ← research-5.md#L93-L104, research-6.md#L107-L110] |
| 11 | **Replace `git add -A` with `git add <specific-files>`** | Medium — prevents cross-task commit pollution | Medium — track modified files per task | **P2** | [via: aggregation-1.md#F1 ← research-2.md#L45-L58] |
| 12 | **Switch `Promise.all` to `Promise.allSettled`** | Low — defense-in-depth for unhandled rejections | Trivial | **P3** | [via: aggregation-1.md#F5 ← research-1.md#L107-L108] |
| 13 | **Wire real vitest/tsc checks into confidence scoring** | Low-Medium — makes verification real | Medium — async + timeout | **P3** | [via: aggregation-3.md#F7 ← research-8.md#L127-L129] |
| 14 | **Reactive dispatch (replace batch `Promise.all`)** | Medium — throughput improvement | Medium-High — architectural | **P3** | [via: aggregation-4.md#F4 ← research-12.md#L131-L132] |
| 15 | **Add post-parallel consistency check** | Low-Medium — catch inter-task conflicts | Medium — define consistency contract | **P3** | [via: aggregation-4.md#F6 ← research-12.md#L134-L135] |

---

## Recommended Plan (ordered, with dependencies)

### Phase 1: Critical Correctness (P0) — No dependencies
1. **Fix `pickNextTask`**: Redefine body → `return pickReadyTasks(snapshot, 1)[0]` in `src/prd.ts` L103
2. **Serialize git commits**: Add `p-limit(1)` wrapper around `atomicCommit()` in `src/gitOps.ts`

### Phase 2: Safety & Observability (P1) — Depends on Phase 1
3. **Add cycle detection**: Guard in `parsePrd()` or `pickReadyTasks()` — report cycles as user-facing errors
4. **Emit `DagFallbackTriggered` event**: Add `LoopEventKind.DagFallbackTriggered` + warning log when dependency bypass occurs
5. **Guard false AllDone**: Add `snapshot.remaining > 0` check before AllDone emit in parallel fallback path
6. **Fix `readyTasks.length === 1`**: Use `readyTasks[0]` directly instead of falling through to `pickNextTask`
7. **Add per-task timeout**: Wrap parallel `execute()` in `AbortSignal.timeout()`

### Phase 3: Hardening (P2) — Depends on Phases 1-2
8. **Start monitor in parallel path**: Move `startMonitor()` invocation to cover parallel tasks
9. **Pre-dispatch bearings**: Run tsc + vitest health check before parallel batch
10. **Integration tests**: Cover `pickReadyTasks`, fallback paths, cycle detection, git serialization, AllDone guards
11. **Per-task git staging**: Replace `git add -A` with `git add <specific-files>`, requires tracking modified files per task

### Phase 4: Optimization (P3) — Independent
12. Swap `Promise.all` → `Promise.allSettled`
13. Wire real vitest/tsc in confidence scoring
14. Reactive dispatch model
15. Post-parallel consistency checks

---

## Gaps & Further Research

1. **`markTaskComplete()` failure modes**: Multiple aggregations hypothesize concurrent PRD writes can corrupt state, but no report traces the function's actual behavior or concurrent write failure paths.
2. **`DirectApiStrategy` under parallel execution**: Accidental serialization via VS Code chat panel masks bugs. No research on what happens with a truly concurrent strategy.
3. **Parallel throughput benchmarks**: No measurement of whether parallel mode actually improves completion speed given the accidental serialization.
4. **`git add <specific-files>` feasibility**: Open question whether the execution strategy already tracks per-task modified files.
5. **Checkpoint interaction with parallel batches**: How `[CHECKPOINT]` markers interact with `Promise.all` dispatch is unexplored.
6. **Real-world PRD dependency patterns**: No data on whether actual PRDs use out-of-order `depends:` annotations — if none do, the sequential dependency gap is latent.
7. **Crash recovery / session persistence**: Whether the loop can resume from last completed task after crash is unanalyzed.
8. **Bearings fix-task injection stability**: Prepending a fix task to PRD as raw text mid-loop may corrupt task IDs or dependency references.
9. **Nudge-reset infinite loop potential**: Dependency-blocked task picked via fallback that continuously produces changes but never succeeds would reset nudge counter indefinitely.
10. **`LinkedCancellationSource` timeout behavior**: Mentioned as only timeout protection in parallel mode but configuration and effectiveness not investigated.

---

## Source Chain

| Aggregation | Research Reports |
|---|---|
| aggregation-1.md | research-1.md (parallel robustness audit), research-2.md (merge conflict prevention), research-3.md (origins of parallel mode) |
| aggregation-2.md | research-4.md (pre-flight parallel safety), research-5.md (cycle detection gap), research-6.md (false AllDone bug trace) |
| aggregation-3.md | research-7.md (sequential dependency enforcement), research-8.md (sequential happy path E2E), research-9.md (parallel→sequential fallback) |
| aggregation-4.md | research-10.md (atomic git commits in parallel), research-11.md (fix sequential dependsOn), research-12.md (comparison with research patterns) |

Full traceability: FINAL-REPORT → aggregation-{1..4}.md → research-{1..12}.md
