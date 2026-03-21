# Research: atomicCommit Branch Guard — Defense-in-Depth or Redundant Complexity?

## Findings

### 1. The orchestrator's startup branch gate (orchestrator.ts L602-634)

The `LoopOrchestrator.start()` generator contains a branch enforcement gate that fires **once per loop run**, before entering the task loop. When `featureBranch.enabled` is true:

- It reads the current branch via `getCurrentBranch()`
- If on a protected branch (`['main', 'master']` by default), it creates or checks out a `ralph/<slug>` feature branch derived from the PRD title
- If on a non-protected branch, it logs and proceeds
- On failure, it yields `BranchEnforcementFailed` and **returns** — the loop never starts

This gate is comprehensive and prevents any task execution on a protected branch.

### 2. The atomicCommit branch guard (gitOps.ts L61-68)

```typescript
if (options?.protectedBranches?.length) {
    const currentBranch = await getCurrentBranch(workspaceRoot);
    if (options.protectedBranches.includes(currentBranch)) {
        const msg = `Refusing to commit on protected branch '${currentBranch}'`;
        options.logger?.warn(msg);
        return { success: false, error: msg };
    }
}
```

This guard is **opt-in** — it only activates when `options.protectedBranches` is explicitly provided.

### 3. The orchestrator NEVER passes protectedBranches to atomicCommit

This is the critical finding. Both call sites in the orchestrator call `atomicCommit` **without the options parameter**:

- **Parallel path** (L752): `await atomicCommit(this.config.workspaceRoot, task, invId)` — no options  
- **Sequential path** (L1311): `await atomicCommit(this.config.workspaceRoot, task, taskInvocationId)` — no options

Since `options?.protectedBranches?.length` evaluates to falsy when options is `undefined`, **the branch guard in atomicCommit is dead code from the orchestrator's perspective**.

### 4. No other production callers exist

Searching `src/**/*.ts` for `atomicCommit` yields exactly:
- 1 definition in `gitOps.ts`
- 1 import + 2 call sites in `orchestrator.ts`

No other production code calls `atomicCommit`. The guard is only exercised by test code that calls `atomicCommit` directly with `{ protectedBranches: [...] }`.

### 5. Can the branch change back to protected mid-loop?

The orchestrator does **not** re-check the branch during the loop. There is no code that switches branches after the startup gate. The only branch-switching code is in the startup gate itself. A user could manually `git checkout main` in another terminal during the loop, but:

- The orchestrator has no branch drift detection
- The `atomicCommit` guard would **not** catch this because `protectedBranches` is never passed
- This is a theoretical race condition that neither guard currently prevents in practice

### 6. Line count analysis

| Component | Production code | Test code |
|-----------|----------------|-----------|
| atomicCommit branch guard (gitOps.ts L61-68) | 7 lines | — |
| AtomicCommitOptions interface (gitOps.ts L12-15) | 4 lines | — |
| Unit tests for guard (gitOps.test.ts L201-242) | — | ~42 lines |
| E2E direct-call tests (featureBranchE2E.test.ts) | — | ~50 lines |
| **Total** | **11 lines** | **~92 lines** |

The guard has an 8:1 test-to-production ratio, and none of its tests exercise actual production code paths.

## Patterns

1. **Disconnected guard pattern**: The guard exists but is not wired into the only production caller. This is a classic "aspirational defense-in-depth" that never materialized — the plumbing was built but not connected.

2. **Test-only activation**: The guard is only activated in tests that call `atomicCommit` directly with explicit options, which tests a code path that production never exercises. These tests verify correctness of dead code.

3. **Missing actual defense-in-depth**: If the goal was defense-in-depth, the orchestrator should pass `protectedBranches` from `this.config.featureBranch.protectedBranches` to `atomicCommit`. That would make it genuine defense-in-depth. Currently it's an unfinished implementation.

4. **The real gap**: Branch drift mid-loop (user manually switches to `main` during execution) is unprotected by either guard. The startup gate runs once; `atomicCommit` doesn't check. This is the scenario where defense-in-depth would actually matter.

## Applicability

**Current state: redundant complexity (dead code).**

The atomicCommit guard adds 11 lines of production code and ~92 lines of test code that exercise no real production path. It provides a false sense of security.

**Two valid paths forward:**

1. **Wire it up** (make it real defense-in-depth): Pass `{ protectedBranches: this.config.featureBranch?.protectedBranches }` at both orchestrator call sites. This would make the guard genuine defense against mid-loop branch drift. Cost: 2 lines changed, existing tests become meaningful.

2. **Remove it** (reduce complexity): Delete the guard, the `AtomicCommitOptions` interface, and all associated test code. The startup gate is sufficient for the "start on protected branch" scenario, and mid-loop branch drift remains unprotected either way. Savings: ~103 lines of dead code removed.

Option 1 is recommended if branch safety is a priority — it's trivial to connect and creates real defense-in-depth. Option 2 is recommended if minimalism is the goal and branch drift is considered an acceptable risk.

## Open Questions

1. **Was the omission intentional?** The orchestrator has `this.config.featureBranch?.protectedBranches` readily available. Was not passing it to `atomicCommit` an oversight or a deliberate choice to avoid the extra `getCurrentBranch()` call per commit?

2. **Should branch drift be detected?** If a user (or another process) switches the branch during a loop run, commits silently land on the wrong branch. Should the orchestrator add periodic branch validation, or is this an acceptable edge case?

3. **Performance concern**: The guard calls `getCurrentBranch()` (which spawns `git rev-parse --abbrev-ref HEAD`) on every commit. For the parallel path with many commits, this adds N extra git process spawns. Is the latency acceptable?

4. **Why does featureBranchE2E.test.ts test atomicCommit directly?** The E2E tests call `atomicCommit` with `protectedBranches` as a standalone function, but the orchestrator never does this. Do these tests give false confidence about the end-to-end behavior?
