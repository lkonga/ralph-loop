# Research Report: `atomicCommit` End-to-End Analysis

**Wave Researcher**: #2
**Question**: How does `atomicCommit` work end-to-end, and what assumptions does it make about the current branch?
**Date**: 2026-03-21

---

## 1. Function Signature & Location

**File**: `src/gitOps.ts`, lines 55–93

```ts
export async function atomicCommit(
  workspaceRoot: string,
  task: Task,
  taskInvocationId: string
): Promise<CommitResult>
```

Takes the workspace root path, a `Task` object (with `taskId` and `description`), and a task invocation UUID. Returns `{ success, commitHash?, error? }`.

---

## 2. End-to-End Flow

### Step 1: Guard — Verify Committable State (lines 57–65)

Checks for conflicting git operations by looking for sentinel files inside `.git/`:

| Sentinel File | Blocks With |
|---|---|
| `.git/rebase-merge` or `.git/rebase-apply` | `"Cannot commit: rebase in progress"` |
| `.git/MERGE_HEAD` | `"Cannot commit: merge in progress"` |
| `.git/CHERRY_PICK_HEAD` | `"Cannot commit: cherry-pick in progress"` |

**No other guards exist.** There is no check for:
- Current branch name (main, feature, detached HEAD)
- Whether the repo is in a dirty state from a prior failed commit
- Whether a push will follow

### Step 2: Stage Everything — `git add -A` (lines 67–70)

Stages **all** workspace changes indiscriminately:
- Tracked modifications
- Untracked new files
- Deletions

This is a blanket stage — there is no file filtering, no `.gitignore`-aware selection beyond what git itself handles, and no per-task scoping. If two parallel tasks produce changes, whichever calls `atomicCommit` first will vacuum up the other's unstaged changes.

### Step 3: Detect Changed Files — `git diff --cached --name-only` (lines 72–75)

Reads the staged diff to get a file list. If empty, returns `{ success: false, error: 'nothing to commit' }`. This list is used only for the commit message body, not for filtering.

### Step 4: Build Commit Message (lines 77–83)

Delegates to `buildCommitMessage(task, taskInvocationId, changedFiles)`:

1. **Type inference**: Scans `task.description` against `FIX_KEYWORDS` regex → picks `fix` or `feat`
2. **Subject line**: `{type}({taskId}): {description}` truncated to 72 chars
3. **Body** includes:
   - Full task description
   - `Task-Invocation-Id: {uuid}` trailer
   - Changed file list
   - Optional test summary (not currently passed by callers)

### Step 5: Commit — `git commit -m <message> --no-verify` (line 84)

Commits with `--no-verify`, **skipping all git hooks** (pre-commit, commit-msg, etc.). This is intentional for automation speed but means no linting/formatting hooks run.

### Step 6: Capture Hash — `git rev-parse HEAD` (lines 88–91)

Returns the new commit SHA for event reporting.

---

## 3. Callers in the Orchestrator

`atomicCommit` is called in exactly **two places** in `src/orchestrator.ts`:

### Caller A: Sequential Task Path (line 1270)

```
task execution → dual exit gate passes → review-after-execute → PRD write protection → atomicCommit
```

Called after a task completion is accepted through all gates. On failure, emits `LoopEventKind.Error` but **does not abort the loop** — execution continues to the next task.

### Caller B: Parallel Task Path (line 711)

```
parallel task execution → completion detected → PRD write protection → atomicCommit
```

Same pattern but inside a `Promise.all` for parallel execution. This is where the `git add -A` race condition is most dangerous — parallel tasks finishing near-simultaneously could stage each other's files.

Both callers:
- Log the commit hash to `progress.txt` on success
- Emit `LoopEventKind.TaskCommitted` event
- Treat commit failure as a **warning**, not a fatal error

---

## 4. Branch Assumptions

### Finding: `atomicCommit` is completely branch-agnostic

The function makes **zero assumptions** about which branch it operates on:

1. **No branch name check** — will happily commit to `main`, `develop`, a feature branch, or even a detached HEAD
2. **No branch protection** — nothing prevents committing directly to protected branches
3. **No push** — the function only creates local commits, never pushes
4. **No branch creation** — does not create or switch branches

### Branch awareness elsewhere

The only branch-aware code is in `VerificationCache.getGitBranch()` (`src/verificationCache.ts`, line 110), which reads the current branch via `git rev-parse --abbrev-ref HEAD` for **cache invalidation only** — it has no bearing on whether commits are allowed.

### Feature branch vs. main: Behavior is identical

| Scenario | Behavior |
|---|---|
| On `main` | Commits directly to main — no guard |
| On feature branch | Commits to feature branch — works fine |
| On detached HEAD | Commits succeed (git allows this) |
| During rebase | Blocked by sentinel file check |
| During merge | Blocked by sentinel file check |

---

## 5. Potential Issues for Feature Branch Enforcement

1. **`git add -A` vacuum**: Stages everything in the workspace. On a feature branch with work-in-progress files from other concerns, those get swept into the task commit. No task-scoped staging exists.

2. **`--no-verify` bypass**: Skips pre-commit hooks that might enforce branch naming conventions or commit message standards.

3. **No branch validation hook point**: There is no extension point where a branch policy could be injected before the commit happens. Any enforcement would need to be added either:
   - At the start of `atomicCommit` (cleanest)
   - In the orchestrator before calling `atomicCommit` (more context available)

4. **Parallel race condition**: Two parallel tasks calling `git add -A` and `git commit` near-simultaneously on the same repo could produce commits that include the wrong files. No locking mechanism exists.

5. **No rollback on partial failure**: If `git add -A` succeeds but `git commit` fails, the staged changes remain staged. No cleanup is performed.

---

## 6. Summary

`atomicCommit` is a simple, branch-agnostic, five-step function: guard against rebase/merge/cherry-pick → `git add -A` → detect changes → build conventional-commit message → commit with `--no-verify`. It operates on whatever branch HEAD points to without any validation. To enforce feature-branch-only commits, a branch check would need to be inserted at the top of the function or at the orchestrator call sites.
