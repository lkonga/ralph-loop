# Research-1: Non-Protected Branch Adoption Behavior in runLoop()

## Question

What happens when `runLoop()` starts on a non-protected, non-expected branch (e.g., `bisect/v0.39-lean`)? Does the orchestrator silently adopt it, bypassing enforcement? Can this lose track of the PRD-derived branch or create confusion when session persistence saves the wrong branch?

## Findings

### 1. Branch Enforcement Gate — Exact Control Flow

The branch enforcement logic is in `src/orchestrator.ts` inside `runLoop()`, at approximately lines 610–640. It fires **once** per loop run, before the first task iteration. The gate is only active when `featureBranch.enabled` is `true` (which is the DEFAULT_CONFIG default).

The gate evaluates **three mutually exclusive branches**:

```
currentBranch = await getCurrentBranch(workspaceRoot)
expectedBranch = deriveBranchName(parsePrdTitle(prdContent))
protectedBranches = featureBranch.protectedBranches ?? ['main', 'master']

if (currentBranch === expectedBranch) {
    // CASE 1: Already on correct branch → validate only
    activeBranch = expectedBranch

} else if (protectedBranches.includes(currentBranch)) {
    // CASE 2: On protected branch (main/master) → checkout or create expected branch
    activeBranch = expectedBranch

} else {
    // CASE 3: On NON-PROTECTED, NON-EXPECTED branch → ADOPT SILENTLY
    logger.log(`Branch gate: on non-protected branch '${currentBranch}', proceeding`)
    activeBranch = currentBranch  // ← adopts whatever branch we're on
}
```

### 2. What Happens on `bisect/v0.39-lean`

When `runLoop()` starts on `bisect/v0.39-lean`:

1. `getCurrentBranch()` returns `"bisect/v0.39-lean"`
2. `expectedBranch` is computed from PRD H1, e.g. `"ralph/my-project"`
3. `"bisect/v0.39-lean" !== "ralph/my-project"` → CASE 1 fails
4. `["main", "master"].includes("bisect/v0.39-lean")` → false → CASE 2 fails
5. **CASE 3 fires**: `activeBranch` is set to `"bisect/v0.39-lean"`, and a log message is emitted

**Result**: The orchestrator silently adopts `bisect/v0.39-lean` as the working branch. It does **not** create the PRD-derived branch. It does **not** warn the user. It does **not** emit a `BranchValidated` or `BranchCreated` event — it emits **nothing** for this case.

### 3. Session Persistence — What Gets Saved

At the end of each task iteration (orchestrator.ts ~line 1490), session state is saved:

```typescript
const currentBranch = await getCurrentBranch(this.config.workspaceRoot);
this.sessionPersistence?.save(this.config.workspaceRoot, {
    currentTaskIndex: task.id,
    iterationCount: iteration,
    ...
    branchName: currentBranch,  // ← saves ACTUAL git branch, not expected
});
```

Key observations:
- **`branchName` is read from git at save time**, not from `this.activeBranch`. This means it saves whatever branch HEAD points to, which could diverge from `activeBranch` if something externally changes the branch mid-loop.
- On `bisect/v0.39-lean`, the session file will contain `"branchName": "bisect/v0.39-lean"`.
- The PRD-derived expected branch name (`ralph/my-project`) is **never saved** to the session file.

### 4. Session Resume — Branch Mismatch Detection

When loading a session (`sessionPersistence.ts` lines 55–82):

```typescript
if (currentBranch && data.branchName && currentBranch !== data.branchName) {
    data.branchMismatch = true;
}
```

- The `branchMismatch` flag is **set** on the loaded state object, but it is a **passive marker**.
- Searching the entire orchestrator codebase: **`branchMismatch` is never read or acted upon**. The flag exists in the interface but the orchestrator does not check it.
- This means even if a mismatch is detected, the orchestrator will proceed anyway.

### 5. State Snapshot Exposure

`getStateSnapshot()` returns `this.activeBranch`, which for non-protected branches is the adopted branch name:

```typescript
getStateSnapshot(): StateSnapshot {
    return {
        state: this.state,
        taskId: this._currentTaskId,
        ...
        branch: this.activeBranch,  // → "bisect/v0.39-lean" in this scenario
    };
}
```

This means the UI and external consumers see the adopted branch, not the expected one. There is no indication that the branch is "wrong" relative to the PRD.

### 6. Commits Go to the Adopted Branch

`atomicCommit()` has its own protected branch guard (gitOps.ts line 73), but only checks `options.protectedBranches`:

```typescript
if (options?.protectedBranches?.length) {
    const currentBranch = await getCurrentBranch(workspaceRoot);
    if (options.protectedBranches.includes(currentBranch)) {
        return { success: false, error: `Refusing to commit on protected branch '${currentBranch}'` };
    }
}
```

Since `bisect/v0.39-lean` is not in `['main', 'master']`, commits proceed normally **on the adopted branch**. All task commits land on `bisect/v0.39-lean`, not on the PRD-derived branch.

### 7. Test Coverage Gap

The test file `test/featureBranchE2E.test.ts` covers:
- (1) Starting on `main` → creates expected branch ✓
- (2) Session save/load with branch name ✓
- (3) Commit history on feature branch ✓
- (4) Feature branch disabled → backward compatible ✓
- (5) Integration: PRD → branch name → state snapshot ✓

**Missing**: There is **no test** for starting on a non-protected, non-expected branch. The CASE 3 silent adoption path is completely untested.

## Patterns

1. **Silent Adoption Anti-Pattern**: The CASE 3 else-branch silently adopts an arbitrary branch without any event, warning, or user prompt. This is a "fail-open" design that contradicts the enforcement purpose of the gate.

2. **Divergent Identity Sources**: `activeBranch` is set from the adopted branch (in-memory), but `branchName` in session persistence is read from git at save time. If something changed the branch mid-loop, these could diverge. Additionally, the expected branch (from PRD) is computed but never persisted.

3. **Dead Branch Mismatch Flag**: `SessionPersistence.load()` sets `branchMismatch = true` when branches differ, but no consumer reads this flag — it's dead code that gives a false sense of safety.

4. **No Expected Branch Persistence**: The session file stores the *actual* branch, not the *expected* branch. On resume, there is no way to know what branch the PRD intended.

## Applicability

### Risk Assessment: HIGH

Starting on `bisect/v0.39-lean` (or any non-protected, non-expected branch):

| Risk | Severity | Description |
|------|----------|-------------|
| Commits on wrong branch | HIGH | All task commits land on `bisect/v0.39-lean`, not the PRD-derived branch. Work is orphaned from the intended branch. |
| Session saves wrong branch | MEDIUM | `.ralph/session.json` records `bisect/v0.39-lean`. Future resume sees this as "correct" and continues on the wrong branch. |
| PRD-derived branch never created | MEDIUM | If the user expected the orchestrator to create `ralph/my-project`, they won't find it. Work exists only on the random branch. |
| No user notification | HIGH | No event, warning, or prompt tells the user they're on an unexpected branch. The user may discover the issue only after significant work has been done. |
| Branch mismatch detection is dead code | LOW | The `branchMismatch` flag provides false safety — it looks like protection exists but doesn't function. |

### Concrete Scenario

1. User is debugging on `bisect/v0.39-lean`
2. User starts ralph-loop (forgets to switch to main first)
3. Ralph silently adopts `bisect/v0.39-lean`, runs 10 tasks, commits all to it
4. User later looks for `ralph/my-project` — it doesn't exist
5. All work is on `bisect/v0.39-lean`, mixed with bisect debugging commits
6. Session file says `branchName: "bisect/v0.39-lean"` — future resumes continue there

## Open Questions

1. **Was silent adoption intentional?** The log message `"Branch gate: on non-protected branch, proceeding"` suggests a deliberate design choice to be permissive. Was this to support existing non-ralph branches, or is it an oversight?

2. **Should CASE 3 warn or block?** Options:
   - **Block**: Emit `BranchEnforcementFailed` and refuse to start (strictest)
   - **Warn**: Emit a new `BranchMismatchWarning` event but proceed (configurable)
   - **Prompt**: Ask the user whether to adopt or switch to expected branch

3. **Should `expectedBranch` be saved to session?** Persisting the PRD-derived branch name alongside the actual branch would enable mismatch detection on resume.

4. **Should `branchMismatch` be wired up?** The flag is computed but unused. Should the orchestrator act on it (e.g., refuse to resume, warn, or auto-switch)?

5. **What about detached HEAD?** `getCurrentBranch()` returns `"HEAD"` for detached HEAD state. This would also fall into CASE 3 — the orchestrator would adopt detached HEAD as `activeBranch = "HEAD"`, which is even more problematic.
