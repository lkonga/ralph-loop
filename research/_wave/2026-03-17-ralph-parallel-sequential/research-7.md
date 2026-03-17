# Research 7: Sequential Mode Dependency Enforcement

**Question**: Sequential mode dependency enforcement: `pickNextTask` ignores `dependsOn` — trace the exact behavior, what breaks, what works. What is the actual sequential happy path today?

## Findings

### 1. The Two Task-Selection Functions

**`pickNextTask(snapshot)`** — [src/prd.ts L103–105](../../../src/prd.ts):
```typescript
export function pickNextTask(snapshot: PrdSnapshot): Task | undefined {
    return snapshot.tasks.find(t => t.status === TaskStatus.Pending);
}
```
Returns the **first pending task in file order**. No dependency checking whatsoever. Zero awareness of `dependsOn`.

**`pickReadyTasks(snapshot, maxTasks)`** — [src/prd.ts L107–123](../../../src/prd.ts):
Builds a `completedDescriptions` set from completed tasks (via `parseTaskId()`), then iterates pending tasks. A task is "ready" only if **every** entry in `task.dependsOn` appears in that completed set. This is the DAG-aware scheduler.

### 2. How the Orchestrator Chooses Between Them

[src/orchestrator.ts L516–598](../../../src/orchestrator.ts) — the decision tree:

```
if (useParallelTasks && maxParallelTasks > 1) {
    readyTasks = pickReadyTasks(snapshot, concurrencyCap)
    
    if (readyTasks.length === 0) {
        fallbackTask = pickNextTask(snapshot)   // ← FALLBACK: ignores deps
        if (!fallbackTask) → AllDone
        // else: fall through to single-task path
    } else if (readyTasks.length > 1) {
        // parallel execution, then continue
    }
    // if readyTasks.length === 1 → fall through to single-task path
}

// SINGLE-TASK PATH (used by both sequential default AND parallel fallback)
const task = pickNextTask(snapshot);  // ← ALWAYS ignores dependencies
```

**Critical observation**: Even the parallel mode's single-task fallthrough path calls `pickNextTask()`, not `pickReadyTasks()`. The only path where dependencies are actually enforced is when `readyTasks.length > 1` — i.e., when there are 2+ ready tasks for parallel execution.

### 3. Default Configuration = Sequential = No Dependency Enforcement

From [src/types.ts](../../../src/types.ts):
```typescript
// DEFAULT_FEATURES
useParallelTasks: false,

// DEFAULT_CONFIG
maxParallelTasks: 1,
```

Both are disabled by default. The `if (useParallelTasks && maxParallelTasks > 1)` guard at L516 evaluates to `false`, so the entire parallel block is skipped. Execution jumps directly to L598: `const task = pickNextTask(snapshot)`.

### 4. Concrete Scenario — What Breaks

Given this PRD:
```markdown
- [ ] **setup-db**: Create database schema
- [ ] **seed-data**: Populate test data (depends: setup-db)
- [x] **setup-db**: Create database schema    ← gets completed
- [ ] **seed-data**: Populate test data (depends: setup-db)
```

Wait — let's trace realistic scenarios:

**Scenario A — Linear PRD, no dependencies, sequential mode (DEFAULT)**:
```markdown
- [ ] Task A
- [ ] Task B
- [ ] Task C
```
`pickNextTask` returns Task A → completes → returns Task B → completes → returns Task C. **Works perfectly.** File order = execution order. No dependencies needed.

**Scenario B — Linear PRD WITH dependencies, sequential mode**:
```markdown
- [ ] **setup-db**: Create database schema
- [ ] **seed-data**: Populate test data (depends: setup-db)
```
`pickNextTask` returns `setup-db` (first pending) → completes → next iteration, re-parses PRD → `setup-db` is now `[x]` → `pickNextTask` returns `seed-data` (first pending). **Works correctly by accident** — file order naturally respects the dependency.

**Scenario C — Out-of-order dependencies, sequential mode (BREAKS)**:
```markdown
- [ ] **seed-data**: Populate test data (depends: setup-db)
- [ ] **setup-db**: Create database schema
```
`pickNextTask` returns `seed-data` first — its dependency `setup-db` hasn't been completed, but `pickNextTask` doesn't check. The task gets executed immediately with unmet dependencies. **This breaks.**

**Scenario D — Indented tasks, sequential mode (BREAKS subtly)**:
```markdown
- [ ] **auth-system**: Build auth
  - [ ] Login page
  - [ ] Session management
- [ ] **payments**: Build payments
```
The parser (second pass, L73–84) infers that "Login page" and "Session management" depend on `auth-system`. In sequential mode, `pickNextTask` returns `auth-system` first (correct by file order). But if `auth-system` were completed and then a new child task were inserted BEFORE it, `pickNextTask` would pick the child before its parent.

### 5. The Parallel Mode Fallback Has the Same Bug

At L524–528, when `readyTasks.length === 0` in parallel mode:
```typescript
const fallbackTask = pickNextTask(snapshot);
if (!fallbackTask || this.completedTasks.has(fallbackTask.id)) {
    yield { kind: LoopEventKind.AllDone, total: snapshot.total };
    return;
}
// Fall through to single-task execution below
```

This is a **deadlock escape hatch**: when all remaining tasks have unmet dependencies, `pickReadyTasks` returns empty, and the code falls back to `pickNextTask` which ignores dependencies. This means parallel mode can also execute tasks with unmet dependencies — it's just less likely because the path is only triggered when no tasks have met dependencies.

### 6. The Test Suite Confirms No Dependency Testing for `pickNextTask`

[test/prd.test.ts](../../../test/prd.test.ts) — `pickNextTask` tests (L78–94):
- Picks first pending task ✓
- Returns undefined when all complete ✓
- Returns undefined for empty PRD ✓

**No test verifies behavior with `dependsOn` tasks.** There is no test for `pickReadyTasks` at all in this file.

### 7. The Actual Sequential Happy Path Today

The sequential happy path works **if and only if** the PRD file lists tasks in topologically-sorted order (dependencies before dependents). Since most users write PRDs naturally top-to-bottom in dependency order, this works in practice:

1. User writes PRD with tasks in natural order (parent before child)
2. `pickNextTask` returns first pending → executes → marks complete
3. Next iteration re-parses PRD, finds next pending → executes
4. `dependsOn` annotations are parsed and stored but **never checked** in this path
5. The annotations serve as documentation only in sequential mode

The happy path is: **file-order execution with no dependency awareness**, accidentally correct when file order matches dependency order.

## Patterns

| Pattern | Location | Behavior |
|---------|----------|----------|
| Sequential task selection | `pickNextTask` prd.ts:103 | First pending in file order, no dep check |
| DAG-aware task selection | `pickReadyTasks` prd.ts:107 | Checks all deps against completed set |
| Orchestrator sequential path | orchestrator.ts:598 | Calls `pickNextTask` — never `pickReadyTasks` |
| Orchestrator parallel path | orchestrator.ts:516-595 | Uses `pickReadyTasks` but falls back to `pickNextTask` on empty |
| Default config | types.ts DEFAULT_CONFIG | `useParallelTasks: false`, `maxParallelTasks: 1` |
| Dependency inference | parsePrd second pass L66-84 | Indentation → implicit `dependsOn` parent task |
| Explicit dependencies | `parseDependsOn` prd.ts:16-21 | `depends: task-1, task-2` annotation parsing |

## Gaps/Concerns

1. **Silent dependency violation in sequential mode**: `dependsOn` is parsed, stored, and completely ignored. Users who add `depends:` annotations expect enforcement but get none. This is the default mode.

2. **Parallel mode deadlock fallback also ignores deps**: The `pickNextTask` fallback at L524 can force execution of dep-blocked tasks, defeating the purpose of the DAG scheduler.

3. **No test coverage for dependency enforcement**: Neither `pickNextTask` with deps nor `pickReadyTasks` has test coverage in the test suite.

4. **Why not just use `pickReadyTasks(snapshot, 1)` for sequential mode?** This would be the minimal fix — `pickReadyTasks` with `maxTasks=1` behaves as a dependency-aware `pickNextTask`. A task with no `dependsOn` (or `dependsOn: []`) always passes the dep check, so existing linear PRDs would work identically.

5. **The parallel fallback creates a hidden inconsistency**: In parallel mode with a deadlocked dependency graph, the system silently falls through to dependency-ignoring execution — the user gets no signal that dependencies were bypassed.

## Open Questions

1. **Is the `pickNextTask` fallback in parallel mode intentional?** It breaks the dependency contract but prevents deadlock. Should it emit a `DependencyBypassed` event instead of silently proceeding?

2. **Should `pickNextTask` be replaced with `pickReadyTasks(snapshot, 1)` globally?** This is a one-line change that fixes sequential mode. The only risk: if ALL remaining tasks have unmet circular dependencies, the system would emit `AllDone` with pending tasks remaining (silent deadlock). Need cycle detection too.

3. **Does any user-facing documentation promise dependency enforcement in sequential mode?** If not, the current behavior is technically correct (no contract violated) — but misleading since the parser clearly stores `dependsOn`.

4. **Are there real PRDs in the wild using out-of-order `depends:` annotations?** If no one writes `depends:` on a task that precedes its dependency in the file, the bug is latent and harmless (for now).
