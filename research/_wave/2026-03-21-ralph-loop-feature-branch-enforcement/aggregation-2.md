## Aggregation Report 2

### Source Reports

- `research-4.md` maps the orchestrator startup path from `start()` into `runLoop()`, shows that PRD validation and task selection happen before bearings, and identifies the seam immediately after bearings and before `TaskStarted` as the last startup checkpoint before task work begins. [source: research-4.md#L27-L38] [source: research-4.md#L47-L77] [source: research-4.md#L151-L167]
- `research-4.md` also confirms that current baseline verification checks only `tsc` and optionally `vitest`, not git branch state, and suggests a startup-only branch guard as a natural extension. [source: research-4.md#L82-L148] [source: research-4.md#L208-L227]
- `research-5.md` documents the dual hook system (`IRalphHookService` plus `hookBridge.ts`), the `SessionStart` lifecycle point, and existing git helpers, then argues that hooks can technically create branches but are a poor primary enforcement mechanism for a mandatory precondition. [source: research-5.md#L8-L24] [source: research-5.md#L47-L68] [source: research-5.md#L83-L104] [source: research-5.md#L110-L151]
- `research-6.md` describes the three-layer configuration model, notes that config is loaded once at loop start, and proposes integrating branch enforcement as an optional top-level `featureBranch` setting wired through `RalphConfig`, `DEFAULT_CONFIG`, `loadConfig()`, and optionally `package.json`. [source: research-6.md#L10-L20] [source: research-6.md#L22-L123] [source: research-6.md#L124-L139] [source: research-6.md#L165-L236]

### Deduplicated Findings

- Ralph-loop already has a clear startup sequence: `start()` transitions the orchestrator to running, `runLoop()` performs pre-loop setup, fires `SessionStart`, validates the PRD, then enters task selection and gating before any `TaskStarted` event is emitted. This gives branch enforcement a single startup path instead of requiring checks throughout task execution. [source: research-4.md#L27-L38] [source: research-4.md#L47-L77] [source: research-5.md#L83-L91]
- The existing baseline gate is the bearings system, which runs `tsc` at startup by default and can run `vitest` for `full` checkpoints, but it never validates git branch state. The exact seam after bearings and before `iteration++` / `TaskStarted` is the last verified point before work starts. [source: research-4.md#L82-L167] [source: research-4.md#L208-L227]
- Git plumbing already exists for enforcement work: `runGit(...)` and `atomicCommit(...)` cover command execution and commit flow, but there is no helper today for current-branch validation or branch creation. That missing helper is the main infrastructure gap, not a missing git subsystem. [source: research-5.md#L95-L104] [source: research-6.md#L210-L228]
- The hook system is capable of running git commands, especially via `SessionStart`, shell hooks, or hook-bridge scripts, but its semantics are fault-tolerant and optional. Because hook failures normally degrade to `continue`, hook-only branch enforcement would be too weak for a hard startup precondition. [source: research-5.md#L47-L68] [source: research-5.md#L112-L151]
- Configuration integration is straightforward and backward-compatible if the setting is optional. The strongest configuration fit is a top-level `featureBranch?: string` with `undefined` or empty meaning no enforcement, loaded once through the existing `ralph-loop` settings path. [source: research-6.md#L10-L20] [source: research-6.md#L22-L123] [source: research-6.md#L169-L236]
- The reports disagree slightly on *where* to place the enforcement logic, but they converge on *when*: it must run once during startup before the first task executes. `research-4.md` favors the post-bearings seam, `research-5.md` favors even earlier execution before `SessionStart` for branch creation, and `research-6.md` allows either `runLoop()` or `extension.ts`. The consolidated resolution is: enforce once at startup in core logic, and choose the exact seam based on behavior—validate-only can live after bearings, while create-or-switch behavior should happen before hooks so downstream startup state sees the right branch. [source: research-4.md#L151-L167] [source: research-4.md#L223-L227] [source: research-5.md#L143-L151] [source: research-6.md#L219-L236]
- The most consistent architecture from all three reports is a hybrid: core startup enforcement backed by new git helpers and config, with hooks treated as notification or extension points rather than the authoritative enforcement layer. [source: research-5.md#L143-L151] [source: research-6.md#L188-L228] [source: research-4.md#L223-L227]

### Cross-Report Patterns

- **Startup-only enforcement is the shared control point.** All three reports place branch policy before the first unit of task work, even though they suggest slightly different seams inside startup. That makes startup enforcement the highest-confidence pattern. [source: research-4.md#L151-L167] [source: research-4.md#L223-L227] [source: research-5.md#L112-L117] [source: research-5.md#L143-L151] [source: research-6.md#L20-L20] [source: research-6.md#L219-L236]
- **Core logic should own the mandatory rule; hooks should stay auxiliary.** `research-5.md` states this directly, and `research-4.md` plus `research-6.md` both point toward orchestrator/config integration instead of hook-centric enforcement. [source: research-5.md#L128-L151] [source: research-4.md#L223-L227] [source: research-6.md#L188-L228]
- **Implementation can extend existing infrastructure rather than inventing a new subsystem.** The reports collectively show reusable pieces already in place: orchestrator startup phases, git command helpers, and a config-loading pipeline. [source: research-4.md#L47-L77] [source: research-5.md#L95-L104] [source: research-6.md#L10-L20] [source: research-6.md#L93-L123]
- **Backward compatibility should come from opt-in configuration.** The configuration report proposes `undefined` / empty as no-op, and the hook analysis reinforces that different repos may want different branch policies. Together, that supports an optional setting rather than a universal hard-coded branch rule. [source: research-6.md#L181-L236] [source: research-5.md#L149-L151]

### Priority Matrix

| Pattern | Impact | Effort | Sources (with line refs) |
|---|---|---|---|
| Add optional top-level branch config (`featureBranch` or equivalent) to `RalphConfig`, defaults, loader, and UI-exposed settings | High | Low | [source: research-6.md#L22-L123] [source: research-6.md#L169-L208] |
| Add git helper(s) for current-branch lookup and optional create/switch behavior | High | Low-Medium | [source: research-5.md#L95-L104] [source: research-6.md#L210-L228] |
| Enforce branch policy once during startup before first task work, with explicit stop/error behavior | High | Medium | [source: research-4.md#L151-L167] [source: research-4.md#L223-L227] [source: research-5.md#L143-L151] |
| Use hooks only for post-enforcement notification, context injection, or customization | Medium | Medium | [source: research-5.md#L112-L151] [source: research-5.md#L157-L163] |
| Keep enforcement independent from per-task bearings repetition while still respecting startup verification flow | Medium | Medium | [source: research-4.md#L84-L148] [source: research-4.md#L223-L227] [source: research-6.md#L233-L236] |

### Gaps

- Branch naming policy is still underspecified. The reports mention smart naming and config-driven expected branch values, but do not settle how names should be derived from PRD title, task metadata, or user input. [source: research-5.md#L134-L147] [source: research-6.md#L169-L236]
- Failure-mode details are still open. The reports imply stop/pause/error-event behavior, but do not finalize which loop event, user message, or recovery UX should be used when enforcement fails. [source: research-4.md#L223-L227] [source: research-5.md#L133-L151] [source: research-6.md#L219-L236]
- Edge cases around detached HEAD, dirty worktrees, existing local branch collisions, remote tracking, and non-`main` default branches were not analyzed in depth. The current recommendations stay at the startup-placement and config-schema level. [source: research-5.md#L128-L151] [source: research-6.md#L233-L236]
- Test coverage strategy is not yet consolidated. The hook report references existing hook tests, but none of the reports define the new unit or integration matrix for branch validation/creation behavior. [source: research-5.md#L167-L177] [source: research-6.md#L240-L250]

### Sources

- `research-4.md` — orchestrator startup path, bearings verification seam, and candidate insertion point for branch checks.
- `research-5.md` — hook-system architecture, git helper inventory, and hook-vs-core recommendation.
- `research-6.md` — configuration architecture and proposed integration path for a new branch-enforcement setting.
