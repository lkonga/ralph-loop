# Final Report: Ralph-loop feature branch enforcement

## Executive Summary
- Ralph-loop is branch-blind today: it does not create, switch, or validate branches, and `atomicCommit` will commit on whatever HEAD is active, including `main` or detached HEAD. [via: aggregation-1.md#L9-L17 ← research-1.md#L58-L82] [via: aggregation-1.md#L9-L17 ← research-2.md#L104-L130]
- The strongest control point is a one-time startup gate in core orchestration before the first task begins; a top-of-`atomicCommit` check is useful only as defense in depth. [via: aggregation-1.md#L28-L29 ← research-3.md#L156-L176] [via: aggregation-2.md#L33-L33 ← research-4.md#L151-L167] [via: aggregation-1.md#L29-L29 ← research-2.md#L137-L149]
- Hooks are the wrong primary enforcement layer because they are optional and fault-tolerant; core logic should own the rule and hooks should remain extensions or notifications. [via: aggregation-2.md#L10-L19 ← research-5.md#L112-L151]
- A backward-compatible rollout fits an optional config surface loaded once at startup, such as `featureBranch?: string`, with empty or `undefined` meaning no enforcement. [via: aggregation-2.md#L31-L31 ← research-6.md#L22-L123] [via: aggregation-2.md#L10-L19 ← research-6.md#L169-L236]
- Expected branch identity should derive from a slugified PRD H1, not the default `PRD.md` filename. [via: aggregation-3.md#L30-L30 ← research-7.md#L20-L31] [via: aggregation-3.md#L9-L18 ← research-7.md#L56-L65]
- Branch state should be surfaced through branch events, `StateSnapshot.branch`, and branch-aware notifications so UI, logs, and external consumers share the same branch truth. [via: aggregation-3.md#L31-L31 ← research-8.md#L157-L196]
- Failure handling should preserve the feature branch, optionally stash dirty work, and persist branch identity for resume validation instead of resetting or deleting the branch. [via: aggregation-3.md#L32-L33 ← research-9.md#L137-L176] [via: aggregation-3.md#L33-L33 ← research-7.md#L88-L107]
- Branch enforcement does not fix the existing `git add -A` contamination and parallel staging race; that remains a separate follow-up with high integrity value. [via: aggregation-1.md#L30-L30 ← research-2.md#L42-L49] [via: aggregation-1.md#L30-L30 ← research-2.md#L77-L103]

## Consolidated Findings (by category, deduplicated)

### Current git behavior and residual risk

- Ralph-loop currently has a commit-only git workflow: task completion flows into `atomicCommit`, which stages everything with `git add -A`, generates a commit message, commits with `--no-verify`, and records the new SHA, with no branch-management commands or branch-policy config in place. [via: aggregation-1.md#L9-L17 ← research-1.md#L49-L57] [via: aggregation-1.md#L9-L17 ← research-2.md#L25-L103]
- Because the current flow is branch-agnostic, the loop can commit on `main` or detached HEAD, and branch enforcement alone will not prevent cross-task bleed-through from `git add -A`, parallel completions, or dirty-index residue after failure. [via: aggregation-1.md#L9-L17 ← research-1.md#L58-L82] [via: aggregation-1.md#L9-L17 ← research-2.md#L77-L149]

### Enforcement location and ownership

- The shared conclusion across the reports is to enforce branch policy once during startup before the first task executes; the cleanest validate-only seam is in `runLoop()` after preflight validation or bearings and before task work begins. [via: aggregation-1.md#L9-L17 ← research-3.md#L97-L176] [via: aggregation-2.md#L10-L19 ← research-4.md#L151-L167]
- Mandatory enforcement should live in core orchestrator logic rather than hooks, because hooks are intentionally fault-tolerant and may degrade to `continue`; hooks fit better as notification and customization points after core validation. [via: aggregation-2.md#L10-L19 ← research-5.md#L112-L151] [via: aggregation-2.md#L20-L26 ← research-5.md#L128-L151]
- A top-of-`atomicCommit` branch check is useful defense in depth, but it should backstop rather than replace the startup gate. [via: aggregation-1.md#L29-L29 ← research-2.md#L137-L149]

### Policy surface and branch identity

- Backward-compatible rollout fits an optional configuration surface loaded once at startup, such as top-level `featureBranch?: string`, with `undefined` or empty meaning "no enforcement". [via: aggregation-2.md#L31-L31 ← research-6.md#L22-L123] [via: aggregation-2.md#L10-L19 ← research-6.md#L169-L236]
- Expected branch identity should come from PRD content, not the path `PRD.md`: a slugified PRD H1 is the strongest deterministic name source, with phase context as an optional suffix only if finer granularity is genuinely needed. [via: aggregation-3.md#L30-L30 ← research-7.md#L20-L31] [via: aggregation-3.md#L9-L18 ← research-7.md#L56-L65]
- Git support already exists for command execution and commit flow, so the main missing primitives are helper methods for current-branch lookup and optional create or switch behavior plus final decisions on naming prefix, length limits, collisions, and multi-PRD branch selection. [via: aggregation-2.md#L32-L32 ← research-5.md#L95-L104] [via: aggregation-2.md#L32-L32 ← research-6.md#L210-L228] [via: aggregation-3.md#L36-L43 ← research-7.md#L58-L84] [via: aggregation-3.md#L36-L43 ← research-7.md#L111-L114]
- The evidence supports fail-fast validation as the default direction; no report recommends auto-creating or auto-switching branches as the baseline behavior. [via: aggregation-1.md#L33-L39 ← research-1.md#L58-L77] [via: aggregation-2.md#L10-L19 ← research-5.md#L143-L151]

### Observability, resume, and cleanup

- Branch awareness should be threaded through the existing state and event pipeline via explicit branch events, `StateSnapshot.branch`, and branch-bearing notification payloads so UI, logs, and extension consumers all see the same branch truth. [via: aggregation-3.md#L31-L31 ← research-8.md#L157-L196] [via: aggregation-3.md#L19-L25 ← research-8.md#L157-L196]
- Resume integrity requires durable branch identity: the chosen or expected branch should be stored in session state and compared against current git state when resuming or when external branch switches are detected. [via: aggregation-3.md#L33-L33 ← research-9.md#L159-L176] [via: aggregation-3.md#L19-L25 ← research-7.md#L88-L107]
- Failure cleanup should preserve the feature branch, prefer optional stashing plus inspection over reset or delete behavior, and align with existing yield semantics as the clean reference interruption path. [via: aggregation-3.md#L32-L32 ← research-9.md#L35-L50] [via: aggregation-3.md#L32-L32 ← research-9.md#L137-L153] [via: aggregation-3.md#L19-L25 ← research-8.md#L34-L39]

## Pattern Catalog

### 1. Startup-only core branch gate

Implementation details:
- Add a single branch-policy validation before the first task begins.
- For validate-only behavior, the post-bearings / pre-task seam is the highest-confidence insertion point.
- If the product later adopts create-or-switch behavior, that operation should move early enough that startup hooks and downstream startup state observe the correct branch.
- On mismatch, emit an explicit validation or mismatch signal and stop before task execution.

Sources: [via: aggregation-1.md#L28-L28 ← research-3.md#L156-L176] [via: aggregation-2.md#L33-L33 ← research-4.md#L151-L167] [via: aggregation-2.md#L33-L33 ← research-5.md#L143-L151]

### 2. Optional config plus git helper layer

Implementation details:
- Add an optional top-level config field for branch enforcement, keeping empty or undefined as a no-op for backward compatibility.
- Reuse existing git plumbing, but add focused helpers for current-branch lookup and, only if explicitly desired, create or checkout behavior.
- Keep the enforcement rule independent from per-task bearings repetition.

Sources: [via: aggregation-2.md#L31-L31 ← research-6.md#L22-L123] [via: aggregation-2.md#L32-L32 ← research-5.md#L95-L104] [via: aggregation-2.md#L32-L32 ← research-6.md#L210-L228] [via: aggregation-2.md#L35-L35 ← research-4.md#L84-L148]

### 3. PRD-derived deterministic branch identity

Implementation details:
- Parse the PRD H1 and slugify it into the expected branch name.
- Treat phase suffixing as optional, not default, until a more granular policy is proven necessary.
- Record the resolved branch name so later resume or mismatch checks compare against the same canonical value.

Sources: [via: aggregation-3.md#L30-L30 ← research-7.md#L20-L31] [via: aggregation-3.md#L30-L30 ← research-7.md#L56-L65] [via: aggregation-3.md#L33-L33 ← research-7.md#L88-L107]

### 4. Branch-aware events and state snapshot

Implementation details:
- Add explicit branch lifecycle events such as validation success and mismatch.
- Extend `StateSnapshot` with `branch?: string`.
- Propagate branch details through snapshot APIs and cross-extension notifications so observability stays consistent.

Sources: [via: aggregation-3.md#L31-L31 ← research-8.md#L157-L196] [via: aggregation-3.md#L9-L18 ← research-8.md#L110-L122]

### 5. Resume-safe cleanup and preservation

Implementation details:
- Preserve the feature branch on failure rather than deleting or resetting it.
- Optionally stash dirty work on non-graceful exits, leaving a user-inspectable recovery trail.
- Validate the stored branch on resume so the loop can detect manual branch changes or mismatched recovery state.

Sources: [via: aggregation-3.md#L32-L32 ← research-9.md#L35-L50] [via: aggregation-3.md#L32-L32 ← research-9.md#L137-L153] [via: aggregation-3.md#L33-L33 ← research-9.md#L159-L176]

### 6. Defense in depth and integrity follow-up

Implementation details:
- Add a top-of-`atomicCommit` branch re-check as a secondary safety net.
- Treat commit isolation as a separate hardening track: branch enforcement does not remove `git add -A` contamination or parallel staging races.

Sources: [via: aggregation-1.md#L29-L29 ← research-2.md#L137-L149] [via: aggregation-1.md#L30-L30 ← research-2.md#L42-L49] [via: aggregation-1.md#L30-L30 ← research-2.md#L77-L103]

## Priority Matrix

| Item | Impact | Effort | Priority | Sources with line refs |
| --- | --- | --- | --- | --- |
| Startup gate before first task work | High | Low-Medium | P0 | [via: aggregation-1.md#L28-L28 ← research-3.md#L156-L176] [via: aggregation-2.md#L33-L33 ← research-4.md#L151-L167] |
| Optional config surface | High | Low | P0 | [via: aggregation-2.md#L31-L31 ← research-6.md#L22-L123] [via: aggregation-2.md#L10-L19 ← research-6.md#L169-L236] |
| Git branch helper layer | High | Low-Medium | P0 | [via: aggregation-2.md#L32-L32 ← research-5.md#L95-L104] [via: aggregation-2.md#L32-L32 ← research-6.md#L210-L228] |
| PRD-derived expected branch slug | High | Low | P0 | [via: aggregation-3.md#L30-L30 ← research-7.md#L20-L31] [via: aggregation-3.md#L30-L30 ← research-7.md#L56-L65] |
| Branch events plus `StateSnapshot.branch` | High | Medium | P1 | [via: aggregation-3.md#L31-L31 ← research-8.md#L157-L196] |
| Persist branch identity for resume | High | Low-Medium | P1 | [via: aggregation-3.md#L33-L33 ← research-9.md#L159-L176] [via: aggregation-3.md#L33-L33 ← research-7.md#L88-L107] |
| Preserve branch and optionally stash on failure | High | Medium | P1 | [via: aggregation-3.md#L32-L32 ← research-9.md#L35-L50] [via: aggregation-3.md#L32-L32 ← research-9.md#L137-L153] |
| Stage isolation or commit serialization follow-up | High | Medium | P1 | [via: aggregation-1.md#L30-L30 ← research-2.md#L42-L49] [via: aggregation-1.md#L30-L30 ← research-2.md#L77-L103] |
| `atomicCommit` defensive re-check | Medium | Low | P2 | [via: aggregation-1.md#L29-L29 ← research-2.md#L137-L149] |
| Hooks as notification or customization only | Medium | Medium | P2 | [via: aggregation-2.md#L34-L34 ← research-5.md#L112-L151] |

## Recommended Plan

1. **Lock the policy contract first.** Decide mismatch behavior, exact config shape, expected naming schema, and dirty-worktree policy before coding. Dependencies: none. [via: aggregation-2.md#L37-L43 ← research-4.md#L223-L227] [via: aggregation-3.md#L36-L43 ← research-7.md#L58-L84]
2. **Add the primitives.** Implement PRD H1 extraction and slugification, config loading, and git helpers for current-branch lookup plus any explicitly approved create or checkout behavior. Dependencies: 1. [via: aggregation-2.md#L31-L32 ← research-6.md#L22-L123] [via: aggregation-3.md#L30-L30 ← research-7.md#L20-L31]
3. **Add startup enforcement in core orchestration.** Validate the expected branch before the first task, stop on mismatch, and optionally add the `atomicCommit` backstop afterward. Dependencies: 1-2. [via: aggregation-1.md#L28-L29 ← research-3.md#L156-L176] [via: aggregation-2.md#L33-L33 ← research-5.md#L143-L151]
4. **Make branch state observable.** Thread branch data through events, snapshots, and notifications so UI and extension consumers can trust the same state. Dependencies: 3. [via: aggregation-3.md#L31-L31 ← research-8.md#L157-L196]
5. **Make resume and cleanup branch-aware.** Persist branch identity, validate it on resume, preserve the branch on failure, and add optional stashing for dirty non-graceful exits. Dependencies: 3-4. [via: aggregation-3.md#L32-L33 ← research-9.md#L137-L176]
6. **Add a focused test matrix.** Cover blocked protected branch, allowed feature branch, detached HEAD, dirty worktree, resume mismatch, hook notification behavior, and non-graceful exit cleanup. Dependencies: 2-5. [via: aggregation-1.md#L33-L39 ← research-2.md#L131-L149] [via: aggregation-2.md#L37-L43 ← research-6.md#L240-L250] [via: aggregation-3.md#L36-L43 ← research-9.md#L188-L188]
7. **Run integrity hardening as a follow-up track.** Address `git add -A` contamination and parallel staging races so branch enforcement is paired with commit isolation. Dependencies: 3. [via: aggregation-1.md#L30-L30 ← research-2.md#L42-L49] [via: aggregation-1.md#L30-L30 ← research-2.md#L77-L103]

## Gaps & Further Research

- Finalize the branch schema: prefix, collision handling, maximum length, and whether phase suffixing is optional or mandatory. [via: aggregation-3.md#L36-L43 ← research-7.md#L58-L84]
- Choose mismatch UX and stop behavior: hard block, warning-only, or an explicit opt-in auto-checkout flow. [via: aggregation-2.md#L37-L43 ← research-5.md#L133-L151] [via: aggregation-3.md#L36-L43 ← research-8.md#L159-L196]
- Analyze detached HEAD, pre-existing dirty worktrees, local branch collisions, remote tracking, and non-`main` default branches in depth. [via: aggregation-2.md#L37-L43 ← research-6.md#L233-L236] [via: aggregation-2.md#L37-L43 ← research-5.md#L128-L151]
- Define stash naming, restoration UX, and behavior when the workspace is already dirty before the session starts. [via: aggregation-3.md#L36-L43 ← research-9.md#L141-L153]
- Resolve multi-PRD workspace behavior, since expected branch derivation depends on knowing which PRD is active. [via: aggregation-3.md#L36-L43 ← research-7.md#L111-L114]
- Define resume behavior when the stored branch is missing, diverged, or rebased before the session continues. [via: aggregation-3.md#L36-L43 ← research-9.md#L165-L176]

## Source Chain

- `aggregation-1.md` → `research-1.md`, `research-2.md`, `research-3.md`
- `aggregation-2.md` → `research-4.md`, `research-5.md`, `research-6.md`
- `aggregation-3.md` → `research-7.md`, `research-8.md`, `research-9.md`
- Drill-down path: `FINAL-REPORT.md` → `aggregation-*.md` → `research-*.md`
