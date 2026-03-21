# Research Report #9: Atomicity, Rollback, and Feature Branch Cleanup Requirements

## Research Question

What are the atomicity and rollback requirements — if the loop fails mid-PRD, what cleanup is needed for the feature branch, and does any existing pattern (circuit breaker, stagnation detector, yield) inform this?

---

## 1. Current Atomicity Model: Per-Task Atomic Commits

The loop already enforces per-task atomicity via `atomicCommit()` in [src/gitOps.ts](../../../src/gitOps.ts). Each completed task produces exactly one git commit with a structured message containing:

- Conventional commit prefix (`feat`/`fix`) scoped to `taskId`
- Full task description in the body
- `Task-Invocation-Id` for traceability
- Changed file list

**Key property**: If the loop fails between tasks, every completed task has a committed snapshot on whatever branch is current. Uncommitted work from the failing task is left as dirty working tree state.

**Pre-commit safety checks** (lines 60–73 of gitOps.ts):
- Refuses to commit during rebase, merge, or cherry-pick
- Does `git add -A` then checks `--cached --name-only` — if no staged changes, returns error (no empty commits)
- Uses `--no-verify` to skip hooks

**PRD write protection**: Before each commit, the orchestrator validates that PRD edits are limited to checkbox toggles, DECOMPOSED prefixes, and `depends` annotations. If the edit is rejected, the PRD is **reverted to the pre-task snapshot** (`fs.writeFileSync(prdPath, prdContentBeforeTask)`).

---

## 2. How the Loop Handles Failures — Five Exit Paths

The loop terminates via five distinct paths, each yielding a `LoopEvent`:

| Exit Path | Event Kind | Trigger | Branch State |
|---|---|---|---|
| **All tasks done** | `AllDone` | No more unchecked tasks | Clean — all tasks committed |
| **Max iterations** | `MaxIterations` | Iteration limit hit (after one auto-expansion attempt) | Partial — completed tasks committed, current task may have dirty state |
| **Stop requested** | `Stopped` | User calls `orchestrator.stop()` or abort signal fires | Same as max iterations |
| **Yield requested** | `YieldRequested` | User calls `requestYield()` — deferred until current task completes | **Clean** — yield only honored after `TaskCompleted` + commit |
| **Uncaught error** | Falls through `finally` block | Strategy throws unretriable error | Dirty — uncommitted changes possible |

**Critical observation**: `YieldRequested` is the **only graceful exit** that guarantees a clean branch state. All other non-completion exits may leave uncommitted work.

### From `orchestrator.ts` (lines 429–433):
```
finally {
    this.cleanup();
    this.state = LoopState.Idle;
}
```
The `cleanup()` method only disposes the PRD file watcher and linked cancellation source. It does **not** perform any git cleanup (no `git stash`, no `git reset`, no branch deletion).

---

## 3. Circuit Breaker Patterns and Their Failure Behavior

### 3.1 Circuit Breaker Chain (`circuitBreaker.ts`)

Five breakers, each returning an action:

| Breaker | Trips When | Action |
|---|---|---|
| `MaxRetriesBreaker` | `retryCount >= maxRetries` (default 3) | `stop` |
| `MaxNudgesBreaker` | `nudgeCount >= maxNudges` (default 3) | `stop` |
| `StagnationBreaker` | Consecutive nudges without file changes >= threshold | `skip` |
| `ErrorRateBreaker` | Error rate > 60% in sliding window of 5 | `stop` |
| `TimeBudgetBreaker` | Elapsed time exceeds budget (default 10 min) | `skip` |

**Actions**:
- `stop` → yields `Stopped` event, loop terminates
- `skip` → breaks out of the nudge loop, moves to next task (current task left incomplete)
- `continue` / `retry` → proceed normally

When a circuit breaker fires `stop`, the loop exits through the same `finally` block — **no branch cleanup**.

### 3.2 Stagnation Detector (`stagnationDetector.ts`)

Hashes `progress.txt` and `PRD.md` before/after each iteration. Three escalation tiers:

1. **Tier 1** (stale count == threshold): Injects nudge text ("try a different approach")
2. **Tier 2** (stale count == threshold+1): Fires circuit breaker with `skip` action, attempts dependency discovery (`analyzeMissingDependency`)
3. **Tier 3** (stale count == threshold+2): Yields `HumanCheckpointRequested` and pauses — waits for user to resume, skip, or stop

None of these tiers perform branch cleanup. They either skip the task (leaving it unchecked in the PRD) or pause for human intervention.

### 3.3 Struggle Detector (`struggleDetector.ts`)

Detects short iterations, no-progress streaks, and file thrashing. When triggered, it only injects context ("try a completely different approach") — no branch/git operations.

### 3.4 Auto-Decomposer

After `failThreshold` (default 3) consecutive failures for a single task, decomposes it into sub-tasks in the PRD. This is a **forward recovery** pattern — it modifies the PRD rather than rolling back.

---

## 4. What Happens to Uncommitted Work When the Loop Stops

**Current behavior**: Nothing. The loop's `finally` block only:
1. Resets `_currentTaskId` to empty string
2. Disposes the linked cancellation source
3. Sets state to `Idle`

There is **no git stash, reset, or checkout**. Uncommitted changes remain in the working tree.

**Session persistence**: The `SessionPersistence` class saves loop state to `.ralph/session.json` after each iteration and **clears it on terminal events** (AllDone, MaxIterations, Stopped, YieldRequested — line 427). This allows session resumption but doesn't address dirty git state.

---

## 5. Feature Branch Cleanup Requirements for New Feature Branch Enforcement

Given the loop's current architecture, a feature branch enforcement system should consider:

### 5.1 Branch Should NOT Be Deleted on Failure

**Rationale**:
- Per-task atomic commits mean completed work is preserved on the branch
- The branch contains valuable partial progress (committed tasks)
- Users may want to inspect, cherry-pick, or continue from where the loop stopped
- The `YieldRequested` pattern explicitly preserves branch state for user pick-up
- The `HumanCheckpointRequested` pattern pauses for user inspection — deletion would destroy context

### 5.2 Uncommitted Work Should Be Preserved

**Rationale**:
- The failing task may have useful partial edits (e.g., a test was written but not the implementation)
- Current behavior already leaves dirty state — adding `git stash` on failure would be a reasonable enhancement but not deletion
- The `SessionPersistence` system already expects resumability

### 5.3 Branch Should Be Usable After Yield

The yield system (`requestYield()`) is designed for **graceful interruption**:
- It sets `yieldRequested = true`
- The flag is only checked **after task completion and commit** (line 1278 in orchestrator.ts)
- This guarantees the branch is in a clean, committed state when yield fires

**Implication**: A feature branch created at loop start should remain intact and functional after yield.

### 5.4 Recommended Cleanup Strategy

Based on existing patterns, the cleanup model should be:

| Scenario | Branch Action | Working Tree |
|---|---|---|
| `AllDone` | Keep (merge candidate) | Clean (all committed) |
| `YieldRequested` | Keep (resume candidate) | Clean (committed before yield) |
| `Stopped` (user-initiated) | Keep (inspect/resume) | May have uncommitted — `git stash` recommended |
| `MaxIterations` | Keep (partial progress) | May have uncommitted — `git stash` recommended |
| `Error` (crash) | Keep (forensics) | May have dirty state |
| Session resume | Checkout existing branch | Load `.ralph/session.json` |

**The branch should never be auto-deleted.** Partial progress has value. The appropriate cleanup is:
1. On non-graceful exit: optionally `git stash` uncommitted work
2. On session persistence clear: record branch name for later reference
3. Let users manage branch lifecycle (delete, merge, rebase) manually

---

## 6. Patterns That Inform Feature Branch Design

### 6.1 `VerificationCache` Branch Awareness

The `VerificationCache` already tracks git branch via `getGitBranch()` (calling `git rev-parse --abbrev-ref HEAD`). Cache entries include the branch name and are invalidated on branch change. **This means the verification system already expects branch-level isolation.**

### 6.2 Session Persistence Workspace Isolation

`SessionPersistence` stores state per-workspace in `.ralph/session.json`, including:
- `workspacePath` (prevents cross-workspace contamination)
- `pid` (prevents concurrent sessions via `isPidAlive()` check)

**A feature branch name should be added to this session state** so that session resumption can verify it's still on the correct branch.

### 6.3 PRD Write Protection as Transaction Guard

The PRD write protection pattern (save before, validate after, revert on violation) is the closest analog to a rollback mechanism. It could be extended to protect branch state:
- Save branch name at loop start
- On loop exit, verify branch hasn't been switched externally
- If branch was switched (e.g., by user), warn rather than corrupt

---

## 7. Summary of Key Findings

1. **Per-task atomicity is already solid** — `atomicCommit()` ensures each completed task is a discrete commit
2. **No branch-level cleanup exists** — the loop has no git branch operations whatsoever
3. **Feature branches should never be deleted on failure** — partial progress (committed tasks) has value
4. **Yield is the model for graceful interruption** — it guarantees clean state by deferring until after commit
5. **Three systems already track branch state**: `VerificationCache.getGitBranch()`, `SessionPersistence`, and `atomicCommit()` — all can be extended
6. **The recommended pattern**: create feature branch at loop start, commit per task, stash on non-graceful exit, never auto-delete
7. **Session state should include branch name** for resumption integrity
