# Research 2: Merge Conflict Prevention

**Question**: When parallel tasks edit overlapping files, what happens? Any file-level locking or conflict detection?

## Findings

### 1. No File-Level Locking Exists

There is **zero** file-level locking, mutex, semaphore, or advisory lock anywhere in the codebase. Searched across all `src/` files for `lock`, `mutex`, `semaphore`, `exclusive`, `concurrent write` — no matches in source code. The only references to locking appear in aspirational research documents ([research/12-detailed-source-analysis.md](../../12-detailed-source-analysis.md) L81: "Mutex-based locking when multiple loop instances operate on the same workspace" and [research/13-phase9-deep-research.md](../../13-phase9-deep-research.md) L421: "PID-based lock file or advisory locking") but these are design suggestions, not implementations.

### 2. No Conflict Detection Exists

There is no pre-flight check before parallel task execution to determine whether tasks might touch overlapping files. The `pickReadyTasks()` function ([src/prd.ts](../../../src/prd.ts#L106-L121)) selects tasks solely based on dependency resolution (DAG) — it has no awareness of which files a task might modify.

### 3. The Parallel Execution Path (`Promise.all`)

In [src/orchestrator.ts](../../../src/orchestrator.ts#L534-L582), when `useParallelTasks` is enabled and `readyTasks.length > 1`, all ready tasks execute concurrently via `Promise.all`:

```typescript
const parallelResults = await Promise.all(
    readyTasks.map(async (task) => {
        // ... each task independently:
        // 1. Reads PRD and progress files
        // 2. Builds prompt
        // 3. Executes via strategy (sends to Copilot)
        // 4. On completion, calls atomicCommit()
    }),
);
```

Each parallel task independently calls `atomicCommit()` ([src/orchestrator.ts](../../../src/orchestrator.ts#L560-L568)) upon completion. There is no coordination between concurrent commits.

### 4. `atomicCommit()` Is Not Actually Atomic Across Tasks

The `atomicCommit()` function ([src/gitOps.ts](../../../src/gitOps.ts#L57-L95)) performs a sequential series of git operations:
1. **L62-70**: Checks for rebase/merge/cherry-pick in progress (file existence checks)
2. **L73**: `git add -A` — stages **ALL** changes in the working tree
3. **L78**: `git diff --cached --name-only` — lists staged files
4. **L84**: `git commit -m ... --no-verify`
5. **L89**: `git rev-parse HEAD` — captures hash

**Critical issue**: `git add -A` stages **everything** in the working tree. When two parallel tasks call `atomicCommit()` concurrently:
- Task A's `git add -A` stages Task A's changes + any of Task B's in-progress changes
- Task B's `git add -A` may re-stage or interact with Task A's commit
- The first commit captures changes from both tasks; the second commit may find "nothing to commit"

### 5. Shared Mutable State: `progress.txt` and `PRD.md`

All parallel tasks write to the same files concurrently:

- **`appendProgress()`** ([src/prd.ts](../../../src/prd.ts#L136-L140)): Uses `fs.appendFileSync()` — Node.js synchronous append. Within a single Node.js process, synchronous writes are serialized by the V8 event loop between `await` points, but interleaving is still possible at line boundaries since each task hits multiple `appendProgress` calls separated by `await`s.

- **`markTaskComplete()`** ([src/prd.ts](../../../src/prd.ts#L125-L134)): Read-modify-write on PRD file with no locking. Two concurrent calls would cause one write to overwrite the other's changes (classic TOCTOU race). However, in the parallel path, `markTaskComplete()` is not called directly — completion is tracked via `this.completedTasks.add(task.id)` in-memory. The Copilot agent itself marks the checkbox in the PRD (via file edits during task execution), which creates self-correcting behavior but is not formally safe.

### 6. Execution Strategy Caveat

The `CopilotCommandStrategy` ([src/strategies.ts](../../../src/strategies.ts#L14-L34)) sends prompts to the local VS Code Copilot chat panel. In practice, **VS Code's chat panel is single-threaded** — it cannot actually run multiple agent sessions simultaneously. So the `Promise.all` dispatches N tasks, but VS Code likely serializes them through a single Copilot session. This effectively masks the concurrency bugs at the application level, though the git commit race remains because task B might complete before task A's `atomicCommit()` runs.

## Patterns

| Pattern | Location | Notes |
|---------|----------|-------|
| `git add -A` (global stage) | [gitOps.ts](../../../src/gitOps.ts#L73) | No per-task file scoping |
| `Promise.all` parallel dispatch | [orchestrator.ts](../../../src/orchestrator.ts#L534) | No coordination between tasks |
| `appendFileSync` for progress | [prd.ts](../../../src/prd.ts#L139) | Minimally safe within single process |
| Read-modify-write for PRD | [prd.ts](../../../src/prd.ts#L125-L134) | TOCTOU race with no protection |
| `atomicCommit` per parallel task | [orchestrator.ts](../../../src/orchestrator.ts#L560) | Sequential git ops, no inter-task lock |
| DAG-only scheduling | [prd.ts](../../../src/prd.ts#L106-L121) | No file-overlap awareness |
| Uncommittable state check | [gitOps.ts](../../../src/gitOps.ts#L62-L70) | Detects ongoing rebase/merge/cherry-pick only |

## Gaps/Concerns

### Critical

1. **`git add -A` captures cross-task changes**: When parallel tasks call `atomicCommit()`, each runs `git add -A` which stages ALL working tree changes — not just the files that specific task modified. Task A's commit may include Task B's partial changes. Task B then sees "nothing to commit".

2. **No file-overlap detection**: The system has no way to determine whether two parallel tasks will edit the same files. The PRD dependency system (`depends:`) is task-level, not file-level.

3. **Race between concurrent `atomicCommit()` calls**: Two git processes running `add` → `diff` → `commit` against the same repo simultaneously will produce unpredictable results. Git uses its own internal locking via `.git/index.lock`, so concurrent `git add` calls will fail with "Unable to create '.git/index.lock': File exists" — the second task's commit will fail entirely.

### Moderate

4. **No rollback on partial parallel batch failure**: If 2 of 3 parallel tasks commit successfully but the 3rd fails, there's no mechanism to revert the batch. The failed task's error is logged but the loop continues.

5. **Progress file interleaving**: Multiple parallel tasks call `appendProgress()` with `fs.appendFileSync()`. While individual appends are atomic at OS level for small writes, the logical ordering of progress entries may be confusing with interleaved timestamps.

### Low

6. **`markTaskComplete()` TOCTOU**: Classic read-modify-write with no lock. In practice mitigated because Copilot (not Ralph) marks checkboxes, but if two parallel tasks complete simultaneously and both try to mark checkboxes in the PRD, one write will silently drop the other.

## Mitigations That Could Help (Not Implemented)

- **Per-task file tracking**: Track which files each Copilot execution modified and only `git add` those specific files instead of `-A`
- **Sequential commit queue**: Serialize `atomicCommit()` calls through a queue/mutex, even when tasks execute in parallel
- **Git worktrees per parallel task**: Each parallel task operates in its own git worktree, merged after completion
- **File-set overlap detection in `pickReadyTasks()`**: If task metadata included expected file paths, the scheduler could avoid parallelizing tasks that touch the same files
- **Advisory file lock before `atomicCommit()`**: Use `.git/ralph.lock` advisory lock to serialize commit operations

## Open Questions

1. **Does VS Code's Copilot actually support concurrent sessions?** If `CopilotCommandStrategy` serializes execution through a single chat panel, the parallel `Promise.all` may be functionally sequential, accidentally preventing the worst race conditions. What happens when `openCopilotWithPrompt()` is called while another prompt is still executing?

2. **Has the `DirectApiStrategy` been tested with parallel execution?** The API-based strategy might truly allow concurrent LLM calls, making the git races real rather than theoretical.

3. **What happens to `.git/index.lock`?** If two `atomicCommit()` calls race, the second `git add -A` will encounter a lock file from the first. The error propagates as `git add failed: ...` and the commit is skipped — but the task's changes remain uncommitted and get swept into the next task's commit.

4. **Is there telemetry for parallel commit failures?** The `LoopEventKind.Error` is emitted but there's no specific event for "commit failed due to concurrent access" vs other commit failures.
