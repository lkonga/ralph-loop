# Research 4: Pre-flight Parallel Safety

**Question**: Is there any analysis/verification before dispatching parallel tasks to ensure they won't conflict (e.g. file-overlap detection, workspace partitioning, task scope analysis)?

**Date**: 2026-03-17  
**Sources**: `src/orchestrator.ts`, `src/prd.ts`, `src/types.ts`, `src/gitOps.ts`, `src/consistencyChecker.ts`, `src/diffValidator.ts`

---

## Findings

### 1. The Complete Code Path: Selection → Dispatch

The parallel dispatch path lives in `orchestrator.ts` L516–575. Here is every operation between "tasks selected" and "`Promise.all` fired":

```
L512: snapshot = readPrdSnapshot(prdPath)           // Parse PRD
L516: if (useParallelTasks && maxParallelTasks > 1)  // Gate: parallel mode?
L517-519: concurrencyCap = ...                       // Pick cap value
L520-521: readyTasks = pickReadyTasks(snapshot, cap) // DAG frontier
              .filter(t => !completedTasks.has(t.id)) // Exclude already-done
L523-527: if (readyTasks.length === 0) → fallback    // Empty? Try sequential
L530: else if (readyTasks.length > 1)                // Multiple ready?
L531:   yield TasksParallelized event                // Emit event
L532:   iteration++                                  // Bump counter
L534:   Promise.all(readyTasks.map(async (task) => { // DISPATCH — no further checks
```

**There are exactly ZERO checks between `pickReadyTasks()` returning and `Promise.all()` dispatching.** The only filtering is:
1. DAG dependency satisfaction (`pickReadyTasks`)
2. Completed-task deduplication (`.filter(t => !this.completedTasks.has(t.id))`)

### 2. What `pickReadyTasks()` Actually Checks (prd.ts L106–120)

```typescript
function pickReadyTasks(snapshot, maxTasks): Task[] {
  const completedDescriptions = new Set(
    snapshot.tasks.filter(t => t.status === Complete).map(t => parseTaskId(t.description))
  );
  const ready = [];
  for (const task of snapshot.tasks) {
    if (task.status !== Pending) continue;
    if (ready.length >= maxTasks) break;
    const deps = task.dependsOn ?? [];
    const depsmet = deps.every(dep => completedDescriptions.has(dep));
    if (depsmet) ready.push(task);
  }
  return ready;
}
```

This checks **only** dependency satisfaction. It does NOT analyze:
- Task descriptions for overlapping file targets
- Workspace partitioning or scope
- Whether tasks might modify the same files
- Whether tasks have conflicting requirements

### 3. Safety Mechanisms That Do Exist (But Not as Pre-flight)

| Mechanism | Location | When It Runs | Parallel-Aware? |
|-----------|----------|--------------|-----------------|
| **Bearings check** (tsc + vitest) | `orchestrator.ts` L636–660 | Before **single-task** execution only | ❌ Skipped entirely in parallel path |
| **Circuit breaker chain** | `orchestrator.ts` L478–490 | Before each iteration's task pick | ❌ Checks elapsed time/errors, not task conflicts |
| **Diff validator** | `diffValidator.ts` | After task execution (post-hoc) | ❌ Per-task, no cross-task awareness |
| **Consistency checker** | `consistencyChecker.ts` | Post-execution (when wired) | ❌ Checks PRD checkbox state, not file overlap |
| **Parallel monitor** | `orchestrator.ts` L170–210 | During single-task execution (stale detection) | ❌ Not started in the parallel `Promise.all` path |
| **Atomic git commits** | `gitOps.ts` L55–96 | After each parallel task completes | ⚠️ Race condition: `git add -A` + `git commit` without locks |

### 4. Critical Observation: Bearings Bypass

The bearings pre-flight check (which runs `tsc` and `vitest` to verify workspace health) is positioned at L636 in the single-task path — **after** the parallel branch has already `continue`d back to the top of the while loop. This means:

- **Single-task path**: Bearings → prompt → execute → verify (safe)
- **Parallel path**: pickReadyTasks → Promise.all → execute all → countdown → next batch (NO bearings)

### 5. Atomic Commit Race Condition

In the parallel path, each task independently calls `atomicCommit()` after completion (L555–562). This function:
1. Calls `git add -A` (stages ALL changes, not just the task's changes)
2. Calls `git diff --cached --name-only` (gets staged files)
3. Calls `git commit -m ...`

When two parallel tasks complete near-simultaneously, Task A's `git add -A` will stage Task B's uncommitted changes, and vice versa. There is no file-level isolation, no lock, and no worktree separation.

### 6. Grep Verification

Searched the entire `src/` directory for: `preflight`, `verify`, `pre-flight`, `safety`, `dispatch`, `conflict`, `overlap`, `partition`, `file.*target`, `workspace.*partition`, `task.*scope`, `conflict.*detect`. **Zero matches** for any conflict-detection or scope-analysis pattern.

---

## Patterns

1. **Trust-the-DAG pattern**: The system assumes that if dependencies are satisfied, tasks are safe to run concurrently. No content-level analysis.
2. **Post-hoc validation only**: All verification (diff, consistency, bearings) happens after execution, never before parallel dispatch.
3. **Shared-everything architecture**: All parallel tasks share the same workspace directory, the same PRD file, the same progress file, and the same git repository — with no isolation boundaries.
4. **Fire-and-forget fan-out**: `Promise.all` dispatches all tasks simultaneously with no staggering, no resource-awareness, and no conflict pre-check.

---

## Gaps/Concerns

1. **No file-overlap detection**: Two tasks targeting the same source file (e.g., both editing `src/types.ts`) will create write conflicts with no warning or prevention.
2. **No workspace partitioning**: No mechanism to assign tasks to isolated directories, worktrees, or sandboxes.
3. **No task scope analysis**: Task descriptions are natural language — there's no extraction of target files or scopes before dispatch to compare for overlap.
4. **Bearings check skipped for parallel batches**: The pre-flight health check (TypeScript compilation + test execution) only gates single-task execution.
5. **Git race condition**: Concurrent `atomicCommit()` calls on the same repository without locking can create commits that bundle changes from multiple tasks.
6. **Shared mutable state**: `progress.txt` is appended to concurrently by multiple tasks (via `appendProgress`), and `PRD.md` is read concurrently (but `markTaskComplete` is called sequentially after `Promise.all` resolves — in the parallel path, completion is marked within each task's closure, creating a race).
7. **Monitor not started**: The `startMonitor()` function for stale-task detection runs only in the single-task path (L698), not in the parallel `Promise.all` closure.

---

## Open Questions

1. **Is file-overlap even possible to detect?** Tasks are natural-language descriptions sent to Copilot — the orchestrator doesn't know which files Copilot will touch until after execution. Pre-flight detection would require either (a) LLM-based scope prediction, or (b) restricting tasks to explicitly declare their target files.
2. **Would git worktrees solve isolation?** Each parallel task could operate in its own worktree, with a merge step after completion. This would eliminate both the git race and the file-conflict issue.
3. **Should bearings run before parallel batches?** A single bearings check before dispatching the batch would at least verify the workspace is healthy before fan-out.
4. **Is `appendProgress` append-safe?** Node.js `fs.appendFileSync` is documented as atomic on most OS/filesystem combinations, but concurrent appends from the same event loop (via `Promise.all`) may interleave if the writes exceed a single kernel buffer.
5. **Does the `consistencyChecker.extractFilePaths()` function (L56–59) hint at a planned pre-flight?** It parses file paths from task descriptions — this could be repurposed as a pre-dispatch overlap detector, but it's currently only used post-execution.
