# Aggregation Report 2

**Wave**: 2026-03-17-ralph-parallel-sequential  
**Date**: 2026-03-17  
**Topics**: Pre-flight parallel safety, cycle detection gap, false AllDone bug

---

## Source Reports

### research-4.md — Pre-flight Parallel Safety
Key findings: Zero conflict checks exist between `pickReadyTasks()` returning and `Promise.all()` dispatching. No file-overlap detection, no workspace partitioning, no task scope analysis. Bearings check (tsc + vitest) is skipped entirely for parallel batches. Concurrent `atomicCommit()` calls race on `git add -A` with no locking. All parallel tasks share the same workspace directory, git repo, PRD file, and progress file. [source: research-4.md#L1-L130]

### research-5.md — Cycle Detection Gap
Key findings: Zero cycle detection anywhere in codebase — no DFS, no Kahn's algorithm, no topological sort. Sequential mode ignores `dependsOn` entirely (cycles invisible). Parallel mode silently deadlocks on cycles then falls back to `pickNextTask()`, accidentally violating the dependency contract without warning. `pickReadyTasks()` has zero test coverage. Identity resolution via `parseTaskId()` is fragile — string mismatches create phantom unresolvable dependencies that behave like cycles. [source: research-5.md#L1-L139]

### research-6.md — False AllDone Bug Trace
Key findings: A confirmed false AllDone path exists when (1) all pending tasks are dependency-blocked (`pickReadyTasks → []`), and (2) `pickNextTask` returns a task already in the in-memory `completedTasks` latch (status mismatch with PRD file). The `completedTasks` set uses positional `id` values that can shift when PRD is re-parsed. Multiple code paths delete/re-add entries to the latch during verification retries. The non-parallel AllDone site is safe; only the parallel fallback path is vulnerable. [source: research-6.md#L1-L132]

---

## Deduplicated Findings

### F1: No Pre-Dispatch Conflict Analysis
The parallel dispatch at `orchestrator.ts` L534 fires `Promise.all` immediately after `pickReadyTasks()` returns. The only pre-dispatch filtering is DAG dependency satisfaction and completed-task deduplication. No file-overlap detection, scope analysis, or workspace partitioning exists. Grep of entire `src/` for conflict/overlap/partition patterns returned zero matches. [source: research-4.md#L12-L38]

### F2: Bearings Check Bypassed for Parallel Batches
The bearings pre-flight (tsc + vitest health check) at `orchestrator.ts` L636–660 runs only in the single-task path. The parallel branch `continue`s back to the loop top before reaching it. Parallel tasks execute against potentially unhealthy workspace state. [source: research-4.md#L64-L73]

### F3: Git Race Condition in Parallel Path
Concurrent `atomicCommit()` calls from parallel tasks both run `git add -A`, which stages ALL workspace changes (not just the calling task's files). Two tasks completing near-simultaneously will cross-contaminate commits. No file-level isolation, locking, or worktree separation exists. [source: research-4.md#L75-L85]

### F4: Shared Mutable State Under Concurrency
All parallel tasks share: workspace directory, PRD file, `progress.txt`, and git repository. `progress.txt` is appended concurrently via `appendProgress`. `markTaskComplete` is called within each task's `Promise.all` closure, creating race conditions on PRD file mutations. The stale-task monitor (`startMonitor()`) is not started in the parallel path. [source: research-4.md#L87-L95]

### F5: Zero Cycle Detection
No cycle detection exists at parse time (`parsePrd()`) or runtime (`pickReadyTasks()`). No DFS, Kahn's algorithm, topological sort, or visited-set tracking anywhere in the codebase. Indentation-based inference is structurally cycle-free (backward-only parent lookup), but explicit `depends:` annotations can create arbitrary cycles with no validation. [source: research-5.md#L7-L20] [source: research-5.md#L51-L69]

### F6: Silent Dependency Violation via Fallback
When `pickReadyTasks()` returns empty (cycles, phantom deps, or all tasks blocked), the orchestrator falls back to `pickNextTask()` which ignores `dependsOn` entirely. Tasks execute with unmet dependencies without any warning or log. The user believes dependency ordering is respected when it is not. [source: research-5.md#L23-L49] [source: research-6.md#L42-L60]

### F7: Phantom Dependencies from Identity Mismatch
`pickReadyTasks()` resolves dependencies by matching `dependsOn` strings against `parseTaskId(description)` output. `parseTaskId()` extracts bold text or generates a slug from the first 30 chars. Typos, case differences, or partial matches in explicit `depends:` annotations create permanently unresolvable dependencies that silently hang like cycles. [source: research-5.md#L71-L90]

### F8: False AllDone in Parallel Fallback Path
When `pickReadyTasks()` returns `[]` AND `pickNextTask()` returns a task already in the in-memory `completedTasks` set, AllDone fires with `snapshot.remaining > 0`. This status mismatch can occur when `markTaskComplete` fails to update the PRD file (wrong line number after edits) or when verification retry logic deletes/re-adds latch entries. The non-parallel AllDone site (`!pickNextTask(snapshot)`) is safe — it only fires when truly no pending tasks exist. [source: research-6.md#L15-L80]

### F9: Fragile Task ID Stability
`completedTasks` uses positional numeric `id` values assigned during PRD parsing. If the PRD is re-read between iterations (after external edits or line changes), IDs are re-assigned sequentially — shifting values and making the `completedTasks` set stale. This is a precondition for the false AllDone path. [source: research-6.md#L99-L105]

### F10: Zero Test Coverage for Dependency and Parallel Systems
`pickReadyTasks()` is not tested at all (not imported in test file). No tests exist for: dependency resolution, indentation-based inference, circular dependencies, phantom dependencies, the parallel fallback AllDone path, or the interaction between `pickReadyTasks` and `pickNextTask`. `parallelMonitor.test.ts` tests cap behavior but only with zero-dependency tasks. [source: research-5.md#L93-L104] [source: research-6.md#L107-L110]

---

## Cross-Report Patterns

### P1: Silent Failure as Default Behavior (3/3 reports — HIGH CONFIDENCE)
All three reports independently identify that the system silently degrades rather than reporting errors. Pre-flight checks are silently skipped (R4), cycles silently fall back to sequential (R5), and AllDone silently fires with pending tasks (R6). No warnings, no logs, no user feedback. This is the dominant design pattern across the entire parallel subsystem.
[source: research-4.md#L64-L73] [source: research-5.md#L107-L115] [source: research-6.md#L82-L90]

### P2: `pickNextTask` as Accidental Safety Net (2/3 reports — HIGH CONFIDENCE)
Both R5 and R6 trace the same fallback code path: `pickReadyTasks() → [] → pickNextTask()`. R5 shows it accidentally breaks cycles; R6 shows it can trigger false AllDone. The function designed for simple sequential mode is repurposed as a fallback for the DAG-aware parallel system, creating a semantic mismatch that either silently violates dependencies or falsely terminates.
[source: research-5.md#L23-L49] [source: research-6.md#L28-L60]

### P3: Shared-Everything Architecture Multiplies Risk (2/3 reports — HIGH CONFIDENCE)
R4 documents shared workspace/git/PRD/progress under concurrency. R6 shows how `completedTasks` latch inconsistency with PRD file state triggers false AllDone. Both stem from the same root cause: no isolation boundaries between concurrent operations on shared mutable state.
[source: research-4.md#L87-L95] [source: research-6.md#L82-L105]

### P4: Zero Test Coverage for Critical Paths (3/3 reports — HIGH CONFIDENCE)
All three reports note absent tests for the specific subsystems they analyze. R4: no tests for parallel dispatch safety. R5: zero tests for `pickReadyTasks`, dependency resolution, or cycles. R6: zero tests for the parallel AllDone fallback path. The entire parallel + dependency subsystem is untested.
[source: research-4.md#L97-L130] [source: research-5.md#L93-L104] [source: research-6.md#L107-L110]

### P5: Task Identity is the Weakest Link (2/3 reports — MEDIUM CONFIDENCE)
R5 identifies `parseTaskId()` string matching as fragile (phantom deps). R6 identifies positional numeric `id` as unstable across PRD re-reads. Both identity systems are single points of failure for different subsystems (dependency resolution vs. completion tracking).
[source: research-5.md#L71-L90] [source: research-6.md#L99-L105]

---

## Priority Matrix

| Pattern | Impact | Effort | Sources |
|---------|--------|--------|---------|
| P1: Silent failure (no warnings/logs) | **High** — wrong results with no indication | **Low** — add warning logs at fallback points | [research-4.md#L64-L73](research-4.md#L64-L73), [research-5.md#L107-L115](research-5.md#L107-L115), [research-6.md#L82-L90](research-6.md#L82-L90) |
| F8: False AllDone bug | **High** — premature termination loses work | **Low** — guard with `snapshot.remaining > 0` check | [research-6.md#L15-L80](research-6.md#L15-L80) |
| F3: Git race condition | **High** — corrupt commits, lost changes | **Medium** — add mutex or use git worktrees | [research-4.md#L75-L85](research-4.md#L75-L85) |
| F5: No cycle detection | **Medium** — silent dependency violation | **Low** — add Kahn's algorithm in `parsePrd()` | [research-5.md#L7-L20](research-5.md#L7-L20) |
| F6: Silent dep violation via fallback | **Medium** — wrong execution order | **Low** — log warning when fallback triggers | [research-5.md#L23-L49](research-5.md#L23-L49), [research-6.md#L42-L60](research-6.md#L42-L60) |
| F2: Bearings bypass in parallel | **Medium** — unhealthy workspace before fan-out | **Low** — run bearings once before parallel dispatch | [research-4.md#L64-L73](research-4.md#L64-L73) |
| F1: No file-overlap detection | **Medium** — concurrent edits to same file | **High** — requires LLM scope prediction or task schema | [research-4.md#L12-L38](research-4.md#L12-L38) |
| F9: Fragile task ID stability | **Medium** — stale latch across PRD re-reads | **Medium** — use content-based ID instead of positional | [research-6.md#L99-L105](research-6.md#L99-L105) |
| P4: Zero test coverage | **High** (systemic) — all fixes are unprotectable | **Medium** — write tests for `pickReadyTasks`, fallback, AllDone | [research-5.md#L93-L104](research-5.md#L93-L104), [research-6.md#L107-L110](research-6.md#L107-L110) |
| F7: Phantom dependencies | **Low** — user error, but no guardrails | **Low** — add fuzzy matching or validation diagnostic | [research-5.md#L71-L90](research-5.md#L71-L90) |

---

## Gaps

1. **No report analyzed `markTaskComplete` failure modes**: R6 hypothesizes that `markTaskComplete` writing to wrong line numbers is a precondition for false AllDone, but no report traces that function's actual behavior or failure paths.

2. **No analysis of `appendProgress` thread safety**: R4 flags concurrent appends as a concern but doesn't verify whether Node.js `appendFileSync` in a `Promise.all` context actually interleaves.

3. **No exploration of mitigation strategies**: R4 raises git worktrees as a solution, R6 suggests a `snapshot.remaining > 0` guard, but none of the reports prototype or validate these fixes.

4. **No real-world PRD analysis**: R5 asks "how many real-world PRDs have accidental cycles?" but no report examines actual PRD files from usage to quantify the practical frequency of these issues.

5. **No analysis of the parallel monitor gap**: R4 notes `startMonitor()` isn't called in the parallel path, but no report explores what stale-task scenarios this enables or how long tasks can hang undetected.

---

## Sources

- [research-4.md](research-4.md) — Pre-flight Parallel Safety: analysis of dispatch path, bearings bypass, git race, shared state
- [research-5.md](research-5.md) — Cycle Detection Gap: dependency resolution, cycle behavior, identity fragility, test coverage
- [research-6.md](research-6.md) — False AllDone Bug Trace: AllDone code paths, completedTasks latch, status mismatch triggers
