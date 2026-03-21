# Research: Happy Paths vs Adversarial Scenarios — Branch Enforcement Use Case Map

## Findings

### Happy Paths (all tested and working)

#### HP1: Start on main → branch created
**Code path**: `orchestrator.ts` L601-635 (branch enforcement gate)
- Reads PRD title via `parsePrdTitle()`, derives `ralph/<slug>` via `deriveBranchName()`
- Detects current branch is in `protectedBranches` list → creates or checks out `ralph/<slug>`
- Yields `BranchCreated` event, sets `this.activeBranch`
- **Tested**: `featureBranchE2E.test.ts` L66-98 — real git repo, verifies branch switch + event + main untouched

#### HP2: Resume on correct branch
**Code path**: `orchestrator.ts` L609-610 — `currentBranch === expectedBranch` → logs + yields `BranchValidated`
- Session persistence stores `branchName` on each iteration (L1482-1490)
- On resume, startup gate re-derives expected branch from PRD title and checks current branch
- **Tested**: `featureBranchE2E.test.ts` L207-236 — creates branch, switches back to main, starts orchestrator → ends up on feature branch

#### HP3: Disabled → no-op
**Code path**: `orchestrator.ts` L603 — `if (featureBranchConfig?.enabled)` gate skips entire block
- No branch events, no branch switching, commits go to whatever branch the user is on
- **Tested**: `featureBranchE2E.test.ts` L325-368 — verifies stays on main, no branch events, commits succeed on main

#### HP4: Already on expected branch → proceed
**Code path**: `orchestrator.ts` L609-612 — exact match → `BranchValidated` event, no branch switch
- **Tested**: implicitly in resume test; also the second run would hit this path

#### HP5: On non-protected, non-expected branch → proceed
**Code path**: `orchestrator.ts` L633-635 — logs "on non-protected branch, proceeding"
- Sets `activeBranch` to current branch, no switching
- **Tested**: not directly tested in E2E (only unit-level configuration tests exist)

### Adversarial Scenarios

#### ADV1: User switches branch mid-loop (e.g., `git checkout main` in another terminal)
**Code path**: Branch gate fires **once** at startup (L601). No re-validation during the task loop.
- `atomicCommit` in orchestrator is called **without** `protectedBranches` option (both L752 and L1315), so the per-commit guard is dead code from orchestrator context
- **Outcome**: Commits silently land on whatever branch the user switched to, including protected branches
- **Tested**: NO — research-3.md identified this gap; no test covers mid-loop branch drift
- **Severity**: HIGH — violates the core safety invariant

#### ADV2: PRD title changes between runs → different slug → orphan branch
**Code path**: `deriveBranchName()` in `prd.ts` L22-30 — deterministic slug from title
- If PRD title changes from "My Feature" to "My Feature v2", the derived branch changes from `ralph/my-feature` to `ralph/my-feature-v2`
- The startup gate creates a new branch; the old `ralph/my-feature` branch with its commits is abandoned
- Session persistence stores old `branchName`, but the gate re-derives from PRD content, not from session data
- **Outcome**: Orphan branch left behind, work split across two branches, no warning emitted
- **Tested**: NO — no test covers title mutation between runs
- **Severity**: MEDIUM — data loss risk (orphan branch with uncommitted work context)

#### ADV3: Worktree usage (git worktree)
**Code path**: All git operations use standard `git` CLI via `execFile('git', args, { cwd: workspaceRoot })`
- `getCurrentBranch()` uses `git rev-parse --abbrev-ref HEAD` — works correctly in worktrees
- `createAndCheckoutBranch()` uses `git checkout -b` — works in worktrees
- `branchExists()` uses `git rev-parse --verify refs/heads/<name>` — checks the shared ref store, works
- `.ralph/session.json` is stored at `workspaceRoot` level — inside the worktree directory, not shared
- **Outcome**: LIKELY WORKS — git commands are worktree-aware by default. Session files are per-worktree (good isolation)
- **Tested**: NO — zero worktree tests exist
- **Severity**: LOW — likely correct by accident, but unverified

#### ADV4: Shallow clone
**Code path**: No code checks for shallow clone status (`--depth` flag)
- Branch creation (`checkout -b`) works in shallow clones
- `atomicCommit` uses standard git add/commit — works in shallow clones
- `branchExists` checks `refs/heads/` — works
- **Outcome**: LIKELY WORKS — no operations require full history
- **Tested**: NO
- **Severity**: LOW — the feature branch workflow doesn't need history depth

#### ADV5: Submodules
**Code path**: `git add -A` in `atomicCommit` (gitOps.ts L85) stages submodule pointer changes
- No submodule-specific handling exists
- `deriveBranchName` operates on PRD content, not git structure — unaffected
- Branch operations are on the parent repo only
- **Outcome**: WORKS for parent repo. Submodule state changes are committed as pointer updates. No cross-submodule branch coordination
- **Tested**: NO
- **Severity**: LOW — standard git behavior handles this implicitly

#### ADV6: Repo with no main/master (e.g., trunk, develop, or custom default)
**Code path**: `protectedBranches` defaults to `['main', 'master']` (orchestrator.ts L608, types DEFAULT_CONFIG)
- If the repo's default branch is `develop` or `trunk`, the gate sees current branch is NOT in protected list
- Falls through to L633-635: "on non-protected branch, proceeding" — no branch switch occurs
- **Outcome**: Branch enforcement is silently bypassed. No feature branch created. Commits go directly to `develop`/`trunk`
- **Tested**: NO
- **Severity**: MEDIUM — the feature designed to protect default branches fails silently for non-standard defaults

#### ADV7: Multiple ralph-loop instances on same repo
**Code path**: Session persistence (sessionPersistence.ts L26-37) — `isPidAlive()` check
- If PID from session file is alive → `load()` returns `null` (refuses to resume)
- This prevents dual-instance resume but does NOT prevent dual-instance startup
- Both instances would run the startup gate, both derive the same branch, both try to commit
- Git handles concurrent commits safely (second commit just fails on lock)
- **Outcome**: Session isolation prevents resume conflicts but not concurrent startup. Concurrent commits may fail intermittently due to git lock contention
- **Tested**: PARTIALLY — PID alive/dead tests exist in `sessionPersistence.test.ts` L174-222. No test for concurrent orchestrator instances
- **Severity**: MEDIUM — git-level safety prevents corruption, but user experience degrades (random commit failures)

#### ADV8: Branch already exists from different PRD
**Code path**: `orchestrator.ts` L617-624 — if `expectedBranch` exists, checkout it
- `deriveBranchName` only uses the PRD H1 title. Two different PRDs with the same title produce the same branch name
- The gate checks `branchExists()` and does `checkoutBranch()` if true — silently reuses the existing branch
- **Outcome**: Commits from the new PRD are mixed with commits from the old PRD on the same branch. No collision detection
- **Tested**: NO
- **Severity**: MEDIUM — silent merge of unrelated work on same branch

#### ADV9: PRD has no H1 title
**Code path**: `parsePrdTitle()` returns `undefined` → `deriveBranchName(undefined ?? '')` → slug is empty → falls back to `'prd'` → branch name: `ralph/prd`
- All PRDs without titles get the same branch name `ralph/prd`
- **Outcome**: All untitled PRDs collide on the same branch
- **Tested**: NO directly for this scenario (only positive title tests exist in `featureBranchE2E.test.ts` L381-386)
- **Severity**: LOW-MEDIUM — edge case but creates surprising behavior

#### ADV10: Dirty working tree when gate tries to switch branches
**Code path**: `checkoutBranch()` / `createAndCheckoutBranch()` use `git checkout` — which **fails** if there are uncommitted changes that would be overwritten
- The gate catches the error and yields `BranchEnforcementFailed` + returns (loop never starts)
- **Outcome**: SAFE but potentially annoying — user must stash/commit before ralph-loop can start
- **Tested**: NO — no test with dirty working tree
- **Severity**: LOW — safe failure mode, but error message is raw git stderr

## Patterns

### Pattern 1: Fire-Once Gate with No Runtime Enforcement
The branch gate runs once at startup. No mechanism re-validates during the loop. This is a single-point-of-check architecture — sufficient for disciplined automated use, insufficient for adversarial or concurrent human interaction.

### Pattern 2: Session Persistence Stores Results, Not Inputs
Session saves `branchName` (what branch we're on) but the startup gate re-derives from PRD content. If inputs change between runs (title mutation), the derived value differs from the stored value. The `branchMismatch` flag is set but **never consumed** by the orchestrator — it's informational only.

### Pattern 3: Defense-in-Depth Gap
The `atomicCommit` branch guard exists but the orchestrator never activates it (no `protectedBranches` passed). The E2E tests test `atomicCommit` standalone with the flag, giving false confidence. As research-3.md identified: this is dead code from the orchestrator perspective.

### Pattern 4: Slug Collision by Design
`deriveBranchName()` is a pure function of the title string. Same title → same branch. No disambiguation mechanism (no hash, no timestamp, no counter). This is fine for single-PRD projects but breaks silently for multi-PRD or title-mutation scenarios.

## Applicability

### What This Handles Well
1. **Single-user, single-PRD, stable-title workflow** — the canonical use case is solid and well-tested
2. **Backward compatibility** — disabled mode is clean, no regressions
3. **Session resume after crash** — PID check, workspace check, branch mismatch detection all work
4. **Atomic writes** — session file uses tmp+rename pattern, crash-safe
5. **Protected branch commit prevention** — the startup gate is robust for the initial check

### What Breaks
1. **Any scenario involving branch state changes after startup** — mid-loop switches, external checkouts
2. **PRD title instability** — renames, edits, or multiple PRDs with similar titles
3. **Non-standard default branches** — `develop`, `trunk`, etc. silently bypass the gate
4. **Multi-instance concurrent usage** — startup not gated, only resume is
5. **branchMismatch flag is write-only** — detected but never acted upon by orchestrator

## Open Questions

1. **Should the orchestrator pass `protectedBranches` to `atomicCommit`?** This would close the mid-loop drift vulnerability with a 2-line change. The guard + getCurrentBranch() call already exist in gitOps.ts.

2. **Should `branchMismatch` trigger corrective action?** Currently it's a flag that nothing reads. Should the orchestrator auto-checkout the stored branch, warn the user, or refuse to start?

3. **Should `deriveBranchName` incorporate a disambiguator?** Options: append PRD file hash, use session ID, or store the mapping in `.ralph/branch-map.json`. Each has tradeoffs for the orphan-branch and collision scenarios.

4. **Should `protectedBranches` be auto-detected?** Using `git symbolic-ref refs/remotes/origin/HEAD` would catch `develop`/`trunk` defaults. The current hardcoded `['main', 'master']` list is fragile.

5. **Is the fire-once gate architecture intentional?** Adding a per-iteration branch check would be cheap (one `git rev-parse` per iteration) and would close ADV1 completely. Was this omitted for performance or simplicity?

6. **What should happen on dirty working tree at startup?** Currently yields raw git error. Should the orchestrator auto-stash, warn more clearly, or attempt `git checkout --merge`?
