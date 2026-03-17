# Research 6: False AllDone Bug Trace

**Question**: When `pickReadyTasks` returns empty with pending tasks remaining, trace the exact code path. Does the orchestrator incorrectly report completion?

## Findings

### The Critical Code Path (orchestrator.ts L515–530)

When parallel mode is enabled (`useParallelTasks && maxParallelTasks > 1`), the orchestrator at L520–521:

```ts
const readyTasks = pickReadyTasks(snapshot, concurrencyCap)
    .filter(t => !this.completedTasks.has(t.id));
```

If `readyTasks.length === 0` (L523), it falls back to `pickNextTask(snapshot)` at L524:

```ts
const fallbackTask = pickNextTask(snapshot);
if (!fallbackTask || this.completedTasks.has(fallbackTask.id)) {
    yield { kind: LoopEventKind.AllDone, total: snapshot.total };
    return;   // <-- TERMINATES THE LOOP
}
// Fall through to single-task execution below
```

### pickReadyTasks vs pickNextTask — The Semantic Mismatch

**`pickReadyTasks` (prd.ts L106–124)** is DAG-aware: it checks `task.dependsOn` and only returns tasks whose dependencies are all complete. It builds a `completedDescriptions` set from completed task descriptions and verifies `deps.every(dep => completedDescriptions.has(dep))`.

**`pickNextTask` (prd.ts L102–104)** is **NOT** DAG-aware: it simply returns `snapshot.tasks.find(t => t.status === TaskStatus.Pending)` — the first pending task regardless of dependency state.

### Branch Analysis

**Scenario: Tasks with unmet dependencies (the false AllDone trigger)**

Consider: Task A (complete), Task B (pending, depends on C), Task C (pending, depends on A).

1. `pickReadyTasks` returns: `[Task C]` (its dep on A is met). Task B is blocked. This works correctly.

**Scenario: ALL remaining tasks have circular or unresolvable dependencies**

Consider: Task A (complete), Task B (pending, depends on C), Task C (pending, depends on B).

1. `pickReadyTasks` returns `[]` — no tasks have all deps met.
2. `pickNextTask` returns Task B (first pending) — **ignoring that B's deps are unmet**.
3. `this.completedTasks.has(B.id)` is `false`.
4. **Fallback succeeds**: B falls through to single-task execution. No false AllDone here.

**Scenario: Stale `completedTasks` latch disagrees with PRD file**

Consider: Task A marked pending in PRD file, but `this.completedTasks` has A's id (from a previous failed verification that deleted latch then re-added it).

1. `pickReadyTasks` returns tasks that are pending and deps-met, filtered by `!this.completedTasks.has(t.id)`.
2. If ALL such tasks are in `completedTasks`, result is `[]`.
3. `pickNextTask` returns first pending task — if that's also in `completedTasks`, **AllDone fires falsely**.

**Scenario: The CONFIRMED false AllDone path**

Given: Parallel mode enabled. All pending tasks have dependencies. No pending task has all deps met. The first pending task (`pickNextTask` result) is already in `completedTasks` (status mismatch between PRD file and in-memory latch).

1. `pickReadyTasks` → `[]` (all blocked by deps)
2. `pickNextTask` → Task X (first pending in PRD)
3. `this.completedTasks.has(X.id)` → `true`
4. **`AllDone` fires with `snapshot.remaining > 0`** — FALSE COMPLETION

### The More Common False AllDone Path

The most likely real-world trigger:

1. `pickReadyTasks` returns `[]` because all pending tasks are dependency-blocked.
2. `pickNextTask` returns a task that was already completed in a previous iteration (its checkbox was marked `[x]` in the PRD but the task is actually... wait — `pickNextTask` only finds `Pending` tasks). 

So `pickNextTask` returns the first task with `status === Pending`. If that task is in `completedTasks` (in-memory set), we get AllDone. This can happen when:
- A task was completed, added to `completedTasks`, but `markTaskComplete` failed to update the PRD file (e.g., wrong line number after edits)
- The verification loop at L893/946/958/990/1019 called `this.completedTasks.delete(task.id)` to retry, but then the task got re-added to `completedTasks` before the PRD was updated

### The Non-Parallel Path (L596–600)

```ts
const task = pickNextTask(snapshot);
if (!task) {
    yield { kind: LoopEventKind.AllDone, total: snapshot.total };
    return;
}
```

This path is **safe from the dependency bug** because `pickNextTask` finds pending tasks regardless of deps (no filtering). If pending tasks exist, it always returns one. The only `completedTasks` check is at L604 which just does `continue` (retries the loop).

### Two AllDone Sites

| Site | Line | Entry Condition | False Positive Risk |
|------|------|----------------|-------------------|
| Parallel fallback | L526 | `readyTasks.length === 0 && (!fallbackTask \|\| completedTasks.has(fallbackTask.id))` | **YES** — when deps block all tasks AND first pending is latched |
| Non-parallel | L599 | `!pickNextTask(snapshot)` (no pending tasks at all) | **NO** — only fires when truly no pending tasks |

## Patterns

- **pickNextTask is dependency-blind**: It scans `snapshot.tasks` for the first `Pending` status without checking `dependsOn`. This is by design for the non-parallel path but becomes a semantic mismatch when used as a fallback for the DAG-aware `pickReadyTasks`.
- **completedTasks is a latch set**: It tracks task IDs completed in-memory. Multiple code paths delete entries (lines 893, 946, 958, 990, 1019) during verification retries, creating potential inconsistency with PRD file state.
- **parseTaskId matching**: `pickReadyTasks` checks deps against `parseTaskId(description)` strings, while `pickNextTask` doesn't check deps at all. If `parseTaskId` fails to extract the right ID (e.g., no `**bold**` pattern in description), dependency resolution silently fails.

## Gaps/Concerns

1. **No test coverage**: There are zero tests in `orchestrator.test.ts` covering the parallel path's AllDone logic, the `readyTasks.length === 0` fallback, or the interaction between `pickReadyTasks` and `pickNextTask`.

2. **No test for dependency-blocked AllDone**: `prd.test.ts` tests `pickNextTask` but never tests `pickReadyTasks` with dependencies. `parallelMonitor.test.ts` tests `pickReadyTasks` cap behavior but only with tasks that have NO dependencies.

3. **Silent fallthrough**: When `pickReadyTasks` returns empty and `pickNextTask` finds a task, that task falls through to single-task execution at L596 — but this task may have unmet dependencies. The orchestrator will attempt to execute a task whose prerequisites aren't complete.

4. **Circular dependency deadlock**: If tasks form a dependency cycle, `pickReadyTasks` returns `[]` forever, `pickNextTask` keeps returning the same blocked task, and the loop either: (a) runs a dependency-violated task, or (b) hits iteration limit. There's no cycle detection.

5. **The `completedTasks.has(fallbackTask.id)` check at L525 is fragile**: It uses numeric `id` (assigned by parser position), but if the PRD is re-read between iterations, task IDs are re-assigned sequentially. Adding/removing lines could shift IDs, making the `completedTasks` set stale.

## Open Questions

1. **Can `markTaskComplete` fail silently?** If it writes to the wrong line (because tasks were reordered or the PRD was edited externally), a task could remain `Pending` in the PRD while being in `completedTasks` — the exact precondition for false AllDone.

2. **What happens when `pickNextTask` returns a dependency-blocked task in the fallthrough path?** The task gets executed without its dependencies — is this intentional as a "best effort" or an oversight?

3. **Should the fallback check `snapshot.remaining > 0` before emitting AllDone?** A simple guard `if (snapshot.remaining === 0)` before the AllDone yield would prevent the false completion regardless of latch state.

4. **Is there a scenario where `pickReadyTasks` returns empty on correctly-structured (non-circular) dependencies?** Yes — when tasks form a strict chain (A→B→C) and A isn't complete yet, both B and C are blocked, and A itself might be filtered out by `completedTasks.has()` if it was completed but PRD wasn't updated.
