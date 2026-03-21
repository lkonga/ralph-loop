# Research 3: How Ralph Handles Dirty Working Tree During Branch Operations

## Findings

### Branch Gate in Orchestrator (orchestrator.ts ~L600-640)

The branch enforcement gate runs once at loop startup, inside `runLoop()`. The logic:

1. **Already on expected branch** → log + `BranchValidated` event, continue.
2. **On a protected branch** (main/master):
   - If expected branch exists → `checkoutBranch(workspaceRoot, expectedBranch)` (plain `git checkout <branch>`)
   - If expected branch doesn't exist → `createAndCheckoutBranch(workspaceRoot, expectedBranch)` (plain `git checkout -b <branch>`)
   - On failure → yields `BranchEnforcementFailed` event with error string, **loop returns immediately** (aborts the entire run).
3. **On a non-protected branch** → proceed as-is, no checkout attempted.

### Raw Git Wrappers (gitOps.ts)

Both `createAndCheckoutBranch` and `checkoutBranch` are thin wrappers around `runGit`:

```typescript
// createAndCheckoutBranch: runs `git checkout -b <branchName>`
// checkoutBranch: runs `git checkout <branchName>`
```

**Neither function**:
- Runs `git stash` before checkout
- Passes `--force` or `-f` flag to checkout
- Checks for dirty/untracked/staged files beforehand
- Attempts any recovery on failure

They simply return `{ success: false, error: err.message }` if git exits non-zero.

### What Happens With a Dirty Working Tree

When there are uncommitted changes that conflict with the target branch:
- `git checkout <branch>` fails with: `error: Your local changes to the following files would be overwritten by checkout`
- `git checkout -b <branch>` succeeds in most cases (creating a new branch from current HEAD preserves dirty state), BUT fails if there's a conflicting situation (rare for `-b`).

**For `git checkout <existing-branch>`**, this is the **realistic failure path**: if the user has dirty changes that conflict with files on the target branch, the checkout will fail, the orchestrator yields `BranchEnforcementFailed`, and **the loop terminates immediately**. The user sees whatever error git emits, wrapped in the event.

**For `git checkout -b <new-branch>`**, this almost always succeeds because creating a new branch from HEAD keeps all working tree state. Dirty files carry over to the new branch.

### atomicCommit Behavior (gitOps.ts)

`atomicCommit` does:
1. **Branch guard**: refuses to commit on protected branches.
2. **State checks**: verifies no rebase/merge/cherry-pick in progress.
3. **`git add -A`**: stages ALL changes (tracked, untracked, deleted).
4. **`git diff --cached --name-only`**: checks if anything is staged.
5. **`git commit -m <message> --no-verify`**: commits everything.

Key points:
- Uses `git add -A` (not `git add .` — `-A` includes deletions and files above cwd).
- Commits **everything** in the working tree — no selective staging.
- The `--no-verify` flag skips pre-commit hooks.

### Test Coverage for Dirty State

**Zero test coverage for dirty working tree scenarios.** The test file `featureBranchE2E.test.ts` covers:
- Branch creation from protected branch ✓
- Commits landing on feature branch ✓
- Protected branch commit refusal ✓
- Session persistence with branch name ✓
- Branch mismatch detection ✓
- Resume on correct branch ✓
- Commit history isolation ✓
- Feature branch disabled backward compat ✓

**Not tested:**
- Dirty working tree when checkout happens
- Untracked files during branch switch
- Conflicting changes between branches
- Stash/restore behavior (doesn't exist)

## Patterns

| Aspect | Ralph Behavior |
|---|---|
| **Pre-checkout stash** | Not implemented — no stash anywhere in codebase |
| **Force checkout** | Not implemented — no `-f` flag |
| **Dirty tree check** | Not implemented — no pre-flight check |
| **Failure handling** | Hard stop — `BranchEnforcementFailed` terminates the loop |
| **atomicCommit staging** | `git add -A` — commits everything, no selective staging |
| **Commit hooks** | Bypassed via `--no-verify` |
| **New branch + dirty tree** | Works fine — `checkout -b` preserves dirty state |
| **Existing branch + dirty tree** | **Will fail** if changes conflict with target branch |

The pattern is: **fail-fast, no recovery**. If git complains, ralph stops.

## Applicability

This is a significant gap for real-world usage:

1. **Common scenario**: Developer has ralph running, edits a file manually, ralph tries to checkout → fails → loop dies.
2. **Resume scenario**: User stops ralph, makes manual changes, resumes → checkout to feature branch fails if files conflict.
3. **First run is safe**: `checkout -b` (new branch creation) preserves dirty state, so the initial branch creation from main works even with dirty files.

Potential mitigations (not implemented):
- **Pre-checkout stash**: `git stash push -u` before checkout, `git stash pop` after.
- **Dirty tree detection**: Check `git status --porcelain` before attempting checkout; warn user or auto-stash.
- **Force checkout**: Risky — would discard user changes.

## Open Questions

1. **Is the fail-fast intentional?** The code doesn't comment on why stash is omitted. Possible design choice: ralph assumes it owns the working tree.
2. **Should atomicCommit's `git add -A` be scoped?** It commits everything — including files the user may have edited manually outside ralph's task scope.
3. **What about `--no-verify` on commit?** This skips all pre-commit hooks (linting, formatting). Is this safe for all environments?
4. **Branch mismatch detection in SessionPersistence** exists but doesn't trigger stash — what's the intended recovery?
5. **Parallel task path** also calls `atomicCommit` without any working tree safety check — multiple parallel tasks could race on `git add -A`.
