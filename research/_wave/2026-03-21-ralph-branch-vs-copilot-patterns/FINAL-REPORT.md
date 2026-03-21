# Final Report: Ralph Branch Gate vs Copilot Isolation Patterns

## Executive Summary

- Ralph does not universally "expect main"; it expects to leave whatever is in
  locally configured `protectedBranches`—typically `main`/`master` in the
  current reports—and move to a deterministic `ralph/<slug>` branch. If the
  user starts on a non-protected foreign branch, Ralph silently adopts it.
  [via: aggregation-1.md#L5-L10 ← research-1.md#L7-L19]
  [via: aggregation-1.md#L25-L31 ← research-1.md#L25-L34]
  [via: aggregation-1.md#L32-L39 ← research-1.md#L40-L157]
  [via: aggregation-1.md#L46-L51 ← research-2.md#L51-L62]
- `protectedBranches` comes from Ralph's own local config, not GitHub branch
  protection metadata.
  [via: aggregation-1.md#L5-L10 ← research-1.md#L7-L19]
- Dirty working trees are not actively handled: no preflight, no stash, and no
  recovery. Fresh branch creation usually carries dirty state forward, but
  checking out an existing branch can fail and abort the loop.
  [via: aggregation-1.md#L60-L65 ← research-3.md#L18-L31]
  [via: aggregation-1.md#L66-L74 ← research-3.md#L35-L41]
- `atomicCommit` stages the whole tree with `git add -A` and only blocks
  commits on protected branches, so silently adopted foreign branches can still
  receive commits.
  [via: aggregation-1.md#L52-L59 ← research-1.md#L203-L209]
  [via: aggregation-1.md#L75-L80 ← research-3.md#L43-L55]
- Copilot uses isolation-first branching. Cloud delegation snapshots the user
  state onto a temporary `copilot/vscode-*` branch, commits and pushes it,
  passes `head_ref`, and switches back. Local/background sessions isolate work
  in a separate worktree and let the user apply or merge later.
  [via: aggregation-2.md#L9-L16 ← research-4.md#L14-L78]
  [via: aggregation-2.md#L10-L10 ← research-5.md#L15-L90]
  [via: aggregation-2.md#L14-L14 ← research-5.md#L137-L146]
  [via: aggregation-2.md#L22-L23 ← research-4.md#L47-L78]
- The cleanest Ralph simplification is to always create a disposable Ralph
  branch from the current branch/HEAD, persist `originalBranch`, remove silent
  adoption, and let the user merge or discard the result later.
  [via: aggregation-2.md#L15-L16 ← research-6.md#L114-L196]
  [via: aggregation-2.md#L21-L23 ← research-6.md#L114-L174]
- A practical name is `ralph/<slug>-<short-hash>`: human-readable like today,
  collision-resistant like Copilot's temp branches.
  [via: aggregation-2.md#L11-L11 ← research-6.md#L5-L20]

## Consolidated Findings

### Ralph branch gate today

- `protectedBranches` is a local Ralph configuration list. In the current
  evidence it covers `main`/`master`, but the mechanism is Ralph-owned config,
  not GitHub policy.
  [via: aggregation-1.md#L5-L10 ← research-1.md#L7-L19]
- Ralph derives `expectedBranch` from the PRD H1 as `ralph/<slug>`, which is
  why the same branch can be re-derived on restart without user input.
  [via: aggregation-1.md#L25-L31 ← research-1.md#L25-L34]
  [via: aggregation-1.md#L92-L95 ← research-2.md#L7-L31]
- Startup behavior has five outcomes: feature-branch logic disabled, already on
  expected branch, protected branch that triggers create/checkout of the
  expected branch, foreign non-protected branch that is accepted silently, and
  checkout/create failure that aborts with `BranchEnforcementFailed`.
  [via: aggregation-1.md#L32-L39 ← research-1.md#L40-L157]
  [via: aggregation-1.md#L115-L120 ← research-2.md#L111-L113]
- The "expects main" intuition is only true for the intended happy path:
  Ralph is designed to start from `main`/`master` and move off it, but if the
  user starts from a non-protected branch, Ralph does not force a switch.
  [via: aggregation-1.md#L40-L45 ← research-2.md#L64-L84]
  [via: aggregation-1.md#L46-L51 ← research-2.md#L51-L62]
- `atomicCommit` is a separate safety layer. It blocks commits on protected
  branches only; it does not enforce the deterministic Ralph branch.
  [via: aggregation-1.md#L52-L59 ← research-1.md#L137-L144]
  [via: aggregation-1.md#L96-L101 ← research-2.md#L105-L109]

### Dirty working tree handling

- Dirty working tree handling is minimal by design: Ralph wraps raw
  `git checkout` / `git checkout -b` operations with no dirty-tree preflight,
  no stash, no force flag, and no recovery path.
  [via: aggregation-1.md#L60-L65 ← research-1.md#L163-L170]
  [via: aggregation-1.md#L109-L114 ← research-3.md#L77-L88]
- New-branch creation from the current checkout usually carries dirty changes
  forward, so first-run branch creation is usually safe enough.
  [via: aggregation-1.md#L66-L74 ← research-3.md#L35-L41]
- The real failure mode is switching to an existing branch while dirty: Git can
  refuse the checkout, Ralph emits `BranchEnforcementFailed`, and the loop
  stops.
  [via: aggregation-1.md#L66-L74 ← research-3.md#L92-L101]
- Once Ralph is running on any accepted branch, `atomicCommit` stages the full
  working tree and commits with `--no-verify`, which increases the blast radius
  of silent branch pass-through and pre-existing dirty edits.
  [via: aggregation-1.md#L75-L80 ← research-3.md#L43-L55]
  [via: aggregation-1.md#L102-L108 ← research-2.md#L88-L97]

### Copilot branching patterns

- Copilot uses two isolation models rather than one universal branch policy:
  cloud delegation uses a temporary pushed branch, while local/background work
  uses a separate worktree.
  [via: aggregation-2.md#L9-L10 ← research-4.md#L14-L78]
  [via: aggregation-2.md#L14-L14 ← research-5.md#L137-L146]
- In the cloud path, Copilot captures the current branch, creates a randomized
  `copilot/vscode-*` branch, commits and pushes dirty state, passes it as
  `head_ref`, then switches back before the remote agent creates the PR.
  [via: aggregation-2.md#L10-L10 ← research-4.md#L18-L46]
  [via: aggregation-2.md#L10-L10 ← research-4.md#L79-L107]
- In the local/background path, Copilot avoids branch switching in the user's
  main workspace by running in a worktree and later asking the user to apply,
  merge, or discard the isolated work.
  [via: aggregation-2.md#L22-L23 ← research-4.md#L47-L78]
  [via: aggregation-2.md#L22-L23 ← research-5.md#L101-L146]
- Copilot explicitly remembers origin. That rollback-friendly pattern is the
  biggest gap between Copilot's design and Ralph's current `activeBranch`-only
  state.
  [via: aggregation-2.md#L13-L13 ← research-4.md#L29-L35]
  [via: aggregation-2.md#L21-L21 ← research-5.md#L137-L153]

### Main synthesis

- Ralph's current gate mixes two concerns: protecting important branches and
  choosing the branch where Ralph should work. Copilot simplifies this by
  isolating work first and making later merge or apply actions explicit.
  [via: aggregation-1.md#L32-L39 ← research-1.md#L40-L157]
  [via: aggregation-2.md#L19-L23 ← research-4.md#L122-L151]
- The user's insight matches the strongest cross-report recommendation:
  Ralph should behave more like a disposable PR-style worker that branches from
  whatever the user currently has checked out, then lets the user merge or
  discard the result afterward.
  [via: aggregation-2.md#L15-L16 ← research-6.md#L114-L196]
  [via: aggregation-2.md#L21-L23 ← research-6.md#L80-L174]

## Pattern Catalog

### Pattern 1: Local protection list, not GitHub protection

Ralph's `protectedBranches` is a local policy knob. Today it drives startup
branching decisions and protected-branch commit refusal, but it is not sourced
from GitHub branch protection rules.
[via: aggregation-1.md#L5-L10 ← research-1.md#L7-L19]
[via: aggregation-1.md#L52-L59 ← research-1.md#L203-L209]

### Pattern 2: Silent foreign-branch adoption

If the user starts on a branch that is neither the expected Ralph branch nor a
protected branch, Ralph silently accepts it, emits no dedicated event, and
continues there. This is why a branch like `bisect/v0.39-lean` can become the
active work branch without warning.
[via: aggregation-1.md#L46-L51 ← research-1.md#L121-L144]
[via: aggregation-1.md#L115-L120 ← research-2.md#L46-L49]

### Pattern 3: Dirty existing-branch checkout is the sharp edge

The dangerous branch operation is not creating a fresh branch from current
state; it is trying to switch to an existing branch while local changes are
present. That means Ralph's current reuse logic is riskier than a pure
always-create flow.
[via: aggregation-1.md#L66-L74 ← research-3.md#L35-L41]
[via: aggregation-1.md#L66-L74 ← research-3.md#L92-L101]

### Pattern 4: Copilot cloud snapshot branch

Copilot's cloud workflow treats the branch as disposable transport: snapshot
current state, create a randomized temp branch, commit and push, hand that ref
to the remote PR workflow, then switch the user back.
[via: aggregation-2.md#L10-L10 ← research-4.md#L18-L46]
[via: aggregation-2.md#L14-L14 ← research-5.md#L59-L100]

### Pattern 5: Copilot local worktree isolation

Copilot's local/background workflow treats isolation even more strictly by
moving execution into a worktree. The user later chooses whether to apply,
merge, or discard that isolated work.
[via: aggregation-2.md#L22-L23 ← research-4.md#L47-L78]
[via: aggregation-2.md#L22-L23 ← research-5.md#L183-L192]

### Pattern 6: Proposed Ralph disposable PR-style branch

The simplest Ralph refactor is a linear isolation flow:

1. Capture `originalBranch` and `baseCommit` from whatever is currently checked
   out.
2. Generate `workingBranch = ralph/<slug>-<short-hash>`.
3. Create that branch from current `HEAD` instead of deciding whether to reuse
   or silently adopt another branch.
4. Persist `originalBranch`, `workingBranch`, `baseCommit`, and whether the
   session started dirty.
5. Run Ralph only on `workingBranch`.
6. On completion, surface explicit "merge or discard" next actions, with an
   optional switch back to `originalBranch`.

This keeps the user's current base branch meaningful, removes the ambiguous
else-arm, and mirrors Copilot's disposable-isolation model without requiring
full worktree support on day one.
[via: aggregation-2.md#L11-L11 ← research-6.md#L114-L126]
[via: aggregation-2.md#L15-L16 ← research-6.md#L114-L196]
[via: aggregation-2.md#L21-L23 ← research-6.md#L80-L174]
[via: aggregation-1.md#L66-L74 ← research-3.md#L35-L41]

## Priority Matrix

| Change | Impact | Effort | Priority | Sources |
|---|---|---|---|---|
| Add dirty-state preflight and explicit dirty-session metadata before any branch operation | High | Low | P1 | [via: aggregation-2.md#L28-L28 ← research-6.md#L48-L57] [via: aggregation-1.md#L60-L74 ← research-3.md#L18-L41] |
| Persist `originalBranch` and `baseCommit` alongside the working branch | High | Low | P1 | [via: aggregation-2.md#L29-L29 ← research-6.md#L58-L69] [via: aggregation-2.md#L13-L13 ← research-5.md#L147-L153] |
| Replace the 3-way gate with a linear always-create disposable branch flow from current `HEAD` | High | Medium | P1 | [via: aggregation-2.md#L30-L30 ← research-6.md#L21-L47] [via: aggregation-2.md#L15-L16 ← research-6.md#L114-L180] |
| Remove silent adoption and emit explicit isolation events instead | High | Low-Medium | P1 | [via: aggregation-1.md#L127-L127 ← research-1.md#L121-L131] [via: aggregation-1.md#L115-L120 ← research-2.md#L111-L113] |
| Switch naming from `ralph/<slug>` to `ralph/<slug>-<short-hash>` | Medium | Low | P2 | [via: aggregation-2.md#L31-L31 ← research-6.md#L5-L20] [via: aggregation-2.md#L11-L11 ← research-4.md#L18-L24] |
| Demote `protectedBranches` from branch-selection logic to a safety-only guard | Medium | Low | P2 | [via: aggregation-1.md#L5-L10 ← research-1.md#L7-L19] [via: aggregation-1.md#L52-L59 ← research-1.md#L203-L209] [via: aggregation-2.md#L15-L16 ← research-6.md#L114-L180] |
| Evaluate optional worktree mode after the branch-based isolation flow is stable | High | Medium-High | P3 | [via: aggregation-2.md#L32-L32 ← research-4.md#L47-L78] [via: aggregation-2.md#L22-L23 ← research-5.md#L101-L146] |

## Recommended Plan

1. Replace Ralph's startup gate with an isolation-first flow that always creates
   a new Ralph-managed branch from the user's current `HEAD`.
   Dependency: none.
   [via: aggregation-2.md#L15-L16 ← research-6.md#L114-L180]
2. Add dirty-state preflight. For v1, detect and record dirty state up front;
   allow it only for fresh branch creation from current `HEAD`, and never do an
   implicit switch to an existing branch while dirty.
   Dependency: step 1.
   [via: aggregation-1.md#L66-L74 ← research-3.md#L35-L41]
   [via: aggregation-2.md#L28-L28 ← research-6.md#L48-L57]
3. Persist `originalBranch`, `workingBranch`, `baseCommit`, and `startedDirty`
   in Ralph's session state. Resume should prefer the stored session branch, not
   a freshly re-derived deterministic name alone.
   Dependency: step 1.
   [via: aggregation-2.md#L29-L29 ← research-6.md#L58-L69]
4. Remove silent pass-through and replace it with explicit events such as
   `BranchIsolated`, `BranchResumed`, and `BranchIsolationFailed`.
   Dependency: steps 1-3.
   [via: aggregation-1.md#L115-L120 ← research-2.md#L111-L113]
   [via: aggregation-1.md#L127-L129 ← research-1.md#L233-L235]
5. Keep `protectedBranches` only as a defensive fallback, not as the primary
   branch-selection mechanism. Its job becomes "never commit here" or "never
   run without isolation," not "decide whether Ralph branches at all."
   Dependency: steps 1-4.
   [via: aggregation-1.md#L5-L10 ← research-1.md#L7-L19]
   [via: aggregation-1.md#L52-L59 ← research-1.md#L203-L209]
6. After the branch-based version is stable, evaluate a worktree mode for even
   stronger isolation and cleaner discard semantics.
   Dependency: steps 1-5.
   [via: aggregation-2.md#L22-L23 ← research-4.md#L134-L151]

## Gaps & Further Research

- Copilot cleanup is still partially opaque: the reports do not confirm how
  temporary `copilot/vscode-*` branches are cleaned up after PR completion.
  [via: aggregation-2.md#L35-L37 ← research-4.md#L152-L162]
- Worktree lifecycle policy is also still unclear; creation and apply/merge are
  documented, but pruning and deletion are not.
  [via: aggregation-2.md#L35-L36 ← research-5.md#L193-L199]
- Ralph still needs an explicit product choice on completion semantics:
  automatically switch back to `originalBranch`, stay on the disposable branch,
  or make that user-configurable.
  [via: aggregation-2.md#L38-L38 ← research-6.md#L197-L207]
- Dirty-state policy also needs one final decision: simple detection plus
  carry-forward on fresh branch creation, auto-stash, or auto-commit.
  [via: aggregation-2.md#L38-L38 ← research-6.md#L197-L207]
- The proposed simplification should be validated against real git scenarios
  involving untracked files, renames, and deletes to confirm that the
  always-create flow really eliminates the current sharp edges.
  [via: aggregation-1.md#L135-L138 ← research-3.md#L57-L73]
  [via: aggregation-1.md#L66-L74 ← research-3.md#L92-L101]

## Source Chain

- `aggregation-1.md` → `research-1.md`, `research-2.md`, `research-3.md`
- `aggregation-2.md` → `research-4.md`, `research-5.md`, `research-6.md`
- Traceability is intentionally progressive-disclosure style:
  `FINAL-REPORT.md` → `aggregation-*.md` → `research-*.md`.
