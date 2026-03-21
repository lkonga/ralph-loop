## Aggregation Report 2

### Source Reports
- `research-4.md` — Establishes Copilot’s split model: cloud delegation packages dirty state onto a temporary `copilot/vscode-*` branch and switches back; local background sessions isolate work in a worktree and migrate/apply changes later. [source: research-4.md#L14-L78; research-4.md#L122-L151]
- `research-5.md` — Details the end-to-end PR workflow: state-driven confirmation UI, optional commit/push before delegation, remote PR creation for cloud sessions, and local-only apply/merge flows for background sessions. [source: research-5.md#L31-L100; research-5.md#L101-L172]
- `research-6.md` — Compares Ralph’s current branch gate against Copilot’s patterns and proposes a safer refactor: linear branch flow, original-branch tracking, dirty-state handling, and hash-suffixed naming. [source: research-6.md#L5-L77; research-6.md#L114-L196]

### Deduplicated Findings
1. Copilot does not use one universal branch strategy: cloud work delegates via a temporary pushed branch, while local/background work isolates changes in a separate worktree. [source: research-4.md#L14-L78; research-5.md#L11-L172]
2. The cloud path follows a linear “snapshot and delegate” flow: capture the current branch, create a randomized `copilot/vscode-*` branch, commit/push dirty state, pass it as `head_ref`, then switch back before the remote agent creates the PR. [source: research-4.md#L18-L46; research-4.md#L79-L107; research-5.md#L15-L90; research-6.md#L80-L89]
3. Cloud branch names are intentionally opaque and collision-resistant, whereas Ralph’s current `ralph/<slug>` naming is readable but collision-prone; the proposed `ralph/<slug>-<short-hash>` hybrid preserves human meaning without sacrificing uniqueness. [source: research-4.md#L18-L24; research-5.md#L15-L29; research-6.md#L5-L20; research-6.md#L114-L126]
4. Dirty state is a first-class concern in Copilot but a current gap in Ralph: Copilot either auto-commits/pushes or prompts to copy/move/skip changes, while Ralph can branch with uncommitted changes unchecked. [source: research-4.md#L25-L46; research-4.md#L55-L62; research-5.md#L45-L58; research-5.md#L154-L172; research-6.md#L48-L57]
5. Copilot explicitly tracks and returns to the originating branch (or isolates work away from it), giving it rollback semantics that Ralph currently lacks because it persists only the active branch name. [source: research-4.md#L29-L35; research-5.md#L147-L153; research-6.md#L58-L77]
6. PR creation belongs to the cloud path only: the VS Code client submits `base_ref`/`head_ref` context and GitHub’s remote agent creates the PR branch and PR, while the local/background path stops at apply/merge operations in the user’s repo. [source: research-4.md#L79-L107; research-5.md#L59-L100; research-5.md#L137-L146]
7. Ralph’s current 3-way gate creates ambiguity because it can silently adopt an unrelated non-protected branch; the refactor proposal resolves that by replacing the gate with a linear always-create flow from current HEAD. [source: research-6.md#L21-L47; research-6.md#L114-L180]
8. The reports converge on a staged recommendation for Ralph: first add dirty-state checks, original-branch persistence, and no-silent-adoption behavior; then decide whether to stop there or graduate to stronger isolation such as worktrees. [source: research-6.md#L186-L196; research-4.md#L134-L151; research-5.md#L183-L192]

### Cross-Report Patterns
- **High confidence:** Copilot treats branching as disposable isolation, not as a semantic artifact; meaning is carried by the prompt/PR/session, while branch names optimize for safety and uniqueness. [source: research-4.md#L122-L133; research-5.md#L173-L182; research-6.md#L5-L20]
- **High confidence:** Preflight state drives the flow — dirty changes, branch remote presence, and auth/worktree readiness are checked before irreversible actions occur. [source: research-4.md#L25-L46; research-5.md#L31-L58; research-5.md#L85-L91; research-6.md#L48-L57]
- **High confidence:** “Remember origin, isolate changes, merge/apply later” is the shared safety pattern across Copilot’s cloud and local modes and the main inspiration for Ralph’s refactor. [source: research-4.md#L29-L35; research-4.md#L55-L70; research-5.md#L137-L153; research-6.md#L80-L89; research-6.md#L114-L174]
- **High confidence:** Worktrees are the cleaner local-isolation model because they avoid branch switching in the main workspace and make discard/apply decisions explicit. [source: research-4.md#L47-L78; research-4.md#L134-L151; research-5.md#L101-L146; research-5.md#L183-L192]
- **High confidence:** Cloud delegation is a PR-producing workflow; local background execution is an integration workflow whose outputs are applied or merged by the user. [source: research-4.md#L79-L107; research-5.md#L59-L100; research-5.md#L137-L146]

### Priority Matrix
| Pattern | Impact | Effort | Sources (with line refs) |
|---|---|---|---|
| Add dirty-state preflight before any branch operation | High | Low | research-6.md#L48-L57; research-6.md#L186-L196; research-4.md#L25-L46 |
| Persist `originalBranch` alongside active branch/session state | High | Low | research-6.md#L58-L69; research-6.md#L114-L174; research-5.md#L147-L153 |
| Replace Ralph’s 3-way gate with a linear always-create flow | High | Medium | research-6.md#L21-L47; research-6.md#L114-L180; research-6.md#L186-L196 |
| Switch to hash-suffixed human-readable branch names | Medium | Low | research-6.md#L5-L20; research-6.md#L114-L126; research-4.md#L18-L24 |
| Evaluate optional worktree isolation for local Ralph iterations | High | Medium-High | research-4.md#L47-L78; research-4.md#L134-L151; research-5.md#L101-L146 |

### Gaps
- The reports do not show what cleans up temporary `copilot/vscode-*` branches after the remote agent creates or merges a PR, so branch lifecycle/cleanup remains unverified. [source: research-4.md#L152-L162; research-5.md#L193-L199]
- Worktree cleanup policy is also still unclear; the reports describe creation and apply/merge behavior but not stale-worktree pruning or deletion. [source: research-4.md#L152-L162; research-5.md#L193-L199]
- The cloud-side PR branch naming remains opaque because VS Code only provides `base_ref` and optional `head_ref`; the actual working PR branch is created server-side. [source: research-4.md#L79-L97; research-4.md#L152-L156; research-5.md#L59-L84; research-5.md#L193-L195]
- Ralph’s refactor direction is strong, but three policy choices remain unsettled: stash vs auto-commit for dirty state, whether resume should reuse an existing branch, and whether completion should switch back to `originalBranch` or leave the user on the feature branch. [source: research-6.md#L197-L207]

### Sources
- `research-4.md` — Copilot cloud/background branch creation, naming, dirty-state handling
- `research-5.md` — Copilot cloud PR workflow vs local/worktree integration workflow
- `research-6.md` — Ralph refactor proposal informed by Copilot branch patterns
