# Research 4: Session Persistence Branch Mismatch Detection — Reliability Analysis

## Findings

### How `branchMismatch` Is Set

In `src/sessionPersistence.ts`, the `load()` method sets `branchMismatch = true` on the returned data when **all three conditions** are true:

1. A `currentBranch` argument was passed to `load()`
2. The stored `data.branchName` is non-empty
3. `currentBranch !== data.branchName`

If either `currentBranch` or `data.branchName` is missing/falsy, the flag is **never set** — this is the legacy-session graceful-degradation path.

### Where `branchMismatch` Is Stored

The flag is **stored on disk** in `session.json` only as `false` or absent. The `save()` method writes whatever state it receives but the orchestrator's `save()` call at line 1479 never includes `branchMismatch` — it writes `branchName: currentBranch` fresh each iteration. So `branchMismatch` is a **runtime-only annotation** added by `load()`, not a persisted flag.

### Who Consumes It

**Only `extension.ts` (UI layer) — the orchestrator never checks it.**

In `extension.ts` lines 434–460, the activation path:
1. Calls `persistence.hasIncompleteSession(wsRoot)` — this calls `load()` **without** `currentBranch`, so `branchMismatch` is never set here
2. Then calls `persistence.load(wsRoot, currentBranch)` — this is where mismatch is detected
3. If `state?.branchMismatch` is true, shows a warning dialog with three options:
   - **"Resume"**: Checks out the stored branch, creates a new orchestrator, and starts it
   - **"Continue"**: Ignores the mismatch, creates a new orchestrator on the current branch
   - **"Discard"**: Clears the session file

**The orchestrator's `start()` method has its own completely independent branch enforcement gate** (lines 602–636) that:
- Derives the expected branch from the PRD title via `deriveBranchName()`
- Creates or checks out the feature branch if on a protected branch
- Does **not** read `branchMismatch` at all

### The Branch Enforcement Gap

There are **two independent branch-handling systems**:

| System | Location | Trigger | Branch Source |
|--------|----------|---------|---------------|
| Session mismatch | `extension.ts` activation | Extension loads incomplete session | Stored `branchName` from last save |
| Branch enforcement gate | `orchestrator.ts` runLoop | Every loop start | Derived from PRD title via `deriveBranchName()` |

These can **disagree**: the session might have been saved on branch `ralph/old-feature` but the current PRD title derives `ralph/new-feature`. The extension's mismatch dialog would offer to switch to `ralph/old-feature`, but then the orchestrator's branch gate would immediately switch to `ralph/new-feature`.

### What Happens If the Stored Branch Was Deleted?

If the user picks "Resume" in the extension dialog, `checkoutBranch(wsRoot, state.branchName!)` is called. This runs `git checkout <branch>`. If the branch was deleted:
- `git checkout` fails silently (the error is not caught — `checkoutBranch` returns `{ success: false, error: ... }`)
- **But the extension doesn't check the return value** — it proceeds to create an orchestrator and start it regardless

This is a **bug**: the extension fires `checkoutBranch` as `await checkoutBranch(...)` but never inspects the result. The orchestrator will then start on whatever branch the user is actually on.

### Test Coverage

**Unit tests** (`test/sessionPersistence.test.ts` lines 264–310):
- ✅ Mismatch detection when branches differ
- ✅ No mismatch when branches match
- ✅ Legacy session (no branchName stored) — graceful degradation
- ✅ No currentBranch passed — no validation

**E2E tests** (`test/featureBranchE2E.test.ts` lines 166–210):
- ✅ Session detects branch mismatch
- ✅ No false positive when branches match
- ✅ Orchestrator resumes on correct feature branch after restart

**Missing coverage**:
- ❌ Extension.ts dialog behavior (UI code, not unit tested)
- ❌ `checkoutBranch` failure during Resume flow
- ❌ Conflict between session mismatch and orchestrator branch gate
- ❌ Detached HEAD state (`getCurrentBranch` returns `'HEAD'`, which triggers mismatch against any stored branch)

### False Positive Risk Assessment

**Legitimate false positive scenarios:**

1. **Intentional branch switch**: User finishes work on feature A, switches to main, starts new PRD. Old session is still on disk (hasn't expired). Extension shows mismatch warning for a session the user is done with. **Risk: Medium** — the 24h expiry mitigates but doesn't eliminate.

2. **Detached HEAD**: `getCurrentBranch()` returns `'HEAD'` when in detached state. If session stored `ralph/my-feature`, comparing `'HEAD' !== 'ralph/my-feature'` triggers mismatch. The dialog offers to switch back, but this may be unexpected during bisect/rebase. **Risk: Low-Medium**.

3. **Branch rename**: If the branch was renamed (e.g., via `git branch -m`), the stored name is stale. Mismatch is technically correct but confusing. **Risk: Low**.

4. **Multiple worktrees**: Same `.ralph/session.json` shared across worktrees if they share the workspace root. Different worktrees may be on different branches legitimately. **Risk: Low** (unlikely in practice, workspace paths differ).

## Patterns

1. **Dual-authority anti-pattern**: Two independent systems (session persistence mismatch + orchestrator branch gate) manage branch state with different data sources (stored branch vs. PRD-derived branch). Neither is aware of the other.

2. **Write-only flag**: `branchMismatch` is set by `load()` but only consumed by UI code — a 3-option dialog in `extension.ts`. The orchestrator ignores it entirely and runs its own branch logic.

3. **Fire-and-forget checkout**: The extension's Resume path calls `checkoutBranch()` but doesn't check the result. If checkout fails, the orchestrator starts on the wrong branch.

4. **Graceful degradation for legacy**: Both `currentBranch` and `data.branchName` must be truthy for mismatch detection, so legacy sessions without branch info skip validation cleanly.

## Applicability

The mismatch detection logic itself is **mechanically correct** — the string comparison is simple and the guard clauses prevent false positives from legacy sessions. The problem is not false positives in the detection, but:

1. **Irrelevance**: The dialog's "Resume" option conflicts with the orchestrator's own branch gate, making the user's choice potentially meaningless.
2. **Unchecked failure**: If checkout fails during Resume, the error is silently swallowed.
3. **Narrow consumption**: Only the UI layer acts on the flag; the orchestrator has its own branch logic.

Overall reliability: **the detection is reliable but the consumption is fragile**. The flag itself doesn't cause false positives, but the dual-authority branch management can confuse users and lead to unexpected branch states.

## Open Questions

1. **Should the orchestrator's branch gate respect the session's stored branch?** Currently it ignores it entirely, deriving the branch from the PRD title. If the user chose "Resume" to switch back to the stored branch, the orchestrator may immediately switch again.

2. **Should `extension.ts` check `checkoutBranch()` result?** Currently line 440 does `await checkoutBranch(wsRoot, state.branchName!)` without error handling. If the branch was deleted, this silently fails.

3. **Should `hasIncompleteSession()` pass `currentBranch` to `load()`?** Currently it doesn't, meaning the first call in the activation path never detects mismatch — it relies on the second explicit `load()` call. This is intentional (separation of "has session?" from "is session valid?") but could be simplified.

4. **What should happen in detached HEAD state?** `getCurrentBranch()` returns `'HEAD'`, which will always mismatch any stored named branch. Should this be treated as "no branch available" (skip validation) rather than a mismatch?

5. **Is the 24h expiry sufficient to prevent stale mismatch warnings?** A user who finishes a session, switches branches, but doesn't clear the session file will see a mismatch warning for up to 24 hours.
