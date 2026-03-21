## Aggregation Report 2

### Source Reports

- `research-4.md`: `branchMismatch` detection is mechanically correct and legacy-safe, but it is runtime-only, UI-only, and can conflict with the orchestrator's separate PRD-derived branch gate; Resume also ignores checkout failure. [source: research-4.md#L7-L17] [source: research-4.md#L21-L34] [source: research-4.md#L45-L53]
- `research-5.md`: The feature is relatively small (~109 source lines) and heavily tested, with 13 failure modes catalogued; most edge cases degrade safely, but the real safety gap is that the orchestrator never passes `protectedBranches` into `atomicCommit`. [source: research-5.md#L7-L24] [source: research-5.md#L28-L42] [source: research-5.md#L61-L76]
- `research-6.md`: Five happy paths are working, but adversarial scenarios reveal three meaningful gaps: mid-loop branch drift, title-derived orphan or collision branches, and silent bypass on non-standard default branches. [source: research-6.md#L7-L32] [source: research-6.md#L36-L50] [source: research-6.md#L80-L111]

### Deduplicated Findings

- The branch enforcement feature is solid for the intended startup-time workflow: it creates or validates feature branches on protected-branch starts, resumes correctly when already on the expected branch, and cleanly no-ops when disabled. [source: research-6.md#L7-L32] [source: research-5.md#L44-L57]
- `branchMismatch` is reliable as detection but only partially useful as enforcement: it is set only when both current and stored branch names exist, stored as a runtime annotation rather than durable state, and consumed only by `extension.ts`, while the orchestrator independently derives the expected branch from PRD title. This resolves the apparent "handled vs broken" tension: detection works, end-to-end branch authority does not. [source: research-4.md#L7-L17] [source: research-4.md#L21-L45] [source: research-5.md#L38-L39] [source: research-6.md#L125-L129]
- The highest-risk gap is runtime branch drift after startup. The gate runs once, but the orchestrator does not pass `protectedBranches` into `atomicCommit`, leaving the per-commit guard effectively dead in real orchestrator runs. A manual or external `git checkout main` can therefore redirect later commits onto protected branches. [source: research-5.md#L37-L38] [source: research-5.md#L61-L76] [source: research-6.md#L36-L41] [source: research-6.md#L122-L129]
- Error handling is generally proportionate: checkout and create failures plus dirty-tree conflicts fail safely with terminal branch-enforcement events, while ambiguous contexts such as detached HEAD, missing git, or missing PRD H1 fall back to degraded behavior instead of hard failing. [source: research-5.md#L30-L36] [source: research-5.md#L40-L42] [source: research-5.md#L80-L88] [source: research-6.md#L113-L118]
- Branch naming is deterministic but collision-prone. Because branch names are pure PRD-title slugs with a `ralph/prd` fallback, title edits, duplicate titles, pre-existing `ralph/...` branches, or untitled PRDs can silently split work across orphan branches or merge unrelated work onto one branch. [source: research-5.md#L32-L32] [source: research-5.md#L40-L42] [source: research-6.md#L43-L50] [source: research-6.md#L98-L111] [source: research-6.md#L131-L132]
- Test coverage is strong for startup logic and happy paths, but weak where user behavior or repo topology becomes adversarial: Resume UI error handling, mid-loop drift, title mutation, worktrees, dirty trees, non-standard default branches, and concurrent fresh starts are either untested or only reasoned about. [source: research-4.md#L57-L72] [source: research-5.md#L18-L24] [source: research-6.md#L59-L60] [source: research-6.md#L85-L96] [source: research-6.md#L113-L118]

### Cross-Report Patterns

- **High confidence — startup-only enforcement, not continuous enforcement.** The design invests in a clean startup decision tree and terminal failure exits, but runtime safety depends on the branch never changing later. [source: research-5.md#L44-L57] [source: research-5.md#L61-L76] [source: research-6.md#L122-L129]
- **High confidence — dual branch authorities create semantic drift.** Session resume logic treats stored `branchName` as truth, while orchestrator startup treats PRD-derived branch as truth. The system detects mismatches but cannot reconcile them coherently. [source: research-4.md#L38-L45] [source: research-4.md#L88-L94] [source: research-6.md#L125-L129] [source: research-6.md#L143-L148]
- **High confidence — the feature is proportionate for the happy path.** The code footprint is modest, the decision tree is shallow, and the main intended workflows are validated by substantial tests and clear event signaling. [source: research-5.md#L7-L24] [source: research-5.md#L44-L57] [source: research-5.md#L94-L107] [source: research-6.md#L7-L32] [source: research-6.md#L136-L141]
- **High confidence — edge cases favor degraded continuity over strict correctness.** Detached HEAD, untitled PRDs, missing git, and non-standard default branches tend to proceed or silently bypass protection rather than halt early. [source: research-4.md#L78-L84] [source: research-5.md#L32-L36] [source: research-5.md#L88-L88] [source: research-6.md#L80-L86]

### Priority Matrix

| Pattern | Impact | Effort | Sources (with line refs) |
| --- | --- | --- | --- |
| Wire `protectedBranches` into both orchestrator `atomicCommit` call sites so the existing per-commit guard becomes active | High | Low | [source: research-5.md#L61-L76]; [source: research-6.md#L36-L41]; [source: research-6.md#L152-L160] |
| Collapse dual branch authority into one source of truth for resume and startup, and treat failed Resume checkout as blocking instead of best-effort | High | Medium | [source: research-4.md#L38-L53]; [source: research-4.md#L108-L110]; [source: research-6.md#L154-L160] |
| Explicitly handle detached HEAD and non-standard default branches instead of silently passing through | Medium | Medium | [source: research-4.md#L80-L84]; [source: research-5.md#L113-L115]; [source: research-6.md#L80-L86]; [source: research-6.md#L158-L160] |
| Add branch-name disambiguation or warning for title mutation, duplicate titles, and untitled PRDs | Medium | Medium | [source: research-5.md#L32-L32]; [source: research-5.md#L40-L42]; [source: research-6.md#L43-L50]; [source: research-6.md#L98-L111]; [source: research-6.md#L156-L156] |
| Add adversarial coverage for Resume checkout failure, mid-loop drift, worktrees, dirty trees, and concurrent fresh starts | Medium | Medium | [source: research-4.md#L68-L72]; [source: research-6.md#L59-L60]; [source: research-6.md#L95-L96]; [source: research-6.md#L113-L118] |

### Gaps

- None of the reports quantify how often the risky scenarios happen in real usage; they infer impact from code paths and tests rather than telemetry or user history. [source: research-5.md#L109-L121] [source: research-6.md#L150-L162]
- Resume UX is analyzed structurally but not empirically: the dialog path is described, yet its user-facing copy, branching behavior under failure, and end-to-end automation coverage remain unverified. [source: research-4.md#L23-L29] [source: research-4.md#L68-L70]
- Worktrees, shallow clones, submodules, dirty startup states, and concurrent fresh starts are largely reasoned extrapolations, not validated experiments. [source: research-6.md#L52-L78] [source: research-6.md#L88-L96] [source: research-6.md#L113-L118]
- The reports stop short of recommending a concrete sequencing strategy between the quick safety fix (`atomicCommit` guard wiring) and the structural fixes (branch-authority unification and branch-name disambiguation). [source: research-5.md#L111-L121] [source: research-6.md#L152-L160]

### Sources

- `research-4.md` — Session Persistence Branch Mismatch Detection — Reliability Analysis
- `research-5.md` — Edge Case / Failure Mode Catalog — Branch Enforcement Feature
- `research-6.md` — Happy Paths vs Adversarial Scenarios — Branch Enforcement Use Case Map
