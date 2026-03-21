# Research Report: Ralph Orchestrator Branch Gate — Decision Tree

## Findings

### 1. Configuration Source

The branch gate is governed by a **local config object**, not any GitHub API. The relevant config type lives in [src/types.ts](src/types.ts#L538):

```ts
featureBranch?: { enabled: boolean; protectedBranches?: string[] };
```

Default value at [src/types.ts](src/types.ts#L578):

```ts
featureBranch: { enabled: true, protectedBranches: ['main', 'master'] },
```

Key: `protectedBranches` is a static string array from config. It defaults to `['main', 'master']` if not provided (fallback at L608 of orchestrator).

---

### 2. Branch Name Derivation Pipeline

**`parsePrdTitle()`** — [src/prd.ts, L12-17](src/prd.ts#L12-L17):
- Scans PRD content line-by-line for the first `# ` H1 heading.
- Returns the trimmed title string, or `undefined` if no H1 found.

**`deriveBranchName()`** — [src/prd.ts, L19-30](src/prd.ts#L19-L30):
- Prefix: `ralph/`
- Slug: lowercased title, non-alphanumeric → `-`, collapsed doubles, trimmed dashes.
- Fallback: if slug is empty, uses `'prd'`.
- Max length: 50 total (prefix + slug), trailing `-` stripped.
- Example: `"Ralph Loop V2 — Phase 1 Self-Fix PRD"` → `"ralph/ralph-loop-v2-phase-1-self-fix-prd"`

---

### 3. The Branch Gate — Step-by-Step Decision Tree

The gate fires **once per loop run**, at [src/orchestrator.ts, L601-636](src/orchestrator.ts#L601-L636), right after PRD validation and before the main task loop begins.

#### Gate Entry Condition (L603)

```
IF featureBranchConfig?.enabled === false (or featureBranch is undefined)
  → SKIP entire gate, no branch events, proceed on whatever branch user is on
  → activeBranch remains undefined
```

This is the **backward-compatible** path tested in test scenario (4).

#### Gate Variables (L604-608)

When enabled, these are computed:
- `prdContent` = read PRD file
- `prdTitle` = `parsePrdTitle(prdContent)` — may be `undefined`
- `expectedBranch` = `deriveBranchName(prdTitle ?? '')` — if title is undefined, produces `"ralph/prd"`
- `currentBranch` = `await getCurrentBranch(workspaceRoot)` — calls `git rev-parse --abbrev-ref HEAD`
- `protectedBranches` = config value or `['main', 'master']`

#### Decision Point 1 — Already on expected branch? (L610-613)

```
IF currentBranch === expectedBranch
  → LOG: "Branch gate: already on expected branch '<expectedBranch>'"
  → SET activeBranch = expectedBranch
  → YIELD: BranchValidated { branchName: expectedBranch }
  → CONTINUE to task loop
```

This is the happy-path "re-run" scenario — orchestrator already on the right branch.

#### Decision Point 2 — On a protected branch? (L614-632)

```
ELSE IF protectedBranches.includes(currentBranch)
  → Need to leave this protected branch
```

##### Sub-decision 2a — Expected branch already exists? (L615-621)

```
  IF await branchExists(workspaceRoot, expectedBranch)
    → Attempt: await checkoutBranch(workspaceRoot, expectedBranch)
      → runs `git checkout <expectedBranch>`
    
    IF checkout fails:
      → YIELD: BranchEnforcementFailed { reason: result.error ?? 'checkout failed' }
      → RETURN (abort entire loop — hard stop)
    
    IF checkout succeeds:
      → LOG: "Branch gate: checked out existing branch '<expectedBranch>'"
      → (falls through to post-block)
```

##### Sub-decision 2b — Expected branch does NOT exist (L622-629)

```
  ELSE (branch doesn't exist)
    → Attempt: await createAndCheckoutBranch(workspaceRoot, expectedBranch)
      → runs `git checkout -b <expectedBranch>`
    
    IF creation fails:
      → YIELD: BranchEnforcementFailed { reason: result.error ?? 'branch creation failed' }
      → RETURN (abort entire loop — hard stop)
    
    IF creation succeeds:
      → LOG: "Branch gate: created and checked out branch '<expectedBranch>'"
```

##### After either 2a or 2b succeeds (L631-632):

```
  → SET activeBranch = expectedBranch
  → YIELD: BranchCreated { branchName: expectedBranch }
  → CONTINUE to task loop
```

**Note:** Both checkout-existing and create-new yield `BranchCreated`, not `BranchValidated`. Only the "already on correct branch" path yields `BranchValidated`.

#### Decision Point 3 — On a non-protected, non-expected branch (L633-636)

```
ELSE (not on expected branch, not on a protected branch)
  → LOG: "Branch gate: on non-protected branch '<currentBranch>', proceeding"
  → SET activeBranch = currentBranch
  → NO event yielded
  → CONTINUE to task loop
```

This is the permissive fallback — if you're on `feat/other-work`, Ralph doesn't force you onto the expected branch. It just records whatever branch you're on.

---

### 4. Downstream Effects of `activeBranch`

**State snapshot** — [src/orchestrator.ts, L383](src/orchestrator.ts#L383):
`activeBranch` is exposed via `getStateSnapshot()` as the `branch` field of `StateSnapshot` (type at [src/types.ts, L43](src/types.ts#L43)).

**Session persistence** — The session system saves `branchName` and detects mismatches on reload (tested in E2E scenario 2). If the stored branch doesn't match the current branch, `branchMismatch: true` is set.

**`atomicCommit` protection** — [src/gitOps.ts, L64-70](src/gitOps.ts#L64-L70): Independent of the branch gate, `atomicCommit` has its own protection — if `protectedBranches` is passed and `currentBranch` is in the list, commit is **refused** with error `"Refusing to commit on protected branch '<X>'"`.

**`STATE_CHANGE_EVENTS`** — [src/orchestrator.ts, L393-401](src/orchestrator.ts#L393-L401): Branch events (`BranchCreated`, `BranchValidated`, `BranchEnforcementFailed`) are NOT in `STATE_CHANGE_EVENTS`, but `BranchEnforcementFailed` IS checked at [L428](src/orchestrator.ts#L428) in the event handler as a loop-halt condition.

---

### 5. Event Summary Table

| Scenario | Event Yielded | `activeBranch` | Loop continues? |
|---|---|---|---|
| Feature disabled | (none) | `undefined` | Yes |
| Already on expected branch | `BranchValidated` | expectedBranch | Yes |
| On protected → existing branch checkout OK | `BranchCreated` | expectedBranch | Yes |
| On protected → new branch creation OK | `BranchCreated` | expectedBranch | Yes |
| On protected → checkout/creation fails | `BranchEnforcementFailed` | (not set) | **No — returns** |
| On non-protected, non-expected branch | (none) | currentBranch | Yes |

---

### 6. Git Operations Detail

All git operations use `execFile` (no shell) with `cwd: workspaceRoot` and 10MB buffer ([src/gitOps.ts, L18-25](src/gitOps.ts#L18-L25)).

| Function | Git Command | Returns |
|---|---|---|
| `getCurrentBranch` | `git rev-parse --abbrev-ref HEAD` | branch name or `'HEAD'` |
| `branchExists` | `git rev-parse --verify refs/heads/<name>` | `boolean` |
| `createAndCheckoutBranch` | `git checkout -b <name>` | `{ success, error? }` |
| `checkoutBranch` | `git checkout <name>` | `{ success, error? }` |

---

### 7. Complete Decision Tree (ASCII)

```
featureBranch.enabled?
├── NO → skip gate, activeBranch=undefined, no events
└── YES
    ├── Compute: prdTitle, expectedBranch, currentBranch, protectedBranches
    │
    ├── currentBranch === expectedBranch?
    │   └── YES → activeBranch=expected, yield BranchValidated
    │
    ├── protectedBranches.includes(currentBranch)?
    │   └── YES
    │       ├── branchExists(expectedBranch)?
    │       │   ├── YES → checkoutBranch(expected)
    │       │   │   ├── FAIL → yield BranchEnforcementFailed, RETURN
    │       │   │   └── OK → activeBranch=expected, yield BranchCreated
    │       │   └── NO → createAndCheckoutBranch(expected)
    │       │       ├── FAIL → yield BranchEnforcementFailed, RETURN
    │       │       └── OK → activeBranch=expected, yield BranchCreated
    │
    └── ELSE (non-protected, non-expected)
        └── activeBranch=currentBranch, no events, proceed
```

---

## Patterns

1. **Config-driven safety gate**: Protection is a local config array, not a runtime API call. Simple and fast, but requires config to stay in sync with actual protected branches.

2. **Fail-hard on enforcement failure**: If git operations fail during enforcement, the entire loop aborts (`return`). No retry, no fallback. This is the strictest pattern possible.

3. **Permissive non-protected path**: If you're on a branch that's neither protected nor expected, Ralph just goes with it. No warning event, no enforcement. This allows manual branch workflows.

4. **Dual-layer protection**: The branch gate protects at loop-start, AND `atomicCommit` independently refuses commits on protected branches. Defense in depth — even if the gate is bypassed somehow, commits still won't land on main.

5. **Event-driven observability**: Three distinct event kinds (`BranchCreated`, `BranchValidated`, `BranchEnforcementFailed`) give consumers clear signals for UI updates, logging, and session persistence.

6. **Deterministic branch naming**: `deriveBranchName` is a pure function — same PRD title always produces the same branch name. This enables the "resume" pattern where orchestrator can re-derive the branch name without storing it.

---

## Applicability

This branch gate pattern is relevant to any autonomous coding agent that:
- Makes git commits as part of its workflow
- Needs to protect production branches from accidental modification
- Wants deterministic, reproducible branch naming from task metadata
- Requires session resumption with branch context

The dual-layer protection (gate + commit guard) is a good pattern for any system where defense-in-depth against protected-branch contamination is needed.

The "permissive non-protected" fallback is notable — it means Ralph can be used on manually-created feature branches without interference, which is important for integration with existing developer workflows.

---

## Open Questions

1. **No `BranchValidated` on checkout-existing**: When the orchestrator checks out an existing feature branch from a protected branch, it yields `BranchCreated` rather than `BranchValidated`. Is this intentional? It could confuse event consumers who interpret `BranchCreated` as "new branch" vs "switched to existing".

2. **No event on non-protected path**: When on a non-protected, non-expected branch, no event is yielded. Consumers have no signal that the branch gate ran at all. Should there be a `BranchSkipped` or `BranchAccepted` event?

3. **Edge case: `prdTitle` is undefined**: If the PRD has no H1 heading, `parsePrdTitle` returns `undefined`, and `deriveBranchName(undefined ?? '')` produces `'ralph/prd'`. This is a fallback but could collide if multiple PRDs lack titles.

4. **No dirty-worktree check**: The gate doesn't check for uncommitted changes before switching branches. If the working directory is dirty, `git checkout` will fail, and the orchestrator will abort. A pre-check with a user-friendly error would be more robust.

5. **Session branch mismatch handling**: The session persistence detects branch mismatches but the orchestrator branch gate doesn't consume session data. The gate always re-derives from PRD. What happens if the PRD title changes between runs?
