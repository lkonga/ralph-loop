## Aggregation Report 1

### Source Reports

- `research-1.md`: Confirms that `ralph-loop` currently has a commit-only git workflow: `atomicCommit` stages and commits on the current HEAD, the orchestrator calls it from both sequential and parallel paths, and no branch-management commands or branch config exist today. [source: research-1.md#L9-L18] [source: research-1.md#L49-L57] [source: research-1.md#L58-L82]
- `research-2.md`: Maps `atomicCommit` end to end, showing a branch-agnostic flow built around `git add -A`, commit-message generation, `git commit --no-verify`, and post-commit SHA capture, plus parallel-task and partial-failure risks. [source: research-2.md#L25-L76] [source: research-2.md#L77-L103] [source: research-2.md#L104-L149]
- `research-3.md`: Maps the PRD task lifecycle and identifies the cleanest “before any actual work” insertion point as a one-time gate in `runLoop()` between pre-flight PRD validation and the `while (true)` loop. [source: research-3.md#L9-L77] [source: research-3.md#L95-L176]

### Deduplicated Findings

1. `ralph-loop` is branch-blind today from workflow through commit: it neither creates nor switches branches, and it will commit on whatever HEAD currently points to, including `main` or detached HEAD. [source: research-1.md#L58-L82] [source: research-2.md#L104-L130]
2. The current git path is intentionally narrow and identical across task execution modes: task completion flows into `atomicCommit`, which stages everything with `git add -A`, builds a conventional commit message, commits with `--no-verify`, and records the new HEAD. [source: research-1.md#L9-L18] [source: research-1.md#L49-L57] [source: research-2.md#L25-L103]
3. The best primary enforcement point is a one-time pre-work gate in `runLoop()` after PRD validation and before entering `while (true)`, because branch state is a session-level prerequisite rather than a per-task condition. This resolves the report-2 choice of “top of `atomicCommit` or orchestrator callsites” by making the orchestrator pre-loop check the primary control and treating an `atomicCommit` check as optional defense in depth. [source: research-2.md#L137-L149] [source: research-3.md#L97-L176]
4. Branch enforcement does not solve commit contamination. `git add -A` vacuums all unstaged changes, parallel completions can race into each other’s staging area, and a failed commit can leave the index dirty; those risks remain even if a feature-branch rule is added. [source: research-2.md#L42-L49] [source: research-2.md#L77-L103] [source: research-2.md#L131-L149]
5. There is no existing configuration surface for branch policy. `RalphConfig` has no branch-related settings, and the only branch-aware code identified in the reports is cache invalidation logic, not enforcement logic. [source: research-1.md#L79-L82] [source: research-2.md#L104-L130]
6. The orchestrator already has a fail-fast pre-work validation pattern (`PrdValidationFailed` and return), so feature-branch enforcement can follow an existing control-flow style and stop the session before task picking or execution begins. [source: research-3.md#L15-L20] [source: research-3.md#L156-L176]

### Cross-Report Patterns

- **The policy gap is systemic, not localized.** Report 1 shows no branch management in the current workflow, report 2 shows `atomicCommit` is branch-agnostic, and report 3 identifies exactly where a session-level gate can close that gap before work starts. [source: research-1.md#L58-L82] [source: research-2.md#L104-L149] [source: research-3.md#L95-L176]
- **One-time pre-loop enforcement is the highest-confidence control point.** Report 2 says enforcement belongs either at `atomicCommit` or the orchestrator, while report 3 narrows the best orchestrator location to the pre-loop slot after PRD validation; together they support “pre-loop first, commit-level check optional.” [source: research-2.md#L137-L149] [source: research-3.md#L97-L176]
- **Branch safety and commit isolation are separate concerns.** The branch-policy gap can be closed with a pre-work gate, but the `git add -A` vacuum, parallel commit race, and lack of rollback remain independent integrity issues. [source: research-1.md#L90-L92] [source: research-2.md#L42-L49] [source: research-2.md#L77-L103] [source: research-2.md#L131-L149]

### Priority Matrix

| Pattern | Impact | Effort | Sources (with line refs) |
|---|---|---|---|
| Add a one-time feature-branch gate before `while (true)` in `runLoop()` | High | Low | [source: research-3.md#L156-L176] [source: research-1.md#L90-L92] |
| Add a defensive branch re-check at the top of `atomicCommit` | Medium | Low | [source: research-2.md#L137-L149] |
| Scope staging or serialize commits to remove the `git add -A` race/bleed-through risk | High | Medium | [source: research-2.md#L42-L49] [source: research-2.md#L77-L103] [source: research-2.md#L131-L149] |
| Introduce config for protected branches or allowed branch patterns | Medium | Medium | [source: research-1.md#L79-L82] [source: research-2.md#L104-L130] |

### Gaps

- The reports do not define the exact event/API surface for a branch-policy failure path, only that the orchestrator should follow an existing yield-and-return preflight pattern. [source: research-3.md#L156-L176]
- The reports do not specify a concrete policy schema for protected branch names, allowed prefixes, detached-HEAD behavior, or override semantics; they only establish that no such config exists today and that commits are currently branch-agnostic. [source: research-1.md#L79-L82] [source: research-2.md#L104-L130]
- The reports do not include a verification matrix for blocked-on-main, allowed feature branch, detached HEAD, parallel completion, or failed-commit cleanup; they focus on current behavior and insertion points instead. [source: research-2.md#L131-L149] [source: research-3.md#L156-L200]
- No source recommends auto-creating or auto-switching branches as part of enforcement. The synthesized direction from the evidence is fail-fast validation, not branch orchestration. [source: research-1.md#L58-L77] [source: research-3.md#L156-L176]

### Sources

- `research-1.md` — Existing git workflow in `ralph-loop`
- `research-2.md` — `atomicCommit` end-to-end analysis
- `research-3.md` — PRD task lifecycle and insertion points
