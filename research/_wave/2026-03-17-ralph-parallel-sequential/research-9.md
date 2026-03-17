# Research 9: Parallel→Sequential Fallback Analysis

**Question**: The fallback from parallel→sequential: When `pickReadyTasks` returns empty, the fallback to `pickNextTask` — is this intentional design (safety net) or accidental (bug)?

## Findings

### The Code Structure (orchestrator.ts L516–598)

The parallel task selection block has a three-way branch:

```
if (useParallelTasks && maxParallelTasks > 1) {
    readyTasks = pickReadyTasks(snapshot, cap).filter(not-completed)

    if (readyTasks.length === 0) {
        fallbackTask = pickNextTask(snapshot)     // ← THE FALLBACK
        if (!fallbackTask || completed) → AllDone
        // else: Fall through to single-task execution below
    } else if (readyTasks.length > 1) {
        // parallel execution, then `continue`
    }
    // readyTasks.length === 1 → implicit fall-through
}

const task = pickNextTask(snapshot)  // ← single-task path (L598)
```

### The Semantic Gap Between `pickReadyTasks` and `pickNextTask`

The two functions have **fundamentally different selection criteria**:

| Function | Criteria | Considers Dependencies |
|---|---|---|
| `pickReadyTasks` (prd.ts L106) | Pending + all `dependsOn` deps completed (matched by `parseTaskId` description) | **Yes** |
| `pickNextTask` (prd.ts L102) | First task with `status === Pending` | **No** |

This means `pickReadyTasks` can return empty (all pending tasks have unmet dependencies) while `pickNextTask` returns a task (it finds the first pending task regardless of dependencies).

### When Does This Divergence Trigger?

The scenario: all remaining pending tasks have `dependsOn` annotations, and none of their dependencies are satisfied. `pickReadyTasks` correctly returns `[]` (nothing is safe to run), but `pickNextTask` happily returns the first pending task, which has unmet dependencies.

The fallback then **falls through to the single-task execution path** at L598, which calls `pickNextTask(snapshot)` again — effectively ignoring the DAG and running a dependency-blocked task.

### The Comment Trail

Two comments exist in the code:
1. `// Fall through to single-task execution below` (L529) — after the fallback check fails to reach AllDone
2. `// If only 1 ready task, fall through to single-task path` (L596) — after the `readyTasks.length > 1` block

Comment #1 is the critical one. It explicitly acknowledges the fall-through as intentional behavior. The author knew that when `readyTasks` is empty but `pickNextTask` finds something, execution should continue via the single-task path.

### PRD Task Description Analysis

PRD Task (line 107): *"modify `pickNextTask` to return ALL tasks whose dependencies are met (not just the first one)"*

The PRD instructed modifying `pickNextTask` itself, but the implementation created a **separate** function `pickReadyTasks` instead, leaving the original `pickNextTask` untouched as a dependency-unaware selector. This architectural decision preserved backward compatibility but created the semantic gap that enables the fallback.

### The Three Branches Summarized

| readyTasks count | Behavior | DAG-respecting? |
|---|---|---|
| 0 (all blocked) | Fallback to `pickNextTask` → runs blocked task sequentially | **No** — violates DAG |
| 1 (exactly one ready) | Falls through to `pickNextTask` → runs first pending (might be different task!) | **Partially** — coincidental |
| >1 (multiple ready) | Parallel execution of all ready tasks | **Yes** |

### The `readyTasks.length === 1` Path Has a Separate Bug

When exactly 1 task is DAG-ready, the code falls through to `const task = pickNextTask(snapshot)` at L598. But `pickNextTask` returns the **first** pending task, which may not be the same as the one `pickReadyTasks` selected. If a task earlier in the list is pending but dependency-blocked, `pickNextTask` picks that blocked task instead of the DAG-ready one.

## Patterns

### Intentional Safety Net, Not a Bug

The fallback is **intentionally designed as a safety net** based on three observations:

1. **Explicit comment**: The `// Fall through to single-task execution below` comment proves the author considered this path and chose to allow it rather than blocking.

2. **Conservative design philosophy**: Rather than halting the loop when DAG resolution finds no ready tasks (which could strand the orchestrator in a deadlock if dependency annotations are wrong), the fallback degrades to sequential execution. This is a "progress over correctness" tradeoff.

3. **The AllDone guard**: The fallback checks `pickNextTask` before falling through — if even that returns nothing, it correctly emits `AllDone`. It only falls through when there genuinely are pending tasks, preferring to run them out-of-order over not running them at all.

### However, It Masks Real Problems

While intentional, the fallback has a **design smell**: it silently degrades from DAG-aware to DAG-ignorant execution without logging or emitting an event. There is no `LoopEventKind.DagFallback` or warning log. The user has no way to know that dependency ordering was violated.

## Gaps/Concerns

1. **Silent DAG violation**: When the fallback triggers, no event or log indicates that dependency ordering was bypassed. This makes debugging task ordering issues nearly impossible.

2. **The `readyTasks.length === 1` path picks the wrong task**: When exactly one task is DAG-ready, it falls through to `pickNextTask` which may select a different (dependency-blocked) task. This is likely a bug, not intentional.

3. **No test coverage**: Neither `orchestrator.test.ts` nor `prd.test.ts` test the fallback path, the `readyTasks.length === 1` case, or the divergence between `pickReadyTasks` and `pickNextTask`.

4. **`pickNextTask` was supposed to be modified per the PRD** but was left unchanged. The PRD said *"modify `pickNextTask` to return ALL tasks whose dependencies are met"* — instead, a new function was created alongside it. The old function remains as a dependency-unaware escape hatch.

5. **Potential infinite loop**: If a task is dependency-blocked and the single-task path runs it but it fails (because its deps aren't done), it will be retried on the next iteration, and `pickReadyTasks` will again return empty, and the fallback will again pick the same blocked task — creating a retry loop that never makes progress.

## Open Questions

1. **Should the `readyTasks.length === 1` branch use the specific ready task directly** instead of falling through to `pickNextTask`? This seems like an oversight that could cause the wrong task to execute.

2. **Should the fallback emit a warning event** (e.g., `LoopEventKind.DagFallbackTriggered`) so operators know dependency ordering was bypassed?

3. **Was the decision to keep `pickNextTask` unchanged (contrary to PRD direction) documented anywhere?** Or was it an expedient choice during implementation?

4. **Is there a scenario where dependency deadlock (circular deps or all-blocked) should halt the loop** rather than falling back to sequential? The current design prefers progress, but this may mask PRD authoring errors.
