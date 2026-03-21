## Aggregation Report 1

### Source Reports

- `research-1.md` — Maps the full gate: config-backed `protectedBranches`,
  deterministic `ralph/<slug>` derivation, the step-by-step decision tree,
  event outcomes, and the separate `atomicCommit` protection layer.
  [source: research-1.md#L7-L19]
  [source: research-1.md#L25-L34]
  [source: research-1.md#L38-L157]
- `research-2.md` — Focuses on intended happy paths and the silent else arm:
  start on `main`/`master` for auto-branching, resume to the expected branch,
  or silently continue on foreign non-protected branches like
  `bisect/v0.39-lean`.
  [source: research-2.md#L7-L31]
  [source: research-2.md#L33-L97]
- `research-3.md` — Explains dirty-tree behavior: no stash/detection/recovery,
  `checkout -b` usually carrying dirty state forward, existing-branch checkout
  failing on conflicts, and missing dirty-state test coverage.
  [source: research-3.md#L16-L41]
  [source: research-3.md#L57-L73]

### Deduplicated Findings

- Ralph derives the expected branch deterministically from the PRD H1 using a
  `ralph/` prefix and slugified title; for the examined PRD title, the result
  is `ralph/ralph-loop-v2-phase-1-self-fix-prd`. This means the user does not
  need to pre-name the branch, and Ralph can re-derive it on restart.
  [source: research-1.md#L25-L34]
  [source: research-2.md#L7-L31]
  [source: research-2.md#L78-L84]
- The branch gate runs once at loop start and has four normal outcomes plus
  one enforcement-failure exit: disabled → skip gate; expected branch →
  `BranchValidated`; protected branch → create or check out expected branch
  and emit `BranchCreated`; non-protected foreign branch → accept current
  branch silently; checkout/create failure → `BranchEnforcementFailed` and
  abort the run.
  [source: research-1.md#L40-L157]
  [source: research-2.md#L33-L49]
- The intended happy path is low-friction: start on `main` or `master`, let
  Ralph auto-create or re-enter the expected `ralph/` branch, and continue.
  The documented happy paths are start-on-main, already-on-expected, resume to
  existing expected branch, and feature-branch logic disabled.
  [source: research-1.md#L83-L119]
  [source: research-2.md#L64-L84]
- Silent adoption of foreign non-protected branches is intentional. A branch
  such as `bisect/v0.39-lean` fails both the "expected" and "protected"
  checks, falls into the else arm, becomes `activeBranch`, emits no branch
  event, and proceeds as-is.
  [source: research-1.md#L121-L144]
  [source: research-2.md#L51-L62]
- Protection is dual-layered only for protected branches: the startup gate
  tries to move work off `main`/`master`, and `atomicCommit` independently
  refuses commits on protected branches. However, `atomicCommit` does not
  enforce the expected `ralph/` branch, so silently adopted foreign branches
  still accept commits.
  [source: research-1.md#L137-L144]
  [source: research-1.md#L203-L209]
  [source: research-2.md#L105-L109]
- Dirty working tree handling is deliberately thin and fail-fast. The checkout
  helpers are raw `git checkout` / `git checkout -b` wrappers with no
  `git stash`, no dirty-tree preflight, no `-f`, and no recovery logic.
  [source: research-1.md#L163-L170]
  [source: research-3.md#L18-L31]
  [source: research-3.md#L77-L88]
- Dirty-state behavior is asymmetric: creating a new branch with
  `git checkout -b` usually preserves dirty changes, so first-run branch
  creation from `main` is generally safe; switching to an existing branch can
  fail if local changes would be overwritten, emit `BranchEnforcementFailed`,
  and terminate the loop.
  [source: research-1.md#L96-L119]
  [source: research-1.md#L239-L239]
  [source: research-3.md#L35-L41]
  [source: research-3.md#L92-L101]
- Once Ralph is running on an accepted branch, `atomicCommit` stages the
  entire working tree with `git add -A` and commits with `--no-verify`. That
  increases the blast radius of both silent branch pass-through and any manual
  dirty-state edits present in the repo.
  [source: research-3.md#L43-L55]
  [source: research-2.md#L88-L97]
- There are no substantive contradictions across the reports. Research 1 maps
  the gate, research 2 explains the user-facing happy/silent paths, and
  research 3 resolves the vague dirty-worktree concern into a concrete rule:
  new-branch creation usually carries dirty state, but existing-branch
  checkout is the real conflict point.
  [source: research-1.md#L231-L241]
  [source: research-2.md#L64-L97]
  [source: research-3.md#L35-L41]

### Cross-Report Patterns

- **Deterministic PRD-to-branch mapping** — The expected branch comes from the
  PRD H1, not manual naming, so branch identity is reproducible across first
  runs and restarts. [source: research-1.md#L25-L34]
  [source: research-2.md#L7-L31]
- **Protected-branch defense in depth** — Ralph combines a startup branch gate
  with an `atomicCommit` protected-branch refusal, giving high confidence that
  work will not commit directly to `main`/`master` when the intended path is
  followed. [source: research-1.md#L137-L144]
  [source: research-1.md#L203-L209]
  [source: research-2.md#L105-L109]
- **Permissive silent pass-through** — Non-protected foreign branches are
  accepted without warning or event emission, which supports manual/bisect
  workflows but also hides accidental branch drift.
  [source: research-1.md#L121-L131]
  [source: research-2.md#L46-L49]
  [source: research-2.md#L51-L62]
  [source: research-2.md#L88-L97]
- **Fail-fast enforcement with no recovery** — When enforcement needs a
  checkout and git refuses, Ralph stops the run rather than retrying,
  stashing, or recovering. Dirty existing-branch checkouts are the clearest
  example of this pattern. [source: research-1.md#L87-L105]
  [source: research-3.md#L25-L41]
  [source: research-3.md#L77-L88]
- **Partial observability** — Ralph emits `BranchValidated`, `BranchCreated`,
  and `BranchEnforcementFailed`, but the else arm emits nothing, so consumers
  can observe explicit enforcement yet miss silent pass-through.
  [source: research-1.md#L119-L144]
  [source: research-1.md#L203-L213]
  [source: research-2.md#L46-L49]
  [source: research-2.md#L111-L113]

### Priority Matrix

| Pattern | Impact | Effort | Sources (with line refs) |
|---|---|---|---|
| Add a warning or explicit event for foreign non-protected branch pass-through | High | Low-Medium | [source: research-1.md#L121-L131] [source: research-1.md#L233-L235] [source: research-2.md#L88-L97] [source: research-2.md#L127-L135] |
| Add dirty-tree preflight and/or auto-stash before existing-branch checkout | High | Medium | [source: research-1.md#L239-L239] [source: research-3.md#L35-L41] [source: research-3.md#L98-L101] |
| Clarify event semantics so "checked out existing expected branch" is distinct from "created new branch" | Medium | Low | [source: research-1.md#L111-L119] [source: research-1.md#L233-L235] |
| Decide whether commit guard should enforce the expected branch, not just protected branches | High | Medium | [source: research-1.md#L137-L144] [source: research-2.md#L105-L109] [source: research-2.md#L127-L129] |
| Add automated coverage for dirty-tree and branch-switch conflict scenarios | High | Medium | [source: research-3.md#L57-L73] |

### Gaps

- The reports do not include reproduced runtime traces or git transcripts for
  dirty-tree branch switching; current confidence comes from code inspection
  plus the absence of dedicated tests.
  [source: research-3.md#L57-L73]
- The reports identify, but do not resolve, title edge cases such as a missing
  PRD H1 yielding `ralph/prd` or a renamed H1 causing branch drift between
  runs.
  [source: research-1.md#L237-L241]
  [source: research-2.md#L127-L131]
- The reports stay anchored to exact `main`/`master` protection and do not
  explore broader branch policies such as `develop`, `release/*`, or
  `hotfix/*`.
  [source: research-1.md#L7-L19]
  [source: research-2.md#L133-L135]
- The reports establish that silent foreign-branch adoption is permissive, but
  they do not define the desired Copilot-side policy for when that behavior
  should be allowed versus blocked.
  [source: research-2.md#L117-L123]
  [source: research-2.md#L127-L135]

### Sources

- `research-1.md` — Ralph Orchestrator Branch Gate — Decision Tree
- `research-2.md` — Ralph Branch Enforcement Happy Paths
- `research-3.md` — How Ralph Handles Dirty Working Tree During Branch Operations
