# Research: Ralph Branch Enforcement Happy Paths

## Findings

### How `deriveBranchName` computes the expected branch

The function in `src/prd.ts` (lines 21–32):
1. Takes the PRD H1 title string
2. Lowercases it
3. Replaces all non-`[a-z0-9]` characters with `-`
4. Collapses consecutive hyphens to one
5. Strips leading/trailing hyphens
6. Falls back to `'prd'` if the slug is empty
7. Truncates slug to `50 - len("ralph/") = 44` chars (strips trailing hyphen after truncation)
8. Prepends `ralph/`

**Concrete trace for the actual PRD title:**

Title: `"Ralph Loop V2 — Phase 1 Self-Fix PRD"`

```
step 1: toLowerCase → "ralph loop v2 — phase 1 self-fix prd"
step 2: replace [^a-z0-9]+ with '-' → "ralph-loop-v2-phase-1-self-fix-prd"
   (the em-dash "—" and spaces are all non-alphanumeric, collapsed to single hyphens)
step 3: collapse -- → already clean
step 4: strip leading/trailing '-' → already clean
step 5: slug length = 34, maxSlug = 44 → no truncation
result: "ralph/ralph-loop-v2-phase-1-self-fix-prd"
```

**Expected branch: `ralph/ralph-loop-v2-phase-1-self-fix-prd`**

### The three-way branch gate in `orchestrator.ts` (lines 602–636)

The branch enforcement runs **once per loop start** and has exactly three branches:

```
if (currentBranch === expectedBranch)
    → BranchValidated, proceed (already on correct branch)
else if (protectedBranches.includes(currentBranch))
    → create or checkout expectedBranch, emit BranchCreated, proceed
else
    → log "on non-protected branch, proceeding", use currentBranch as-is
```

The `else` clause treats ANY non-protected, non-expected branch as acceptable. The orchestrator:
- Sets `this.activeBranch = currentBranch` (the whatever-you're-on branch)
- Does **not** emit any event (no `BranchCreated`, no `BranchValidated`, no `BranchEnforcementFailed`)
- Proceeds silently into the task loop

### Why `bisect/v0.39-lean` falls into the silent pass-through

Given:
- `expectedBranch = "ralph/ralph-loop-v2-phase-1-self-fix-prd"`
- `currentBranch = "bisect/v0.39-lean"`
- `protectedBranches = ["main", "master"]` (default)

Check 1: `"bisect/v0.39-lean" === "ralph/ralph-loop-v2-phase-1-self-fix-prd"` → **false**
Check 2: `["main", "master"].includes("bisect/v0.39-lean")` → **false**
→ Falls into **else**: silent pass-through, works on `bisect/v0.39-lean` without any branch switching.

This is **by design**. The intent is: "if you're on a non-protected branch that isn't the expected ralph/ branch, you presumably know what you're doing — proceed."

### Intended happy paths (from tests)

The test suite reveals **four documented happy paths** plus the silent else:

| Scenario | Starting branch | Action | Event |
|---|---|---|---|
| **HP1: Start on main** | `main` (protected) | Creates `ralph/<slug>` and checks it out | `BranchCreated` |
| **HP2: Already on expected** | `ralph/<slug>` | No-op, validates | `BranchValidated` |
| **HP3: Resume after restart** | `main` (but `ralph/<slug>` exists) | Checks out existing `ralph/<slug>` | `BranchCreated` |
| **HP4: Feature disabled** | any | Skips all branch logic | none |
| **Else: Non-protected foreign** | `feature/other-work`, `bisect/...` | Proceeds on current branch | none (just log) |

The **primary** happy path is HP1: user starts on `main`, ralph auto-creates and switches to `ralph/<slug>`.

### Is the user expected to pre-name branches?

**No.** The user is expected to:
1. **Start on `main`** (or `master`) — the orchestrator automatically derives and creates the `ralph/` branch
2. **Or** already be on the expected `ralph/<slug>` branch (HP2, e.g. after a prior run)

The user does NOT need to manually create `ralph/<slug>` branches. The system creates them automatically from the PRD title when starting from a protected branch.

### How cumbersome is this in practice?

**Not at all cumbersome for the intended workflow**, but **silently wrong for ad-hoc branches**:

- **Happy path**: Zero friction. Start on `main`, ralph handles everything.
- **Gotcha**: If you're on a non-protected, non-expected branch (like `bisect/v0.39-lean`), ralph silently proceeds on that branch. This means:
  - Commits land on the wrong branch
  - No warning is emitted
  - The user gets no feedback that branch enforcement was bypassed
  - `atomicCommit` will happily commit there (it only guards against protected branches)

The else clause's design philosophy is "trust the user on custom branches" but the lack of any event/warning makes it invisible when it happens accidentally.

## Patterns

1. **Slug-from-title derivation**: Branch names are deterministic and fully derived from the PRD's H1 title. No configuration needed. The `ralph/` prefix namespaces all ralph-managed branches.

2. **Three-tier gate pattern**: exact match → protected branch → else. This is a common pattern but the "else = silent pass-through" is unusual — most CI/CD systems would warn or enforce.

3. **Dual-layer protection**: Branch enforcement happens at two levels:
   - **Startup gate** (orchestrator): switches to correct branch before any work
   - **Commit guard** (atomicCommit): refuses to commit on protected branches
   
   But the commit guard only checks protected branches, not "expected branch". So commits on `bisect/v0.39-lean` pass both checks.

4. **Session persistence includes branch**: The `SessionPersistence` system stores `branchName` and detects mismatches on reload. But this only helps on resume, not first run.

5. **Event-driven observability gap**: `BranchValidated` and `BranchCreated` events exist, but there's no event for the else case. A `BranchPassThrough` or warning event would close this gap.

## Applicability

For the copilot-chat extension research: ralph's branch enforcement is a **self-contained, simple model** compared to what a VS Code extension PR workflow would need:

- **ralph assumes a single PRD = single branch** — maps well to feature-branch-per-task
- The slug derivation is deterministic and collision-resistant (title → slug → branch)
- The protected branch guard is a good pattern to prevent accidental main commits
- The silent else branch is a **design gap** that should be addressed — either warn or force the user to be on `main` or the expected branch
- The dual-layer protection (startup gate + commit guard) is a solid defense-in-depth pattern

## Open Questions

1. **Should the else branch warn?** Currently a user on `bisect/v0.39-lean` gets zero feedback. Should it emit a warning event like `BranchPassThrough` or even `BranchEnforcementFailed`?

2. **Should atomicCommit also check expectedBranch?** Currently it only guards protected branches. If the user drifted to a wrong branch mid-session, commits would land there silently.

3. **What happens with PRD title changes?** If the user renames the H1 heading mid-session, `deriveBranchName` produces a different slug. The orchestrator would then try to switch branches on next restart, potentially orphaning work on the old branch.

4. **Should `protectedBranches` include common patterns?** Only exact matches (`main`, `master`) are checked. Branches like `develop`, `release/*`, `hotfix/*` would not be protected by default.

5. **Is the pass-through intentional for agent-driven workflows?** In a Copilot agent context, the agent might start ralph from whatever branch Copilot is working on. The silent pass-through enables this, but at the cost of branch hygiene. Should there be an `enforce: strict` mode that refuses to run except from protected or expected branches?
