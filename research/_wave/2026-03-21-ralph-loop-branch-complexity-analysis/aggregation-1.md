## Aggregation Report 1

### Source Reports
- `research-1.md` — `runLoop()` has a three-way startup gate, and the non-protected/non-expected case silently adopts the current branch, persists that actual branch to session state, and leaves the path untested. [source: research-1.md#L9-L45; research-1.md#L47-L64; research-1.md#L112-L121]
- `research-2.md` — `deriveBranchName()` is deterministic but lossy, with ASCII-only normalization, a shared `ralph/prd` fallback bucket, positional truncation, and an `undefined` crash path when callers non-null assert `parsePrdTitle()`. [source: research-2.md#L8-L31; research-2.md#L45-L77; research-2.md#L79-L123]
- `research-3.md` — `atomicCommit` has a protected-branch guard in theory, but the orchestrator never passes `protectedBranches`, so the guard is dead in real execution and its tests mostly validate disconnected behavior. [source: research-3.md#L16-L39; research-3.md#L40-L66]

### Deduplicated Findings
1. Branch enforcement is fail-open in the main risk path: if startup occurs on a non-protected branch that does not match the PRD-derived branch, the orchestrator adopts the current branch, and the per-commit guard does not provide a backstop because it is not wired in. [source: research-1.md#L35-L45; research-3.md#L31-L39]
2. Wrong-branch execution becomes sticky once adopted: session persistence records only the actual git branch, `branchMismatch` is set but never consumed, state snapshots expose the adopted branch, and commits continue landing there. [source: research-1.md#L47-L110]
3. The PRD-to-branch-name step is itself fragile: slug generation strips non-ASCII content, collapses many invalid inputs into the same `ralph/prd` branch, truncates long names by raw position, and can crash on missing H1 titles before fallback logic runs. [source: research-2.md#L45-L77; research-2.md#L79-L123; research-2.md#L146-L154]
4. The end-to-end branch-intent pipeline is therefore weak at both ends: branch intent can be malformed or ambiguous when derived from PRD text, and even a valid expected branch can be ignored if the current branch is already non-protected. [source: research-2.md#L45-L77; research-2.md#L79-L123; research-1.md#L35-L45]
5. Test coverage creates false reassurance: there is no direct test for silent adoption on arbitrary branches, no dedicated coverage of slug edge cases, and the atomic commit guard is mostly tested through direct calls that production never makes. [source: research-1.md#L112-L121; research-2.md#L124-L154; research-3.md#L40-L66; research-3.md#L70-L72]
6. Mid-loop branch drift remains unprotected: startup validation happens once, the passive session mismatch flag is not enforced, and the only commit-time safeguard is currently dead code from the orchestrator’s perspective. [source: research-3.md#L48-L55; research-3.md#L84-L90; research-1.md#L66-L78]
7. No material contradictions were found across the reports; they converge on the same diagnosis: the branch-safety design contains real mechanisms, but the production path is permissive, incomplete, or disconnected. [source: research-1.md#L123-L131; research-3.md#L68-L76]

### Cross-Report Patterns
- **Fail-open safety controls** — The system prefers proceeding over enforcing branch intent: startup silently adopts arbitrary non-protected branches, session mismatch detection is passive, and commit-time protection is unwired. [source: research-1.md#L35-L45; research-1.md#L66-L78; research-3.md#L31-L39; research-3.md#L68-L76]
- **Intent vs. actuality split** — Expected branch intent is derived from PRD text, but runtime/session state tracks the actual current branch; when these diverge, the system preserves the divergence rather than resolving it. [source: research-2.md#L79-L123; research-1.md#L47-L64]
- **Coverage illusion** — The strongest test attention is on happy paths or isolated helpers, while the risky production paths remain under-tested or completely untested. [source: research-1.md#L112-L121; research-2.md#L124-L154; research-3.md#L56-L66; research-3.md#L70-L72]
- **Edge cases cluster outside guardrails** — Unicode-only or malformed PRD titles, detached HEAD, arbitrary non-protected branches, and manual mid-loop branch changes all sit outside strong enforcement. [source: research-2.md#L53-L67; research-2.md#L81-L100; research-1.md#L149-L154; research-1.md#L160-L169; research-3.md#L48-L55]

### Priority Matrix
| Pattern | Impact | Effort | Sources |
|---|---|---|---|
| Replace silent non-protected-branch adoption with an explicit policy (block, warn, or user-confirmed adopt) | High | Medium | [source: research-1.md#L35-L45; research-1.md#L160-L169] |
| Wire `protectedBranches` into `atomicCommit` at both orchestrator call sites, or delete the dead guard and its tests | High | Low | [source: research-3.md#L31-L39; research-3.md#L84-L90] |
| Persist both expected and actual branch names, then enforce `branchMismatch` on resume instead of treating it as dead metadata | High | Medium | [source: research-1.md#L61-L78; research-1.md#L165-L167] |
| Harden `deriveBranchName()` / `parsePrdTitle()` for unicode, collision, truncation, and `undefined` inputs, then add dedicated tests | Medium | Medium | [source: research-2.md#L45-L77; research-2.md#L79-L123; research-2.md#L133-L154] |
| Measure branch-check overhead before or alongside commit-time revalidation so defense-in-depth does not become speculative | Medium | Low | [source: research-3.md#L94-L99] |

### Gaps
- No report measured actual PRD-title collision frequency across repository history or user workflows; slug collision risk is argued from examples rather than observed corpus data. [source: research-2.md#L69-L77; research-2.md#L158-L161]
- No report executed detached HEAD behavior end to end; it is flagged as a risk but not traced through session save/resume and commit paths. [source: research-1.md#L169-L169]
- No report defined how existing `.ralph/session.json` data should be migrated if `expectedBranch` becomes persisted state or resume starts enforcing mismatches. [source: research-1.md#L61-L64; research-1.md#L165-L167]
- No report quantified the practical frequency of mid-loop manual branch changes, only the theoretical exposure and possible mitigation. [source: research-3.md#L48-L55; research-3.md#L94-L99]

### Sources
- `research-1.md` (Non-Protected Branch Adoption Behavior in `runLoop()`)
- `research-2.md` (`deriveBranchName()` Slug Robustness Analysis)
- `research-3.md` (`atomicCommit` Branch Guard — Defense-in-Depth or Redundant Complexity?)
