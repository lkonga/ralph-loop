# Research 11: Fix Sequential Mode dependsOn

**Question**: What would it take to make sequential mode respect `dependsOn`? Could `pickNextTask` simply be changed to use `pickReadyTasks(snapshot, 1)`?

## Findings

### Current Implementation

**`pickNextTask`** (src/prd.ts L102–104) is a naive one-liner:
```ts
export function pickNextTask(snapshot: PrdSnapshot): Task | undefined {
    return snapshot.tasks.find(t => t.status === TaskStatus.Pending);
}
```
It returns the **first pending task by document order**, completely ignoring `dependsOn`. If task B depends on task A but appears first in the PRD, `pickNextTask` will select B even when A hasn't run.

**`pickReadyTasks`** (src/prd.ts L105–121) is dependency-aware:
```ts
export function pickReadyTasks(snapshot: PrdSnapshot, maxTasks: number = 1): Task[] {
    const completedDescriptions = new Set(
        snapshot.tasks.filter(t => t.status === TaskStatus.Complete).map(t => parseTaskId(t.description)),
    );
    const ready: Task[] = [];
    for (const task of snapshot.tasks) {
        if (task.status !== TaskStatus.Pending) { continue; }
        if (ready.length >= maxTasks) { break; }
        const deps = task.dependsOn ?? [];
        const depsmet = deps.every(dep => completedDescriptions.has(dep));
        if (depsmet) { ready.push(task); }
    }
    return ready;
}
```
It builds a set of completed task IDs (via `parseTaskId`), then only picks pending tasks whose dependencies are all satisfied. With `maxTasks=1`, it returns at most one task in an array.

### Drop-in Viability: `pickReadyTasks(snapshot, 1)[0]` vs `pickNextTask(snapshot)`

**Return type compatibility**: ✅ Both resolve to `Task | undefined` (`[0]` on empty array yields `undefined`).

**Behavioral equivalence for tasks without `dependsOn`**: ✅ When no task has `dependsOn`, `deps` defaults to `[]` and `[].every(...)` is vacuously `true`, so every pending task passes. Document order is preserved because both iterate `snapshot.tasks` in order. The result is identical to the naive `.find()`.

**Behavioral difference for tasks with `dependsOn`**: This is the **entire point** — `pickReadyTasks` will skip tasks whose deps aren't met, while `pickNextTask` blindly picks the first pending one. This is the bug being fixed.

**Conclusion**: `pickReadyTasks(snapshot, 1)[0]` is a safe, semantics-preserving drop-in for the dependency-unaware case and a strict improvement for the dependency-aware case.

### Call Sites in orchestrator.ts

There are **3 call sites** for `pickNextTask` in `src/orchestrator.ts`:

| Line | Context | Replacement Strategy |
|------|---------|---------------------|
| L494 | `peekTask = pickNextTask(peekSnapshot)` — iteration-limit expansion check. Peeks to see if any task remains before expanding the iteration limit. | Replace with `pickReadyTasks(peekSnapshot, 1)[0]`. This is actually more correct — it avoids expanding limits for a task that can't run yet due to unmet deps. |
| L524 | `fallbackTask = pickNextTask(snapshot)` — fallback when parallel `readyTasks` is empty. Checks if genuinely done or if there's a straggler. | Replace with `pickReadyTasks(snapshot, 1)[0]`. Same logic — if no ready tasks exist even with `maxTasks=1`, then truly AllDone. **However**, there's a subtle concern: this fallback currently finds tasks that parallel mode might have skipped due to unmet deps; replacing it means it will also skip those, which could cause premature `AllDone` if deps are never satisfiable (e.g., circular deps). But this is actually the correct behavior — if deps can't be satisfied, the task shouldn't run. |
| L596 | `task = pickNextTask(snapshot)` — the main sequential-mode task picker. This is the primary fix target. | Replace with `pickReadyTasks(snapshot, 1)[0]`. |

### Simplification Opportunity

Rather than replacing all 3 call sites, `pickNextTask` itself could be **redefined** as:
```ts
export function pickNextTask(snapshot: PrdSnapshot): Task | undefined {
    return pickReadyTasks(snapshot, 1)[0];
}
```
This is a **1-line change** at src/prd.ts L103 that fixes all 3 call sites automatically. No orchestrator changes needed.

## Patterns

- **Separation of concerns**: `parsePrd` handles parsing + dependency inference (indentation-based + explicit `depends:` annotation). `pickReadyTasks` handles DAG-aware selection. `pickNextTask` is the naive escape hatch — likely a leftover from before `dependsOn` was implemented.
- **Dependency resolution uses description-based IDs** (`parseTaskId`), not numeric task IDs. `parseTaskId` extracts bold-wrapped IDs (`**TaskName**`) or falls back to a slugified prefix. This means `dependsOn` values must match the `parseTaskId` output of the dependency.
- **Indentation-based dep inference** (prd.ts L69–78): Sub-tasks automatically inherit a `dependsOn` on their parent unless they have an explicit annotation.

## Gaps/Concerns

1. **Deadlock risk**: If `dependsOn` references a task that doesn't exist or creates a cycle, `pickReadyTasks` will never return that task. With the current `pickNextTask`, it would just run in order regardless. After the fix, such tasks would be permanently stuck. **Mitigation**: This is arguably correct behavior — running a task with unsatisfied deps is worse than blocking. But a deadlock detector (checking if remaining > 0 but readyTasks is empty) would be a good follow-up.

2. **Existing test impact**:
   - `test/prd.test.ts` has **3 tests** for `pickNextTask` (L79–96). None of them use `dependsOn` in their fixtures, so all 3 will **continue to pass unchanged** since `pickReadyTasks(snapshot, 1)[0]` behaves identically when no deps exist.
   - `test/parallelMonitor.test.ts` tests `pickReadyTasks` with no `dependsOn` in fixtures — also unaffected.
   - **No existing test covers a scenario where `pickNextTask` is called with `dependsOn` tasks** — this is the gap that should be filled with a new test.

3. **Fallback at L524**: Currently, when parallel mode's `readyTasks` is empty, it falls back to `pickNextTask` which ignores deps. After the fix, it will also respect deps, which means a task with unmet deps will trigger `AllDone` instead of being forced through. This is more correct but is a behavior change worth noting in a PR description.

4. **Performance**: Negligible. `pickReadyTasks` does one extra pass to build the completed set, but task lists are small (typically <100 tasks).

## Estimated Fix Scope

| File | Change | Lines |
|------|--------|-------|
| `src/prd.ts` L103 | Redefine `pickNextTask` body to `return pickReadyTasks(snapshot, 1)[0];` | **1 line** |
| `test/prd.test.ts` | Add 2–3 test cases: (1) `pickNextTask` skips task with unmet dep, (2) `pickNextTask` returns task when deps are met, (3) returns `undefined` when all pending tasks have unmet deps | **~25 lines** new |

**Total: ~1 line production code + ~25 lines test code.**

## Open Questions

1. **Should the function be deprecated?** If `pickNextTask` is now just `pickReadyTasks(snapshot, 1)[0]`, should it be removed entirely and call sites updated to use `pickReadyTasks` directly? Keeping the wrapper is cleaner for readability at call sites.
2. **Deadlock detection**: Should a follow-up add detection for "remaining tasks > 0 but nothing is ready" (indicating unresolvable deps)?
3. **Circular dependency detection**: `parsePrd` doesn't validate the dep graph. Should it warn on cycles?
4. **L524 fallback behavior change**: Should the parallel-mode fallback remain as `pickNextTask` (now dep-aware) or be replaced with an explicit "truly nothing left" check that distinguishes "all done" from "blocked on deps"?
