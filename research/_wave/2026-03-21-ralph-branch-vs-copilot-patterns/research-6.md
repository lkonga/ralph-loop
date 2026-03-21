# Research 6: Ralph Branch Enforcement vs Copilot Branch Patterns — Refactoring Proposal

## Findings

### 1. Branch Naming: Deterministic Slug vs Random Timestamp

**Ralph's `deriveBranchName` ([src/prd.ts](../../../src/prd.ts#L22-L33))**:
- Derives a deterministic slug from the PRD `# Title` heading
- Format: `ralph/<slugified-title>` (max 50 chars)
- Slugification: lowercase, replace non-alphanumeric with `-`, collapse runs, trim edges
- **Problem**: Two PRDs with the same title create the same branch name → collision. No disambiguation suffix.

**Copilot's `generateRandomBranchName` ([copilotCloudGitOperationsManager.ts](L215-L230) in vscode-copilot-chat)**:
- Format: `copilot/vscode-<timestamp-base36>-<random-4-chars>`
- Example: `copilot/vscode-m3x7k9a-f2h1`
- Retry loop (5 attempts) checking `refs/heads/` to ensure no collision
- **No semantic meaning** — purely collision-avoidant

**Key difference**: Ralph's deterministic naming is friendlier for humans (you can see what a branch is for) but risks collision. Copilot's random naming is collision-proof but meaningless. A hybrid `ralph/<slug>-<short-hash>` gives both readability and uniqueness.

### 2. Branch Gate: 3-Way Conditional vs Linear Flow

**Ralph's branch gate ([orchestrator.ts](../../../src/orchestrator.ts#L601-L636))** has a 3-way if/else:

```
if currentBranch === expectedBranch → proceed (BranchValidated)
else if currentBranch ∈ protectedBranches →
    if expectedBranch exists → checkout it
    else → create it (BranchCreated)
else → proceed on current branch (silent adoption)
```

Three distinct paths, two events (`BranchCreated`, `BranchValidated`), one failure mode (`BranchEnforcementFailed`). The "else" arm silently adopts whatever branch you're on — no event emitted, no validation that it's related to the PRD.

**Copilot's `commitAndPushChanges` ([copilotCloudGitOperationsManager.ts](L99-L114))** is linear:

```
1. Record current branch as baseRef
2. Generate random new branch name
3. Create branch + checkout
4. Commit all dirty state
5. Push to remote
6. Switch back to baseRef
```

No conditional branching logic at all. Always creates. Always pushes. Always switches back. The cloud handles the rest.

### 3. Dirty-State Handling

**Ralph**: **Zero dirty-state handling.** The branch gate (`orchestrator.ts` L601-636) calls `createAndCheckoutBranch` or `checkoutBranch` without checking for uncommitted changes. If the working tree is dirty, `git checkout -b` may fail or carry uncommitted changes to the new branch silently. No stash, no commit-all, no user prompt.

**Copilot** has two distinct dirty-state strategies:

1. **Cloud sessions** (`commitAndPushChanges`): Commit all dirty state (`commit --all`) on the temp branch, push it, switch back. If auto-commit fails, opens an interactive terminal for 5 minutes letting the user manually commit.

2. **Background agent sessions** (`folderRepositoryManagerImpl`): Prompts user with options: `move` changes to worktree, `copy` them, `skip`, or `cancel`. Full user control.

### 4. Session Persistence & Branch Tracking

**Ralph** ([sessionPersistence.ts](../../../src/sessionPersistence.ts)):
- Saves `branchName` in `.ralph/session.json` after each iteration
- On reload, compares current branch to saved branch → sets `branchMismatch: true` if different
- But **does not store the original branch** — only the working branch. If you want to "switch back" there's no record of where you came from.

**Copilot**:
- Records `baseRef` (original branch) and `baseBranchName` in worktree properties
- Always switches back to `baseRef` after operations via `switchBackToBaseRef`
- No persistent file — state lives in the VS Code session/memento store

### 5. Error Handling & Rollback

**Ralph**: If branch creation fails → emits `BranchEnforcementFailed` event and `return`s (stops the loop). No rollback attempt.

**Copilot**: If commit/push fails → calls `rollbackToOriginalBranch(repository, baseRef)` to restore original state. Graceful degradation.

---

## Patterns

### Copilot's Core Pattern (distilled)
```
save originalBranch
create tempBranch from HEAD
commit-all dirty state to tempBranch
[do work on tempBranch]
switch back to originalBranch
```

This is a **snapshot-and-delegate** pattern: capture current state on a disposable branch, let the cloud/user handle merging later; the local workspace returns to its original state.

### Ralph's Core Pattern (current)
```
derive expectedBranch from PRD title
if on expectedBranch → continue
if on protected → create/checkout expectedBranch
if on other → silently adopt
[do work, commit to current branch]
save branch name in session
```

This is a **deterministic-target** pattern: there's one "correct" branch per PRD, and the gate tries to get you there. The silent adoption path undermines this — you might end up committing to an unrelated branch.

### What Copilot Gets Right That Ralph Doesn't
1. **Always creates** — no conditional logic, no ambiguity
2. **Handles dirty state** — commits or prompts before branch operations
3. **Records origin** — knows where to go back to
4. **Has rollback** — if something fails, reverts to original state
5. **Collision-proof naming** — entropy in the name prevents conflicts

---

## Applicability

### Proposed Refactored Design for Ralph

**Naming convention**: `ralph/<prd-slug>-<7-char-git-short-hash>`
```typescript
export function deriveBranchName(title: string, headHash: string): string {
  const PREFIX = 'ralph/';
  const MAX_LENGTH = 50;
  let slug = title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/-{2,}/g, '-').replace(/^-|-$/g, '');
  if (!slug) slug = 'prd';
  const suffix = `-${headHash.slice(0, 7)}`;
  const maxSlug = MAX_LENGTH - PREFIX.length - suffix.length;
  slug = slug.slice(0, maxSlug).replace(/-$/g, '');
  return PREFIX + slug + suffix;
}
```

**Simplified linear branch gate** (replaces the 3-way if/else in orchestrator.ts L601-636):

```typescript
// 1. Record origin
const originalBranch = await getCurrentBranch(workspaceRoot);

// 2. Handle dirty state
const hasDirtyState = await hasUncommittedChanges(workspaceRoot);
if (hasDirtyState) {
  await stashChanges(workspaceRoot); // or commit-all to a temp save
}

// 3. Always create a new branch from current HEAD
const headHash = await getHeadHash(workspaceRoot);
const branchName = deriveBranchName(prdTitle ?? '', headHash);
const result = await createAndCheckoutBranch(workspaceRoot, branchName);
if (!result.success) {
  if (hasDirtyState) await unstashChanges(workspaceRoot);
  yield { kind: LoopEventKind.BranchEnforcementFailed, reason: result.error };
  return;
}

// 4. Restore dirty state on new branch
if (hasDirtyState) {
  await unstashChanges(workspaceRoot);
}

// 5. Record both branches
this.originalBranch = originalBranch;
this.activeBranch = branchName;
yield { kind: LoopEventKind.BranchCreated, branchName };
```

**Session persistence changes**:
- Add `originalBranch: string` to `SerializedLoopState`
- On session resume, if `originalBranch` is stored, the user can `git checkout <original>` to return

**New git ops needed** (in `gitOps.ts`):
```typescript
async function hasUncommittedChanges(workspaceRoot: string): Promise<boolean>
async function stashChanges(workspaceRoot: string): Promise<{ success: boolean }>
async function unstashChanges(workspaceRoot: string): Promise<{ success: boolean }>
async function getHeadHash(workspaceRoot: string): Promise<string>
```

### What Gets Removed
- The 3-way if/else branch gate (L609-636) → replaced by linear flow
- `BranchValidated` event kind — no longer needed (we always create)
- The `branchExists` + `checkoutBranch` path for reusing existing branches
- Silent branch adoption (the dangerous "else" arm)

### What Gets Simplified
- `deriveBranchName` gains a hash parameter but remains pure
- Session persistence gains `originalBranch` field
- Branch gate becomes ~15 lines instead of ~35

### Smallest Change for Biggest Impact
If full refactoring is too much in one pass, the **minimum viable improvement** is:

1. **Add dirty-state check** before any branch operation (3 lines of code checking `git status --porcelain`)
2. **Add `originalBranch` tracking** to session state (1 new field)
3. **Remove the silent adoption** else-arm — make it create a branch too, or error explicitly

These three changes address the worst gaps (data loss from dirty state, no origin tracking, silent adoption) without restructuring the gate logic.

---

## Open Questions

1. **Stash vs commit-all for dirty state?** Copilot commits everything. Stashing is more reversible but adds complexity (stash pop conflicts). Ralph's atomic-commit infrastructure already exists — should dirty state just get an auto-commit with a `chore: ralph-wip` message before branching?

2. **Should ralph ever reuse an existing branch?** Copilot always creates new. Ralph's current behavior of checking out an existing `ralph/<slug>` branch on resume is arguably useful (you keep your commit history). But it conflicts with the "always create" simplicity. Should resume attach to the existing branch instead of creating new?

3. **Should ralph switch back to the original branch when done?** Copilot does this because the cloud takes over. Ralph is local-only — the user should be left on the feature branch to review/merge. But storing `originalBranch` still helps for "discard and go back" scenarios.

4. **Multi-PRD branch collision**: With the proposed `<slug>-<hash>` naming, running the same PRD twice from the same HEAD produces the same branch name. Is this desired (idempotent resume) or should we add a timestamp/counter? If resume is handled via session persistence, idempotent naming may be fine.

5. **Protected branch list expansion**: Current hardcoded `['main', 'master']` default. Should this be derived from git config (e.g., the repo's default branch) or remain explicit? Copilot doesn't need this because it always creates — the concept of "protected" becomes irrelevant in a linear flow.
