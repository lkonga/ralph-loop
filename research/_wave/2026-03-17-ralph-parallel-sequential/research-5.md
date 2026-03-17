# Research 5: Cycle Detection Gap

**Question**: How bad is the circular dependency problem? What happens in practice when circular deps exist?

## Findings

### 1. Dependency Resolution Mechanism

There are two task-selection functions in [src/prd.ts](src/prd.ts):

- **`pickNextTask()` (L103–105)**: Returns the first pending task in document order. **Completely ignores `dependsOn`**. Used for sequential mode (the default).
- **`pickReadyTasks()` (L107–122)**: DAG-aware. Builds a set of completed task descriptions (via `parseTaskId()`), then only returns pending tasks whose every `dependsOn` entry is in that set. Used only when `useParallelTasks=true && maxParallelTasks>1`.

The `depsmet` check at L119:
```typescript
const deps = task.dependsOn ?? [];
const depsmet = deps.every(dep => completedDescriptions.has(dep));
```

There is **zero cycle detection** anywhere in the codebase. No DFS, no Kahn's algorithm, no topological sort, no visited-set tracking.

### 2. Circular Dependency Behavior: Trace Analysis

**Scenario**: Task A depends on B, Task B depends on A (explicit `depends:` annotations).

#### In sequential mode (`pickNextTask`):
- **No impact**. `pickNextTask()` ignores `dependsOn` entirely — it returns the first pending task regardless. The cycle is invisible.
- This is the **default configuration**, so most users never encounter the problem.

#### In parallel mode (`pickReadyTasks`):
- **Silent deadlock**. Neither A nor B appears in `completedDescriptions`, so `depsmet` is `false` for both. `pickReadyTasks()` returns an empty array.
- The orchestrator ([src/orchestrator.ts](src/orchestrator.ts) L523–529) then falls back:
  ```typescript
  if (readyTasks.length === 0) {
      const fallbackTask = pickNextTask(snapshot);
      if (!fallbackTask || this.completedTasks.has(fallbackTask.id)) {
          yield { kind: LoopEventKind.AllDone, total: snapshot.total };
          return;
      }
      // Fall through to single-task execution below
  }
  ```
- `pickNextTask()` **will** find pending tasks (since it ignores deps), so execution falls through to single-task mode. The cycle **accidentally breaks** via this fallback, but:
  - No warning or log about the cycle
  - Dependencies are silently violated (a task executes before its declared dependencies complete)
  - The user gets no feedback that their dependency graph is invalid

**Edge case**: If ALL remaining tasks are in cycles AND all are already in `this.completedTasks` (the orchestrator's in-memory set), then `AllDone` fires prematurely with incomplete tasks. But this requires the in-memory set to already contain completed entries, which is unlikely for truly stuck tasks.

### 3. Can Indentation-Based Inference Create Cycles?

**No — indentation inference is structurally cycle-free.**

The inference algorithm ([src/prd.ts](src/prd.ts) L67–83) only looks **backward** (j from i-1 down to 0) for a parent with less indentation. This creates a strict tree structure where:
- Children always depend on a preceding parent
- A parent never depends on its children
- No forward references are possible

This is equivalent to building a tree from a depth-first pre-order traversal — cycles are impossible by construction.

**However**, cycles CAN arise from:
1. **Explicit `depends:` annotations** — user writes `depends: TaskB` on TaskA and `depends: TaskA` on TaskB
2. **Mixed explicit + inferred** — unlikely but possible if an explicit annotation references a descendant task's `parseTaskId()` output
3. **Transitive cycles** — A depends B, B depends C, C depends A (only via explicit annotations)

### 4. Identity Resolution: A Subtle Bug

`pickReadyTasks()` uses `parseTaskId(description)` to build the completed set (L108–110):
```typescript
const completedDescriptions = new Set(
    snapshot.tasks.filter(t => t.status === TaskStatus.Complete).map(t => parseTaskId(t.description)),
);
```

But `dependsOn` values come from two sources:
- **Explicit annotations**: Raw strings from `depends: task-name-1, task-name-2` regex
- **Indentation inference**: `parseTaskId()` output of the parent task (L77)

The `parseTaskId()` function (L9–13):
- If description starts with `**bold**`, extracts the bold text
- Otherwise: `task-${first30chars.replace(/\s+/g, '-').toLowerCase()}`

This means:
- Explicit `depends:` values must exactly match the `parseTaskId()` output of the target task
- If a user writes `depends: Setup database` but the task is `**Setup database schema**`, the dependency resolves against `Setup database schema` ≠ `Setup database` → **phantom unresolvable dependency** → task never becomes ready → silent hang (similar to cycle behavior)

### 5. Test Coverage

**Zero tests for cycle scenarios.** The test file [test/prd.test.ts](test/prd.test.ts) (143 lines) covers:
- Basic parsing (unchecked/checked tasks)
- Line number tracking
- Sequential taskId assignment
- `pickNextTask` (3 tests — basic selection, all complete, empty)
- DECOMPOSED marker skipping
- CHECKPOINT annotation

**Missing test coverage**:
- `pickReadyTasks()` — not tested at all (not even imported in test file)
- Dependency resolution — no tests for `dependsOn` behavior
- Indentation-based inference — no tests
- Circular dependencies — no tests
- Phantom dependencies (typos in `depends:`) — no tests
- Mixed explicit + inferred dependencies — no tests

## Patterns

| Pattern | Location | Behavior |
|---------|----------|----------|
| Cycle in sequential mode | `pickNextTask()` L103 | **Invisible** — deps ignored entirely |
| Cycle in parallel mode | `pickReadyTasks()` L107 | **Silent deadlock** → fallback to `pickNextTask()` breaks cycle without warning |
| Indentation inference | `parsePrd()` L67–83 | **Structurally cycle-free** — backward-only parent lookup |
| Explicit annotation cycle | `parseDependsOn()` L16 | **Possible** — no validation |
| Phantom dependency | `pickReadyTasks()` L119 | **Silent hang** — unresolvable dep treated like unmet dep |
| Fallback rescue | Orchestrator L523–529 | Parallel mode falls back to sequential, accidentally executing despite unmet deps |

## Gaps/Concerns

1. **No cycle detection at parse time**: `parsePrd()` builds a dependency graph but never validates it. A simple DFS/Kahn's check during the second pass would catch cycles immediately.

2. **No cycle detection at runtime**: `pickReadyTasks()` has no mechanism to distinguish "no tasks ready because deps aren't met yet" (normal) from "no tasks ready because of a cycle" (bug). Both return empty array.

3. **Silent fallback masks the problem**: The orchestrator's fallback from `pickReadyTasks()` → `pickNextTask()` means cycles in parallel mode don't crash — they silently violate the dependency contract. This is arguably worse than crashing, because:
   - The user thinks dependencies are being respected
   - Tasks execute in wrong order without any indication
   - Results may be subtly wrong

4. **Zero test coverage for the entire dependency system**: `pickReadyTasks`, dependency inference, and dependency resolution are completely untested.

5. **Identity resolution fragility**: The `parseTaskId()` ↔ `depends:` matching is string-based with no normalization beyond the bold-text extraction. Typos, case differences, or partial matches silently create phantom dependencies.

6. **No diagnostic tooling**: No command to visualize the dependency graph, detect cycles, or report unresolvable dependencies. Users have no way to validate their PRD's dependency structure.

## Severity Assessment

**Medium-High in parallel mode, Low in sequential mode.**

- Sequential mode (default): Cycles are invisible because `pickNextTask()` ignores all dependencies. No user-facing impact, but dependency annotations are decorative.
- Parallel mode: Cycles cause silent dependency violation via fallback. No crash, no hang, but wrong execution order. The "fix" (executing anyway) may produce incorrect results.
- The combination of "no validation + silent fallback + zero tests" means cycles can exist undetected in production PRDs indefinitely.

## Open Questions

1. **Should cycle detection be parse-time or runtime?** Parse-time (in `parsePrd()`) catches all cycles upfront but requires graph construction. Runtime (in `pickReadyTasks()`) can detect "stuck" states but can't distinguish cycles from slow-completing deps.

2. **What should happen when a cycle is detected?** Options: error the entire PRD parse, warn and remove one edge, warn and fall back to sequential for affected tasks, or let user choose.

3. **Is the `pickNextTask()` fallback intentional?** The orchestrator code (L523–529) doesn't comment on why it falls back. It may be a resilience measure or an oversight. If intentional, it should at least log a warning.

4. **Should `parseTaskId()` identity resolution be made robust?** Current string matching is fragile. Alternatives: use `taskId` (Task-001) as canonical reference, normalize strings, or use fuzzy matching.

5. **How many real-world PRDs have accidental cycles via explicit annotations?** Without a validator tool, there's no way to know. The indentation system is safe, but users writing `depends:` manually have no guardrails.
