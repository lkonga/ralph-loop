# Research-5: Edge Case / Failure Mode Catalog — Branch Enforcement Feature

## Findings

### Code Footprint

The branch enforcement feature adds code across 5 source files and 3 test files:

| File | Lines Added | Purpose |
|------|-------------|---------|
| `src/orchestrator.ts` L601-637 | ~37 | Branch enforcement gate (decision tree) |
| `src/gitOps.ts` L111-136 | ~25 | `getCurrentBranch`, `createAndCheckoutBranch`, `checkoutBranch`, `branchExists` |
| `src/gitOps.ts` L62-70 | ~8 | Protected branch guard in `atomicCommit` |
| `src/prd.ts` L12-33 | ~22 | `parsePrdTitle`, `deriveBranchName` |
| `src/types.ts` (scattered) | ~12 | 3 event kinds + `featureBranch` config type + `StateSnapshot.branch` |
| `src/sessionPersistence.ts` L15-16, L55, L72-74 | ~5 | `branchName`, `branchMismatch` fields + detection logic |
| **Total source** | **~109** | |
| `test/orchestrator.test.ts` L1657-1970 | ~313 | 10 branch gate integration tests |
| `test/gitOps.test.ts` L201-310 | ~110 | Protected branch commit tests + git op unit tests |
| `test/prd.test.ts` L764-825 | ~62 | `parsePrdTitle` + `deriveBranchName` unit tests |
| **Total tests** | **~485** | |
| **Grand total** | **~594** | |

The orchestrator is ~1400 lines; the branch gate is 2.6% of it. The feature's test-to-source ratio is ~4.5:1 — heavily tested relative to its size.

### Complete Failure Mode Catalog

| # | Failure Mode | Handled? | Mechanism | Outcome |
|---|-------------|----------|-----------|---------|
| 1 | **Branch creation fails** (`git checkout -b` errors) | ✅ Yes | `createAndCheckoutBranch` returns `{success: false, error}` → gate yields `BranchEnforcementFailed` → loop returns | Hard stop, session cleared |
| 2 | **Checkout existing branch fails** (`git checkout` errors) | ✅ Yes | `checkoutBranch` returns `{success: false, error}` → gate yields `BranchEnforcementFailed` → loop returns | Hard stop, session cleared |
| 3 | **No H1 title in PRD** (`parsePrdTitle` returns `undefined`) | ⚠️ Partial | `deriveBranchName(prdTitle ?? '')` → `deriveBranchName('')` → slug-is-empty guard → `ralph/prd` | Silent fallback to generic `ralph/prd` branch. Works but may cause collision if multiple untitled PRDs exist |
| 4 | **Detached HEAD** (`getCurrentBranch` returns `'HEAD'`) | ⚠️ Implicit | `'HEAD'` is not in `protectedBranches` and doesn't match `expectedBranch` → falls to else clause: "on non-protected branch, proceeding" | Loop runs on detached HEAD. Commits succeed but aren't on any branch — potential for orphaned commits |
| 5 | **Dirty working tree** (uncommitted changes block checkout) | ✅ Yes | `git checkout` fails → `runGit` captures error → `BranchEnforcementFailed` emitted → hard stop | Hard stop, no data loss |
| 6 | **Concurrent instances** (two ralph loops, same workspace) | ✅ Yes | `SessionPersistence.load()` checks PID alive (`process.kill(pid, 0)`) → returns null if alive | Second instance won't resume stale session; both could still race on git ops (see Open Questions) |
| 7 | **Git not installed** (`execFile('git')` fails) | ⚠️ Partial | `runGit` resolves with `{err}` → `getCurrentBranch` returns `'HEAD'` (empty trim fallback) → treated as non-protected | Loop proceeds without git, commits will all fail later with error events per-task |
| 8 | **`atomicCommit` missing `protectedBranches` opt** | ❌ Gap | Both call sites in orchestrator (L752, L1311) call `atomicCommit(workspaceRoot, task, invId)` **without** passing `protectedBranches` | If user manually `git checkout main` mid-loop, commits will land on `main`. The startup gate won't re-fire. |
| 9 | **Branch mismatch on session resume** | ✅ Yes | `SessionPersistence.load(workspaceRoot, currentBranch)` sets `data.branchMismatch = true` if saved branch ≠ current | Mismatch is detectable; caller can decide to reject/reset |
| 10 | **Feature disabled** (`featureBranch.enabled = false`) | ✅ Yes | Gate block skipped entirely | No branch ops called; tested in dedicated test |
| 11 | **Race: branch deleted between `branchExists` and `checkoutBranch`** | ⚠️ Theoretical | `checkoutBranch` will fail → `BranchEnforcementFailed` | Hard stop. Extremely unlikely in practice (single-user tool). |
| 12 | **PRD file unreadable** (missing/permissions) | ⚠️ Upstream | `readPrdFile()` throws before branch gate → caught by orchestrator's outer try/catch → `Error` event | Loop stops with error, not branch-specific |
| 13 | **Branch name collision** (non-ralph branch named `ralph/...`) | ⚠️ Implicit | `branchExists` returns true → `checkoutBranch` succeeds → loop runs on pre-existing branch with unknown state | No validation that the branch was actually created by ralph |

### Decision Tree Summary (orchestrator L601-637)

```
featureBranch.enabled?
├─ NO → skip gate entirely
└─ YES
   ├─ currentBranch === expectedBranch? → BranchValidated, proceed
   ├─ currentBranch in protectedBranches?
   │   ├─ expectedBranch exists? → checkout it (or fail → hard stop)
   │   └─ doesn't exist? → create it (or fail → hard stop)
   └─ else (non-protected, non-expected) → proceed on current branch
```

3 leaf paths (validated/created/pass-through), 2 failure exits. Clean tree with no ambiguity.

### atomicCommit Protected Branch Gap (Detail)

The `atomicCommit` function at `src/gitOps.ts` L62-70 **does** support a `protectedBranches` option:

```typescript
if (options?.protectedBranches?.length) {
    const currentBranch = await getCurrentBranch(workspaceRoot);
    if (options.protectedBranches.includes(currentBranch)) {
        return { success: false, error: `Refusing to commit on protected branch '${currentBranch}'` };
    }
}
```

But neither call site in the orchestrator passes it:
- L752: `await atomicCommit(this.config.workspaceRoot, task, invId)` (parallel path)
- L1311: `await atomicCommit(this.config.workspaceRoot, task, taskInvocationId)` (sequential path)

The startup gate prevents starting on `main`, but nothing prevents committing to `main` if the branch changes mid-run. This is the single real gap in the safety net.

## Patterns

1. **Result-type error handling**: All git operations return `{success, error?}` instead of throwing — consistent, testable, composable. No try/catch needed at the gate level.

2. **Event-driven signaling**: Failures are communicated via typed events (`BranchEnforcementFailed`), not exceptions. The `start()` method treats this event as a terminal condition alongside `Stopped`, `AllDone`, `MaxIterations`, and `YieldRequested`.

3. **Feature flag isolation**: The entire feature is behind `featureBranch.enabled` with a clean no-op path. Zero overhead when disabled.

4. **Heavy test coverage for light code**: 485 lines of tests for 109 lines of source (4.5:1 ratio). Tests cover: create from protected, reuse existing, already on expected, creation failure, disabled flag, custom protected list, non-protected pass-through, event emission, state snapshot inclusion. This is thorough.

5. **Fallback vs. failure**: The code prefers silent fallbacks (no H1 → `ralph/prd`, detached HEAD → proceed) over hard failures. This matches the tool's "keep going" philosophy but creates subtle edge cases.

## Applicability

### Complexity vs. Safety Assessment

**Lines added**: ~109 source / ~594 total (with tests)  
**New code paths**: 5 (3 success, 2 failure) in a single gate point  
**New event types**: 3  
**New config surface**: 1 optional config key  

**Safety provided**:
- Prevents accidental commits on `main`/`master` during automated loops
- Auto-creates namespaced branches (`ralph/...`) from PRD titles
- Session persistence tracks branch context for resume
- Feature is entirely opt-out via config flag

**Verdict**: The feature is **proportionate**. It adds ~109 lines to prevent a real class of damage (automated commits polluting protected branches). The decision tree is shallow (one gate, 5 paths). The 4.5:1 test ratio means regressions are unlikely. The single real gap (atomicCommit not passing protectedBranches) is the only case where added complexity doesn't carry its weight.

The edge cases that are unhandled (detached HEAD, git missing, no H1 title) are all **degraded-but-functional** — the system doesn't crash or corrupt data, it just operates with reduced guarantees. This is acceptable for a developer tool.

## Open Questions

1. **Should `atomicCommit` calls pass `protectedBranches`?** This is the only true gap. A mid-run `git checkout main` (manual or external tool) would bypass the startup gate. Fix: pass `featureBranchConfig.protectedBranches` to both `atomicCommit` call sites.

2. **Should detached HEAD be treated as a failure?** Currently it's pass-through. If a user starts ralph on a detached HEAD, commits happen but aren't on any named branch. Should the gate warn or stop?

3. **Should `ralph/prd` fallback be logged as a warning?** When `parsePrdTitle` returns `undefined`, the gate silently creates `ralph/prd`. A `logger.warn` would make this visible without adding a new event type.

4. **Concurrent git operations**: Two ralph instances on the same workspace could race on `branchExists` → `createAndCheckoutBranch`. The PID guard in SessionPersistence prevents session resume but doesn't prevent two fresh starts. Is this a realistic scenario?

5. **Branch name collision**: Should the gate verify that a pre-existing `ralph/...` branch was actually created by this tool? Or is "checkout and continue" appropriate?

6. **Missing `protectedBranches` in parallel commit path**: The parallel task execution path (L752) has the same gap as the sequential path (L1311). Both need the fix if it's applied.
