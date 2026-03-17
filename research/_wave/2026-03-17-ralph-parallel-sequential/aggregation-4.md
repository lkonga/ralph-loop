# Aggregation Report 4

## Source Reports

### research-10.md — Atomic Git Commits in Parallel
Key findings: `atomicCommit()` has **no serialization** (no mutex, lock, or queue). Parallel tasks in `Promise.all` each call `atomicCommit()` independently. `git add -A` stages the entire working tree, creating a **semantic race condition** where one task's commit can capture another task's files. Git's internal `.git/index.lock` prevents literal concurrent git operations but failures are **not retried**. [source: research-10.md#L1-L5]

### research-11.md — Fix Sequential dependsOn
Key findings: `pickNextTask()` is a naive `.find(status === Pending)` that **ignores `dependsOn` entirely**. `pickReadyTasks(snapshot, 1)[0]` is a safe drop-in replacement — identical behavior when no deps exist, strict improvement when deps exist. Fix is **1 line of production code** (redefine `pickNextTask` body). All 3 existing tests continue to pass. [source: research-11.md#L1-L10]

### research-12.md — Comparison with Research Patterns
Key findings: Ralph implements **DAG-aware batch parallelism** (frontier selection → `Promise.all` → repeat), the same pattern used by Make, Bazel, GitHub Actions, and Airflow. Ralph is the **only VS Code AI coding agent** with DAG-aware parallel execution. Main gaps: dependencies ignored in sequential mode, no cycle detection, `Promise.all` blocks on slowest task, no post-parallel consistency checks. [source: research-12.md#L1-L12]

---

## Deduplicated Findings

### F1: Sequential Mode Ignores Dependencies — Trivial Fix Available
`pickNextTask()` returns the first pending task by document order, completely bypassing `dependsOn`. This is confirmed independently by research-11 (code analysis) and research-12 (gap analysis vs competitors). The fix is a 1-line change to `src/prd.ts` L103: redefine `pickNextTask` to delegate to `pickReadyTasks(snapshot, 1)[0]`. All 3 call sites in `orchestrator.ts` (L494, L524, L596) are automatically fixed. No existing test breaks. [source: research-11.md#L7-L50] [source: research-12.md#L142-L144]

### F2: Parallel Git Commits Have Race Conditions
`atomicCommit()` lacks serialization. Two problems:
1. **Git lock contention**: Concurrent `git add`/`git commit` operations fail on `.git/index.lock` — not retried. [source: research-10.md#L32-L40]
2. **Semantic mis-staging**: `git add -A` stages the entire working tree, so a fast-completing task can scoop up a slow task's files. Results in misattributed commits and "nothing to commit" failures. [source: research-10.md#L42-L52]

Fix: A `p-limit(1)` or async mutex around `atomicCommit()` calls would serialize commits without blocking parallel task execution. [source: research-10.md#L74-L76]

### F3: Ralph's Parallel Model Is Standard But Unique Among VS Code Extensions
The DAG frontier → `Promise.all` → wait → repeat pattern is well-established in build systems and workflow engines. Among the 7 compared AI coding tools (Aider, Continue, Cursor, Cline, AutoGen, CrewAI, LangGraph), only LangGraph and CrewAI offer comparable parallel capabilities — and those are general-purpose frameworks, not VS Code extensions. [source: research-12.md#L107-L125]

### F4: `Promise.all` Batch Semantics Waste Time
All tasks in a parallel batch must complete before the next batch starts. If one task takes 5 minutes and another takes 30 seconds, 4.5 minutes are wasted. `Promise.allSettled` with individual completion tracking (or a reactive model) would improve throughput. This matches how Airflow and modern CI systems work. [source: research-12.md#L131-L132] [source: research-12.md#L172-L173]

### F5: No Cycle Detection in Dependency Graph
Circular dependencies in `dependsOn` create silent deadlocks — `pickReadyTasks` will never return those tasks, and the orchestrator terminates with `AllDone` while tasks remain pending. Every production DAG scheduler (Airflow, Bazel) detects and reports cycles. [source: research-12.md#L145-L147] [source: research-11.md#L62-L63]

### F6: No Post-Parallel Consistency Check
Each parallel task passes its own verification, but combined state may be inconsistent. No integration-level check runs after a parallel batch merges changes. CI systems typically run integration tests after parallel jobs converge. [source: research-12.md#L134-L135] [source: research-10.md#L58-L60]

### F7: Shared PRD File State Creates Race Conditions
Multiple parallel tasks call `markTaskComplete()` on the same PRD file. Without file-level locking or atomic state updates, concurrent writes could corrupt the file. [source: research-12.md#L137-L138]

---

## Cross-Report Patterns

### CP1: Serialization Gap Is Pervasive (3/3 reports)
All three reports independently identify the lack of serialization as a core issue — in git commits (research-10), in task selection (research-11), and compared to industry practice (research-12). The system has a well-designed DAG scheduler (`pickReadyTasks`) that is only half-wired: parallel mode uses it, sequential mode bypasses it, and git operations have no coordination at all. **Highest confidence finding.** [source: research-10.md#L56-L62] [source: research-11.md#L7-L14] [source: research-12.md#L128-L138]

### CP2: Small Fix, Large Impact (2/3 reports)
Both research-11 and research-12 converge on the sequential `dependsOn` fix being trivially implementable (1 line) with outsized correctness impact. Research-10's git serialization fix (`p-limit(1)`) is similarly minimal. The pattern: ralph's parallel infrastructure is fundamentally sound, but its integration points have gaps that require only small, targeted fixes. [source: research-11.md#L75-L81] [source: research-10.md#L74-L76]

### CP3: Parallel Is Off by Default (2/3 reports)
Research-12 notes `maxParallelTasks: 1` and `useParallelTasks: false` as defaults, meaning most users never encounter parallel execution. Research-10's race conditions are therefore mostly theoretical for typical users — but become critical for anyone enabling the feature. [source: research-12.md#L139-L140] [source: research-10.md#L82-L83]

---

## Priority Matrix

| Pattern | Impact | Effort | Sources (with line refs) |
|---------|--------|--------|--------------------------|
| F1: Sequential `dependsOn` fix | **Critical** — tasks run out of order | **Trivial** — 1 line prod + ~25 lines test | [research-11.md](research-11.md#L75-L81), [research-12.md](research-12.md#L142-L144) |
| F2: Git commit serialization | **High** — misattributed commits, lost changes | **Low** — add `p-limit(1)` wrapper | [research-10.md](research-10.md#L56-L76) |
| F5: Cycle detection | **Medium** — silent deadlocks | **Low** — check remaining > 0 && ready === 0 | [research-12.md](research-12.md#L145-L147), [research-11.md](research-11.md#L62-L63) |
| F7: PRD file race condition | **Medium** — potential file corruption | **Low** — advisory lock or queue writes | [research-12.md](research-12.md#L137-L138) |
| F4: `Promise.all` → reactive dispatch | **Medium** — throughput waste | **Medium** — architectural change | [research-12.md](research-12.md#L131-L132) |
| F6: Post-parallel consistency check | **Low-Medium** — undetected conflicts | **Medium** — define what "consistent" means | [research-12.md](research-12.md#L134-L135), [research-10.md](research-10.md#L58-L60) |

---

## Gaps

1. **No research on `markTaskComplete()` race conditions in detail** — research-12 mentions the shared PRD file risk but no report actually traces the code path to verify whether concurrent writes can corrupt state.
2. **No benchmarks on parallel throughput** — research-12 notes `Promise.all` waste but no report measures actual time savings from parallelism vs sequential execution.
3. **No analysis of `git add <specific-files>` feasibility** — research-10 raises this as an open question (tracking which files each task modified) but doesn't investigate whether the execution strategy already captures this information.
4. **Checkpoint interaction with parallel batches not analyzed** — research-12 raises the question but none of the reports examine how `[CHECKPOINT]` markers interact with `Promise.all` dispatch.

---

## Sources
- research-10.md — Atomic Git Commits in Parallel (git serialization, race conditions, lock contention)
- research-11.md — Fix Sequential Mode dependsOn (pickNextTask bypass, 1-line fix, call site analysis)
- research-12.md — Comparison with Research Patterns (ecosystem comparison, DAG classification, gap analysis)
