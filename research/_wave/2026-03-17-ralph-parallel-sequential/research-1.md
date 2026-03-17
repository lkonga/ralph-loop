# Research 1: Parallel Mode Robustness

**Question**: Parallel mode robustness: Is it production-grade? What safeguards exist?

## Findings

### 1. Feature Gate & Configuration

Parallel mode is **off by default** and gated behind two config knobs:

- `useParallelTasks: boolean` in `RalphFeatures` — default `false` ([types.ts L147](../../../src/types.ts), [L155](../../../src/types.ts))
- `maxParallelTasks: number` in `RalphConfig` — default `1` ([types.ts L461](../../../src/types.ts), [L505](../../../src/types.ts))
- Both must be truthy *and* `maxParallelTasks > 1` for parallel path to activate ([orchestrator.ts L516](../../../src/orchestrator.ts))

A secondary cap exists:
- `maxConcurrencyPerStage: number` — default `1` ([types.ts L471](../../../src/types.ts), [L511](../../../src/types.ts))
- When `> 1`, it **overrides** `maxParallelTasks` as the concurrency cap ([orchestrator.ts L518–520](../../../src/orchestrator.ts)):
  ```ts
  const concurrencyCap = this.config.maxConcurrencyPerStage > 1
      ? this.config.maxConcurrencyPerStage
      : this.config.maxParallelTasks;
  ```

### 2. DAG-Aware Task Selection — `pickReadyTasks()`

Located in [prd.ts L106–124](../../../src/prd.ts). The function:
1. Collects all completed task IDs into a set
2. Iterates pending tasks, checking if **all** `dependsOn` entries are satisfied
3. Caps output at `maxTasks` parameter

**Strengths**: Respects DAG dependencies, prevents out-of-order execution.

**Weakness**: The dependency resolution uses `parseTaskId()` which extracts bold-formatted IDs (`**Task-001**`). If task descriptions don't follow this convention, dependency matching silently fails — tasks with unresolvable deps would be treated as dependency-free and could run prematurely.

### 3. Parallel Execution Path — `Promise.all`

Located in [orchestrator.ts L534–575](../../../src/orchestrator.ts):

```ts
const parallelResults = await Promise.all(
    readyTasks.map(async (task) => { ... })
);
```

Each parallel task independently:
- Gets a unique `invId` via `crypto.randomUUID()`
- Builds its own prompt with `buildPrompt()`
- Calls `this.executionStrategy.execute(task, prompt, ...)`
- Logs to progress file via `appendProgress()`
- Attempts `atomicCommit()` per task

**Error handling**: Each task is wrapped in individual `try/catch` — one failure doesn't kill the batch. Errors are logged via `appendProgress` and emitted as `LoopEventKind.Error` events.

### 4. Safeguards Present

| Safeguard | Status | Details |
|-----------|--------|---------|
| **Feature gate (off by default)** | ✅ Strong | Triple guard: `useParallelTasks` + `maxParallelTasks > 1` + feature flag |
| **Concurrency cap** | ✅ Good | `maxConcurrencyPerStage` overrides `maxParallelTasks` ([orchestrator.ts L518–520](../../../src/orchestrator.ts)) |
| **DAG dependency check** | ✅ Good | `pickReadyTasks()` respects `dependsOn` before allowing parallel execution |
| **Completed-task deduplication** | ✅ Good | `.filter(t => !this.completedTasks.has(t.id))` prevents re-execution ([L522](../../../src/orchestrator.ts)) |
| **Per-task error isolation** | ✅ Good | Individual `try/catch` per parallel task ([L541–571](../../../src/orchestrator.ts)) |
| **Yield/stop honor after batch** | ✅ Good | Checks `this.yieldRequested` and `this.stopRequested` after `Promise.all` completes ([L576–585](../../../src/orchestrator.ts)) |
| **Countdown between batches** | ✅ Good | Inserts `countdownSeconds` delay between batches with stop-check per second ([L588–595](../../../src/orchestrator.ts)) |
| **Fallback to single-task** | ✅ Good | If 0 ready parallel tasks, falls back to `pickNextTask()` ([L524–530](../../../src/orchestrator.ts)). If only 1 ready task, falls through to single-task path |
| **Atomic git commits** | ⚠️ Risky | Each parallel task calls `atomicCommit()` independently (see Gaps) |
| **Per-task progress logging** | ✅ Good | Each parallel task gets its own `[invId]` tagged entries in progress file |
| **Parallel monitor** | ⚠️ Not used | `startMonitor()` exists ([orchestrator.ts L168–212](../../../src/orchestrator.ts)) but is only invoked in the **single-task path** ([L705](../../../src/orchestrator.ts)), NOT in the parallel batch path |

### 5. `startMonitor()` Function

Defined at [orchestrator.ts L168–212](../../../src/orchestrator.ts):
- Polls PRD mtime, progress mtime, progress size, checkbox count at `intervalMs` (default 10s)
- Emits `MonitorAlert` after `stuckThreshold` consecutive stale intervals (default 3)
- Has clean `stop()` via `clearInterval`
- **Disabled by default** (`DEFAULT_PARALLEL_MONITOR.enabled = false`, [types.ts L222–226](../../../src/types.ts))
- Well tested in [parallelMonitor.test.ts](../../../test/parallelMonitor.test.ts) (6 test cases covering stuck detection, reset on change, all 4 signal types, stop cleanup, disabled mode)

### 6. `ParallelMonitorConfig`

```ts
export interface ParallelMonitorConfig {
    enabled: boolean;
    intervalMs: number;
    stuckThreshold: number;
}
// Default: { enabled: false, intervalMs: 10000, stuckThreshold: 3 }
```

### 7. `atomicCommit()` in Parallel Context

Located at [gitOps.ts L55–99](../../../src/gitOps.ts):
- Checks for rebase/merge/cherry-pick in progress
- Runs `git add -A`, `git diff --cached --name-only`, then `git commit`
- **No locking mechanism** — entirely sequential git operations

## Patterns

1. **Gate-then-fan-out**: Feature flags gate entry → `pickReadyTasks()` selects batch → `Promise.all` fans out → per-task error isolation → countdown → loop
2. **Fallback cascade**: 0 ready tasks → single-task fallback; 1 ready task → single-task path; 2+ → parallel path
3. **Fire-and-forget commits**: Each parallel task commits independently after completion — no coordination between commits
4. **Event-driven observability**: Every state transition emits a typed `LoopEvent` for UI/logging consumption

## Gaps/Concerns

### Critical

1. **Git race condition in parallel commits** ([orchestrator.ts L555–564](../../../src/orchestrator.ts)): Multiple parallel tasks call `atomicCommit()` concurrently. Since `atomicCommit()` does `git add -A` → `git diff --cached` → `git commit` with no locking:
   - Task A's `git add -A` could stage files from Task B
   - Two tasks could race on `git add -A` creating interleaved commits
   - `git commit` itself may fail with index.lock contention
   - **This is a correctness bug** in any scenario where parallel tasks touch different files

2. **`appendProgress()` uses `fs.appendFileSync`** — concurrent calls from parallel tasks writing to the same file. On most OS/FS combos this is atomic for small writes via `O_APPEND`, but not guaranteed for large writes. Low risk but not formally safe.

3. **Progress file reads during parallel execution**: Each parallel task reads `progressPath` (`progContent = fs.readFileSync(progressPath, 'utf-8')`) while others may be appending to it concurrently ([orchestrator.ts L545](../../../src/orchestrator.ts)). This is benign (stale read) but could cause prompt quality issues.

### Moderate

4. **Monitor not started for parallel tasks**: `startMonitor()` is only invoked in the single-task path ([L705](../../../src/orchestrator.ts)). Parallel batch tasks have **no stuck detection**. If a parallel task hangs indefinitely inside `executionStrategy.execute()`, the entire `Promise.all` blocks with no alert.

5. **No per-task timeout in parallel path**: The single-task path has nudge loops, inactivity timeouts, and circuit breakers. The parallel path has none of this — it relies entirely on `executionStrategy.execute()` returning or throwing. A hung execution strategy blocks the batch forever (subject only to the global `LinkedCancellationSource` timeout).

6. **No diff validation in parallel path**: The single-task path has `DiffValidator` integration with retry logic. The parallel path skips diff validation entirely — tasks are marked complete based solely on `execResult.completed` without verifying actual file changes.

7. **`Promise.all` vs `Promise.allSettled`**: Using `Promise.all` means if the internal `try/catch` somehow misses (e.g., unhandled rejection in `atomicCommit`), the entire batch fails. `Promise.allSettled` would be more resilient.

### Minor

8. **No backpressure classification**: The `BackpressureClassifier` and `StruggleDetector` are not engaged during parallel execution. Parallel tasks can't detect thrashing or stagnation patterns.

9. **Iteration count**: A parallel batch of N tasks counts as a single iteration (`iteration++` on [L534](../../../src/orchestrator.ts)). This means `maxIterations` underestimates actual work done in parallel mode.

10. **Test coverage**: Only `pickReadyTasks` cap behavior and `startMonitor` are tested ([parallelMonitor.test.ts](../../../test/parallelMonitor.test.ts)). There are **no integration tests** for the actual parallel execution path in `runLoop()` — the `Promise.all` branch, error isolation, and commit race conditions are untested.

## Open Questions

1. **Is the Git race condition observed in practice?** If parallel tasks always touch disjoint file sets, the `git add -A` race may be benign, but it's architecturally unsound. A simple mutex/queue around `atomicCommit` would fix this.

2. **Should `startMonitor()` be started per-task in the parallel path?** Each parallel task could get its own monitor instance — the function already accepts per-task IDs.

3. **Why is `Promise.all` used instead of `Promise.allSettled`?** The try/catch inside mitigates this, but `allSettled` would be more defensive.

4. **Is the parallel mode actually used by anyone?** Defaults are off (`useParallelTasks: false`, `maxParallelTasks: 1`). No evidence of CLI flags or UI toggles to enable it. It may be experimental/unreleased.

5. **Should parallel tasks have individual timeouts?** A per-task `AbortSignal.timeout()` wrapping each `execute()` call would prevent batch-blocking hangs.

6. **What happens if all parallel tasks fail?** The code continues to the next iteration — no circuit-breaker or bail-out for batch-wide failure.

## Verdict

**Not production-grade.** The parallel mode has a thoughtful design foundation (DAG-aware selection, concurrency caps, error isolation, feature gates) but contains **critical correctness bugs** (git race conditions), **missing safeguards** (no per-task timeouts, no monitoring, no diff validation), and **zero integration test coverage** for the parallel execution path. It is suitable for experimental/demo use with independent tasks that don't need git commits, but should not be used for production workloads without addressing the gaps above.
