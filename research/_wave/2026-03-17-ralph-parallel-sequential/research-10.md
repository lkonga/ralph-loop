# Research 10: Atomic Git Commits in Parallel

**Question**: How do parallel atomic commits interact? Can they conflict? What happens when two parallel tasks both run `git add -A && git commit` at the same time?

## Findings

### 1. `atomicCommit()` Implementation — No Serialization

The full implementation lives in [src/gitOps.ts](src/gitOps.ts#L56-L96). The function performs five sequential steps:

1. **Verify committable state** (L59–67): Checks for `rebase-merge`, `rebase-apply`, `MERGE_HEAD`, `CHERRY_PICK_HEAD` in `.git/`. These are filesystem checks, not locks.
2. **`git add -A`** (L70): Stages ALL changes in the working tree — not just the current task's files.
3. **`git diff --cached --name-only`** (L75): Lists staged files.
4. **`git commit -m <message>`** (L82): Commits all staged changes.
5. **`rev-parse HEAD`** (L88): Captures the commit hash.

There is **no mutex, semaphore, lock, queue, or serialization mechanism** anywhere in `gitOps.ts`. Each call to `atomicCommit()` is an independent async function with no coordination with other callers.

### 2. Parallel Invocation Path — Inside `Promise.all`

In the orchestrator ([src/orchestrator.ts](src/orchestrator.ts#L536-L580)), parallel tasks are executed via:

```typescript
const parallelResults = await Promise.all(
    readyTasks.map(async (task) => {
        // ... execute task ...
        if (execResult.completed) {
            const pCommitResult = await atomicCommit(this.config.workspaceRoot, task, invId);
        }
    }),
);
```

Each parallel task calls `atomicCommit()` independently **after its own execution completes**. Since task execution times vary, commits are **unlikely to be exactly simultaneous** but **can overlap** — task A's `git add -A` could run while task B's `git commit` is mid-flight.

### 3. Git's Internal Lock File Mechanism (`.git/index.lock`)

Git itself provides a critical safety net. When `git add` or `git commit` runs, Git creates `.git/index.lock` as an exclusive lock file. If a second git operation tries to acquire the same lock concurrently, it **fails immediately** with:

```
fatal: Unable to create '.git/index.lock': File exists.
```

This means:
- Two concurrent `git add -A` calls → **one fails** with a lock error
- A `git add -A` during an in-flight `git commit` → **one fails**
- `atomicCommit()` wraps `execFile('git', ...)` which will return the error, caught by the `if (addResult.err)` / `if (commitResult.err)` guards

The error is caught and returned as `{ success: false, error: "git add failed: ..." }`. The orchestrator logs a warning but **does not retry**.

### 4. The Semantic Corruption Problem — `git add -A`

Even when commits don't literally overlap in time, there is a **semantic race condition**:

- Task A writes files `foo.ts` and `bar.ts`, finishes, calls `atomicCommit()`
- Task B writes file `baz.ts`, finishes slightly later, calls `atomicCommit()`
- If Task B's `git add -A` runs **before** Task A's `git commit`:
  - Task A's commit captures `foo.ts` + `bar.ts` + `baz.ts` (all three)
  - Task B's subsequent `git diff --cached --name-only` shows **nothing** — returns `{ success: false, error: "nothing to commit" }`

This creates **misattributed commits**: Task A's commit message says "feat(Task-A): ..." but includes Task B's changes. Task B's commit fails silently with "nothing to commit".

### 5. Single-Task Path Has the Same Pattern

The single-task path in [orchestrator.ts L989–L997](src/orchestrator.ts#L989-L997) also calls `atomicCommit()` identically, but since tasks run sequentially, the race condition doesn't apply there.

### 6. Test Coverage

[test/gitOps.test.ts](test/gitOps.test.ts) has 7 tests for `atomicCommit()` covering:
- Success path with hash capture
- Rebase/merge/cherry-pick in progress
- Nothing to commit
- Git commit failure
- Correct `add → diff → commit` ordering

There are **no tests for concurrent `atomicCommit()` calls**, and no tests verifying behavior under lock contention.

## Patterns

| Pattern | Present? | Details |
|---------|----------|---------|
| Mutex / semaphore | **No** | No serialization in `gitOps.ts` |
| Lock file check | **No** | Relies on git's internal `.git/index.lock` |
| Retry on lock failure | **No** | Error returned, logged as warning, not retried |
| Per-task staging | **No** | `git add -A` stages entire working tree |
| `git add <specific files>` | **No** | Always uses `-A` (all changes) |
| Error propagation | **Partial** | Failure logged + event emitted, no retry |

## Gaps/Concerns

1. **Race condition on `git add -A`**: The biggest issue. `git add -A` stages the *entire* working tree, so a fast-completing task can scoop up a slow task's files into its commit. This leads to misattributed commits and potential "nothing to commit" failures for subsequent tasks.

2. **No retry on git lock contention**: When `.git/index.lock` blocks a concurrent operation, `atomicCommit()` returns failure. The orchestrator logs a warning but does **not** retry. The changes from that task remain uncommitted.

3. **No serialization wrapper**: A simple async queue/mutex around `atomicCommit()` would eliminate both the lock contention and the mis-staging problems. E.g., `p-limit(1)` or a `Promise` chain would serialize commits.

4. **Commit message integrity**: Since `git add -A` can capture other tasks' files, the "Changed files" list in the commit message body (from `git diff --cached --name-only`) may include files from unrelated tasks.

5. **Lost commits on failure**: If `atomicCommit()` fails for a parallel task, the changes remain in the working tree but are never committed. There's no mechanism to re-attempt the commit later or roll back.

## Open Questions

1. **Is this race condition theoretical or observed?** In practice, task execution takes minutes (LLM round-trips), so commits are often naturally serialized by timing. The risk increases with fast-completing tasks or tasks that finish in quick succession.

2. **Should `atomicCommit` use `git add <specific-files>` instead of `git add -A`?** This would require tracking which files each task modified — information not currently captured by the execution strategy.

3. **Would a simple `p-limit(1)` or async mutex around commits fix all issues?** Yes — serializing just the `atomicCommit()` calls (not the task execution) would prevent both lock contention and cross-task staging while maintaining parallel task execution.

4. **Should the orchestrator retry failed commits?** A retry with exponential backoff (e.g., 100ms, 200ms, 400ms) would handle transient lock contention gracefully.
