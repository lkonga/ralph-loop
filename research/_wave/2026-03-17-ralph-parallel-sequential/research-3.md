# Research 3: Origins of Parallel Mode

**Question**: Was parallel mode extracted from another ralph implementation (vinitm/ralph, frankbria/ralph-claude-code, etc.) or was it an original design?

## Findings

### Primary Source: VS Code Copilot Chat — SearchSubagentToolCallingLoop

Parallel mode was **not extracted from any ralph implementation**. The PRD explicitly attributes it to the VS Code Copilot Chat codebase:

> **PRD.md Phase 4 header** (line 87–89): "Patterns extracted from the agentic proxy implementation: ProxyAgenticSearchEndpoint, SearchSubagentToolCallingLoop, subagent invocation lifecycle, and **background pipeline architecture**."

The specific task (PRD line 107) that introduced parallel execution states:

> "This mirrors **VS Code's background pipeline where reviewers run in parallel (up to 20) with a `maxConcurrencyPerStage` cap**."

The parallel monitor (PRD line 140) similarly references:

> "`maxConcurrencyPerStage: number` to `RalphConfig` (default 1) — **mirrors VS Code's `maxConcurrencyPerStage` from SearchSubagentToolCallingLoop**."

### What Other Ralph Implementations Had

| Implementation | Parallel/DAG Support | Details |
|---|---|---|
| **vinitm/ralph-loop** | DAG task list (`tasks.json`) | Has task dependencies but executes **sequentially** — tester then implementer per task. No parallel execution. (research/06-vinitm-ralph-loop-analysis.md §1) |
| **frankbria/ralph-claude-code** | None | Linear loop with circuit breaker. No DAG, no parallelism. (research/07-frankbria-ralph-claude-code-analysis.md §1) |
| **mikeyobrien/ralph-orchestrator** | Event-driven pub/sub (hats) | Event routing to specialized "hats" — but hats execute sequentially, one event at a time. No parallel hat execution. (research/08-ralph-orchestrator-analysis.md §1) |
| **mj-meyer/choo-choo-ralph** | "Parallel safety" mentioned | Listed in ecosystem synthesis (research/09-ecosystem-patterns-synthesis.md, source #6) with "parallel safety" — but this refers to **safety when running multiple loop instances**, not parallel task execution within a single loop. |
| **Gsaecy/Ralph-Loop-Code** | Auto-decomposition into sub-tasks | Sub-tasks are executed sequentially. No parallel sub-task execution. (research/03-ralph-ecosystem-analysis.md §4) |
| **snarktank/ralph (original)** | None | Simple linear bash loop. (research/03-ralph-ecosystem-analysis.md §1) |
| **giocaizzi/ralph-copilot** | None | 4-agent pipeline (Planner→Coordinator→Executor→Reviewer) — sequential roles. (research/03-ralph-ecosystem-analysis.md §6) |

### The DAG Dependency Concept's Lineage

The `dependsOn` field (which is prerequisite for parallel mode) draws from **two sources**:

1. **vinitm/ralph-loop**: Used `tasks.json` as a "DAG task list with dependencies" (research/06-vinitm-ralph-loop-analysis.md, Key Files table). This is the only ralph implementation with explicit dependency tracking.

2. **VS Code Copilot Chat**: The `SearchSubagentToolCallingLoop` background pipeline architecture provided the concurrency model — `maxConcurrencyPerStage` cap, parallel reviewer execution, and the monitor/observe pattern for in-flight tasks.

### How It Was Assembled

Ralph-loop's parallel mode is a **synthesis** of:
- **Dependency graph concept** ← vinitm's `tasks.json` DAG (adapted to PRD.md checkbox format with `depends:` annotations and indentation-based inference)
- **Parallel execution engine** ← VS Code Copilot Chat's `SearchSubagentToolCallingLoop` background pipeline (multiple agents running concurrently with a concurrency cap)
- **Monitor pattern** ← VS Code's per-stage monitoring with stuck detection (`maxConcurrencyPerStage`, stale interval counting)

No single ralph implementation had parallel task execution. The design was **original to ralph-loop**, inspired by VS Code Copilot Chat internals (not another ralph fork).

## Patterns

1. **Cross-pollination pattern**: Ralph-loop borrowed the *dependency structure* from one source (vinitm's DAG) and the *execution model* from an entirely different source (VS Code Copilot Chat's background pipeline). Neither source had both.

2. **Config-gated introduction**: Parallel mode was introduced behind `useParallelTasks: boolean = false` (PRD line 111), following VS Code's `ConfigType.ExperimentBased` pattern. Default remains sequential (`maxParallelTasks: 1`).

3. **PRD-as-DAG pattern**: Rather than using a separate `tasks.json` (vinitm) or YAML config (ralph-orchestrator), ralph-loop encodes the dependency graph *within* the PRD.md file itself via `depends:` annotations and indentation inference. This is unique to ralph-loop.

4. **Dual scheduler divergence**: `pickReadyTasks()` (parallel, DAG-aware) vs `pickNextTask()` (sequential, ignores dependencies) — documented as a critical reliability gap in later research (research/_wave checkpoint analysis).

## Gaps/Concerns

1. **No prior art for parallel Copilot chat sessions**: None of the analyzed ralph implementations open multiple Copilot chats simultaneously. This is uncharted territory — VS Code's workbench commands for chat (`workbench.action.chat.open`, `workbench.action.chat.newEditSession`) were designed for single-session use. The PRD assumes they can be parallelized but no validation of this assumption exists in the research.

2. **vinitm's DAG was for sequential execution**: vinitm's `tasks.json` DAG determined *ordering* (which task to run next after its dependencies complete), not *parallelism*. Ralph-loop repurposed the concept for concurrent execution — a different use case with different failure modes.

3. **Background pipeline analogy is imprecise**: VS Code's `SearchSubagentToolCallingLoop` background pipeline runs *read-only* reviewers in parallel. They don't modify files. Ralph-loop's parallel tasks are *write-heavy* (they edit code, modify PRD checkboxes, append to progress.txt). Concurrent file modifications create race conditions not present in the original VS Code pattern.

4. **choo-choo-ralph "parallel safety" is different**: The ecosystem synthesis lists choo-choo-ralph with "parallel safety" but this addresses inter-instance safety (multiple ralph loops running on different projects), not intra-loop parallelism. This distinction may have been overlooked.

## Open Questions

1. Has anyone tested opening multiple VS Code Copilot chat sessions simultaneously via workbench commands? Does `workbench.action.chat.open` support concurrent invocations?
2. The `SearchSubagentToolCallingLoop` source code was analyzed for Phase 4 patterns, but there's no dedicated research file for it (unlike autopilot in `02-autopilot-deep-dive.md`). Was this analysis done informally or in an untracked session?
3. Why was vinitm's `tasks.json` DAG concept not credited in the PRD? Phase 4 only credits `SearchSubagentToolCallingLoop` for the parallel pattern, but the dependency graph structure predates it.
4. Should the sequential path (`pickNextTask`) also respect dependencies? Currently `depends:` annotations only have effect when parallel mode is enabled — a usability trap for users.
