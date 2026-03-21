# Research-1: Complete Git Workflow in ralph-loop

## Question

What is the complete git workflow in ralph-loop today — does any code create, switch, or manage branches?

## Findings

### Git Operations That EXIST

ralph-loop has exactly **two files** with git operations — both are read/commit-only:

#### 1. `src/gitOps.ts` — Atomic Commit Engine

The entire file is 93 lines. It provides three exports:

| Export | Purpose | Git Commands Used |
|--------|---------|-------------------|
| `runGit(workspaceRoot, args)` | Internal helper wrapping `child_process.execFile('git', ...)` with 10 MB buffer | (generic runner) |
| `inferCommitType(description)` | Regex classifier → returns `'feat'` or `'fix'` based on keywords | (no git) |
| `buildCommitMessage(task, invocationId, changedFiles, testSummary?)` | Builds conventional commit message string | (no git) |
| `atomicCommit(workspaceRoot, task, taskInvocationId)` | Full commit flow | See below |

**`atomicCommit` git commands (in order):**

1. Checks `.git/rebase-merge`, `.git/MERGE_HEAD`, `.git/CHERRY_PICK_HEAD` (filesystem, not git commands) — **safety guard only, no conflict resolution**
2. `git add -A` — stages everything
3. `git diff --cached --name-only` — lists staged files
4. `git commit -m "{message}" --no-verify` — commits with conventional commit message
5. `git rev-parse HEAD` — captures the new commit hash

**Notable**: Uses `--no-verify` to bypass user git hooks (intentional, to avoid conflicts with ralph's own hook system).

#### 2. `src/diffValidator.ts` — Diff State Inspector

| Function | Git Commands Used |
|----------|-------------------|
| `validateDiff(workspaceRoot, taskInvocationId)` | `git diff --stat HEAD`, `git diff --name-only HEAD` |

Used to detect whether code changes exist before/after task execution. Read-only — no mutations.

#### 3. `src/hookBridge.ts` — Pre-Compact Hook (Generated Script)

The generated `pre-compact-hook.js` script runs:
- `git diff --stat` and `git diff --name-only` — to inject diff summary into compact context

Also read-only.

### Where Git Operations Are Called

`atomicCommit` is called in exactly **two places** in `src/orchestrator.ts`:

1. **Sequential path** (line 1270): After task completion + dual-gate pass + optional review
2. **Parallel path** (line 711): After parallel task completion in `Promise.all` block

Both paths follow the same pattern: task completes → PRD write protection check → `atomicCommit` → log result → emit `TaskCommitted` event.

### Git Operations That DO NOT EXIST

**Branch management is completely absent.** Specifically, ralph-loop has:

| Operation | Status | Evidence |
|-----------|--------|----------|
| `git checkout` | **MISSING** | Zero occurrences in any `.ts` file |
| `git branch` | **MISSING** | Zero occurrences in any `.ts` file |
| `git switch` | **MISSING** | Zero occurrences in any `.ts` file |
| `git merge` | **MISSING** | Only checked as a safety guard (`MERGE_HEAD` exists?) |
| `git push` | **MISSING** | Zero occurrences in any `.ts` file |
| `git pull` | **MISSING** | Zero occurrences in any `.ts` file |
| `git fetch` | **MISSING** | Zero occurrences in any `.ts` file |
| `git rebase` | **MISSING** | Only checked as a safety guard (`rebase-merge` exists?) |
| `git stash` | **MISSING** | Zero occurrences in any `.ts` file |
| `git worktree` | **MISSING** | Zero occurrences in any `.ts` file |
| Branch creation | **MISSING** | No function creates branches |
| Branch switching | **MISSING** | No function switches branches |
| Branch name detection | **MISSING** | Never reads current branch name |
| Feature branch enforcement | **MISSING** | No check that user is on a non-main branch |

### Configuration

`RalphConfig` (in `src/types.ts`) has **zero branch-related settings**. No `branchPrefix`, no `createFeatureBranch`, no `targetBranch`, no `enforceBranch`. The config covers PRD paths, iteration limits, diff validation, bearings, backpressure, etc. — but nothing about git branching.

### Research References

Prior research within the ralph-loop repo confirms this gap:

- **`research/06-vinitm-ralph-loop-analysis.md`** (line ~160): Explicitly notes that vinitm's ralph-loop has git worktree isolation (`create_worktree()`, `merge_worktree()`, `cleanup_worktree()`) which "Our gap: We use fresh Copilot sessions per task but share the same working directory. No branch isolation."
- **`research/07-ralph-wiggum-playbook.md`** (section 15): Documents an "Enhancement: Ralph-Friendly Work Branches" proposal — user manually creates branch (`git checkout -b ralph/user-auth-oauth`), but this is a workflow suggestion, not implemented code.

### Summary

**ralph-loop's git workflow is commit-only**: `git add -A` → `git commit` on whatever branch the user happens to be on. There is no branch creation, switching, detection, or enforcement anywhere in the codebase. All commits go directly to the current HEAD. The system assumes the user has already set up the correct branch before running the loop.

## Confidence

**HIGH (95%)** — Exhaustive grep across all `.ts` files in `src/`, `cli/`, and `test/` for branch/checkout/switch/merge/push/pull/fetch/rebase/stash/worktree. Zero hits except for the known commit and diff operations documented above.
