## Aggregation Report 3

### Source Reports

- `research-7.md` — PRD identity is currently weak for branch derivation because the effective path defaults to `PRD.md`, the filename is not distinctive, and the parser does not extract the H1 title; the report recommends deriving a stable branch name from a slugified PRD H1, optionally extended with phase context. [source: research-7.md#L10-L16] [source: research-7.md#L20-L31] [source: research-7.md#L56-L65] [source: research-7.md#L107-L114]
- `research-8.md` — Ralph-loop already has a strong event/status/logging pipeline, but none of it is branch-aware today; the report recommends adding explicit branch events, carrying branch state in the status snapshot, and propagating branch info through cross-extension notifications. [source: research-8.md#L11-L16] [source: research-8.md#L73-L82] [source: research-8.md#L110-L122] [source: research-8.md#L157-L196]
- `research-9.md` — The loop already delivers per-task atomic commits and PRD rollback-on-invalid-edit, but non-graceful exits can leave dirty working-tree state; the report recommends preserving the feature branch, never auto-deleting it, and optionally stashing uncommitted work while recording branch identity for session resume. [source: research-9.md#L11-L25] [source: research-9.md#L31-L50] [source: research-9.md#L112-L153] [source: research-9.md#L159-L176]

### Deduplicated Findings

1. Expected branch identity should come from PRD content rather than the PRD filename: the default path `PRD.md` is not unique, the H1 title exists but is not parsed today, and a slugified H1 is the strongest deterministic source, with phase context as an optional suffix if finer granularity is needed. [source: research-7.md#L10-L16] [source: research-7.md#L20-L31] [source: research-7.md#L56-L65] [source: research-7.md#L107-L114]
2. The current implementation is branch-blind across git operations, UI state, and loop lifecycle: `gitOps.ts` handles commits only, `StateSnapshot` has no branch field, the event catalog has no branch events, and cleanup performs no git-specific recovery. Feature-branch enforcement therefore has to be threaded through multiple existing layers, not added in one isolated module. [source: research-7.md#L45-L52] [source: research-8.md#L110-L122] [source: research-8.md#L146-L151] [source: research-9.md#L97-L104] [source: research-9.md#L182-L183]
3. The lowest-friction way to surface branch state is to extend the current event pipeline: add `BranchValidated` / `BranchMismatch` events for active enforcement, add `branch?: string` to `StateSnapshot` for passive visibility, and include branch details in `fireStateChangeNotification()` and `getStateSnapshot()` so UI and external consumers receive the same branch truth. [source: research-8.md#L73-L82] [source: research-8.md#L110-L122] [source: research-8.md#L157-L196]
4. Atomicity should stay per-task rather than per-PRD: each completed task already becomes a discrete commit, PRD edits are transaction-guarded and reverted when invalid, and only the currently failing task can leave dirty working-tree state. That argues for preserving partial progress on the feature branch instead of resetting or deleting it. [source: research-9.md#L11-L25] [source: research-9.md#L31-L50]
5. Failure cleanup should preserve resumability: `YieldRequested` is the only explicitly clean interruption path, while stop/max-iterations/error paths may leave uncommitted edits; the recommended cleanup is optional stashing plus user inspection, not branch deletion. [source: research-8.md#L34-L39] [source: research-8.md#L77-L79] [source: research-9.md#L35-L50] [source: research-9.md#L137-L153]
6. Resume integrity needs durable branch identity beyond the working tree: session persistence should store the branch name, branch-aware mechanisms such as `VerificationCache.getGitBranch()` can validate resumption, and PRD-derived branch naming gives a stable expected value to compare against. [source: research-7.md#L88-L107] [source: research-9.md#L159-L176] [source: research-9.md#L180-L188]
7. No material contradictions appear across the three reports; they converge on one design arc: derive a stable expected branch from PRD metadata, surface validation through existing notification channels, and preserve both committed progress and inspectable failure state. [source: research-7.md#L116-L118] [source: research-8.md#L200-L208] [source: research-9.md#L180-L188]

### Cross-Report Patterns

- **Branch support is absent today across naming, runtime state, and cleanup layers.** All three reports independently describe missing branch identity or enforcement, which makes end-to-end coverage a high-confidence requirement. [source: research-7.md#L45-L52] [source: research-8.md#L146-L151] [source: research-9.md#L182-L183]
- **Existing infrastructure should be extended, not replaced.** The reports point to three reusable seams: PRD parsing for expected-branch derivation, LoopEvent/StateSnapshot/state notifications for surfacing and enforcement, and VerificationCache/session persistence for branch validation during resume. [source: research-7.md#L88-L107] [source: research-8.md#L157-L196] [source: research-9.md#L159-L176]
- **Yield semantics align with branch-preserving recovery.** The event system already treats `YieldRequested` as a first-class state transition, and the rollback/cleanup research identifies yield as the only interruption path that guarantees a clean committed state, making it the natural reference behavior for feature-branch enforcement. [source: research-8.md#L34-L39] [source: research-8.md#L77-L79] [source: research-9.md#L35-L41]
- **Stable branch identity is needed for both naming and resume integrity.** PRD-derived slugs give a deterministic branch target, while session state needs the chosen branch recorded so resume logic can confirm the loop is still operating on the intended branch. [source: research-7.md#L56-L65] [source: research-7.md#L88-L107] [source: research-9.md#L165-L176]

### Priority Matrix

| Pattern | Impact | Effort | Sources |
|---|---|---|---|
| Derive a deterministic expected branch from the PRD H1 slug, with optional phase suffixing only if needed | High | Low | [source: research-7.md#L20-L31] [source: research-7.md#L56-L65] [source: research-7.md#L88-L107] |
| Add branch validation/mismatch events plus `branch?: string` in `StateSnapshot` and state-notification payloads | High | Medium | [source: research-8.md#L157-L196] |
| Preserve feature branches on failure and use optional stashing for dirty work instead of reset/delete cleanup | High | Medium | [source: research-9.md#L35-L50] [source: research-9.md#L137-L153] |
| Persist branch name in session state and validate it on resume/external branch switches | High | Low-Medium | [source: research-9.md#L159-L176] [source: research-7.md#L88-L107] |
| Treat branch enforcement as an end-to-end concern spanning PRD parsing, orchestration, UI, and cleanup | High | Medium | [source: research-7.md#L45-L52] [source: research-8.md#L146-L151] [source: research-9.md#L182-L183] |

### Gaps

- The reports do not finalize the exact branch schema beyond a `ralph/<slug>`-style proposal; collision handling, maximum length policy, and whether a phase suffix is optional or mandatory remain open. [source: research-7.md#L58-L84] [source: research-7.md#L91-L104]
- The enforcement UX is not fully specified: the eventing report shows how to emit mismatch warnings and payloads, but it does not choose whether a mismatch should hard-block loop start, offer auto-checkout, or only warn. [source: research-8.md#L159-L196]
- Cleanup behavior for dirty state is only partially defined: optional stashing is recommended on non-graceful exits, but stash naming, restoration flow, and handling of pre-existing dirty working trees are still unspecified. [source: research-9.md#L97-L104] [source: research-9.md#L141-L153]
- Multi-PRD workspaces remain an unresolved edge case for branch derivation because branch identity depends on knowing which PRD is active. [source: research-7.md#L111-L114]
- Resume validation rules are incomplete: the reports say the branch should be stored in session state, but they do not define the behavior when the recorded branch is missing, diverged, or manually rebased before resume. [source: research-9.md#L165-L176] [source: research-9.md#L188-L188]

### Sources

- `research-7.md` — PRD file identity and branch name derivability
- `research-8.md` — event/notification system for branch operations
- `research-9.md` — atomicity, rollback, and feature branch cleanup requirements
