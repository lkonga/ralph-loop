# Research 12: Comparison with Research Patterns — Parallel Execution Approaches

**Question**: Compare ralph's parallel approach with patterns found in prior research files — is this standard practice or novel? How do other orchestrators handle parallel task execution?

**Date**: 2026-03-17  
**Sources**: `AI_AGENT_ORCHESTRATION_COMPARISON.md`, `09-ecosystem-patterns-synthesis.md`, `08-ralph-orchestrator-analysis.md`, `11-gap-analysis.md`, `_wave/2026-03-17-ralph-checkpoint-patterns/research-9.md`, `src/orchestrator.ts`, `src/prd.ts`, `src/types.ts`

---

## Findings

### 1. Ralph's Parallel Execution Architecture

Ralph implements a **DAG-aware batch parallelism** model with the following mechanics:

**Task selection** (`prd.ts:106-120`): `pickReadyTasks()` resolves a dependency graph by collecting completed task IDs, then returns only pending tasks whose `dependsOn` entries are fully satisfied. This is a classic topological-order scheduler — it returns the current "frontier" of ready tasks.

**Parallel dispatch** (`orchestrator.ts:517-575`): When `useParallelTasks: true` and `maxParallelTasks > 1`, the orchestrator:
1. Calls `pickReadyTasks(snapshot, concurrencyCap)` to get the current frontier
2. Dispatches all ready tasks via `Promise.all()` — fire-and-forget fan-out
3. Each task gets its own prompt build, execution, and commit cycle
4. After the batch completes, a countdown runs before the next batch
5. If only 1 task is ready, falls through to the sequential single-task path

**Concurrency control**: Two config knobs — `maxParallelTasks` (cap on ready tasks selected) and `maxConcurrencyPerStage` (overrides the former when > 1). Defaults are both `1`, meaning parallel execution is **off by default**.

**Key limitation**: The sequential fallback path (`pickNextTask()`) ignores dependencies entirely — it returns the first pending task regardless of `dependsOn`. Dependencies only gate in parallel mode. (Source: research-9.md finding)

### 2. How Other Orchestrators Handle Parallel Execution

Based on the AI orchestration comparison and ecosystem synthesis, here is how competitors approach parallelism:

#### LangGraph — Graph-Based Dynamic Parallelization (Leader)

LangGraph provides the most sophisticated parallel model:
- **Graph state machine**: Workflows are explicit graphs with nodes and edges
- **Send API**: Enables dynamic fan-out — a node can spawn N parallel sub-nodes at runtime based on data
- **Map-reduce**: Native pattern where a scatter node fans out work, a gather node collects results
- **Conditional routing**: Edges can be conditional, enabling dynamic DAG construction
- **State checkpointing**: Each node's state is checkpointed, enabling resume after failure

This is the gold standard for DAG-based agent orchestration. Ralph's `pickReadyTasks()` approaches LangGraph's frontier selection but lacks dynamic task creation, map-reduce aggregation, and conditional routing.

#### CrewAI — Role-Based Flows

- **Flows architecture**: `start/listen/router` steps enable complex orchestration
- **Process modes**: Sequential, hierarchical, or hybrid execution
- **Parallel support**: Flows can run steps in parallel when dependencies allow
- **Limitation**: Parallelism is coarser-grained than LangGraph — orchestrated at the Flow level, not individual task level

#### AutoGen (Microsoft) — GroupChat Orchestration

- **GroupChat**: Multiple agents take turns in a managed conversation
- **Primarily sequential**: Agents converse in rounds; parallelism is limited
- **Max_turns**: Simple iteration limit, no DAG scheduling
- **No explicit parallel dispatch**: Agents are coordinated via message passing, not concurrent execution

#### Aider — No Parallelism

- Single-agent sequential model
- User-driven, one turn at a time
- No DAG, no parallel execution whatsoever

#### Cline / Cursor / Continue.dev — Minimal or No Parallelism

- All primarily sequential single-agent systems
- Continue.dev has limited agent composition but no parallel task dispatch
- Cursor's internals are proprietary; no documented parallel execution

#### ralph-orchestrator (mikeyobrien) — Event-Driven Pub/Sub

- **Hat system**: Specialized personas subscribe to event topics
- **Not true parallelism**: Events are processed sequentially through the pub/sub bus
- **Indirect concurrency**: Different hats handle different phases, but execution is serial
- **Key insight**: Enables multi-phase workflows without hardcoded sequences, but doesn't actually parallelize execution

#### choo-choo-ralph — Parallel Safety Mentions

- References "parallel instance safety" for running multiple loop instances
- This is process-level isolation (multiple ralph loops on different workspaces), not task-level parallelism within a single loop

### 3. Classification of Parallel Approaches Across Orchestrators

| Approach | Systems | Description |
|----------|---------|-------------|
| **No parallelism** | Aider, Cline, Cursor, AutoGen | Purely sequential, one task/turn at a time |
| **Process-level isolation** | choo-choo-ralph | Multiple independent loop instances, no shared state |
| **Batch fan-out (Promise.all)** | **ralph-loop** | DAG frontier → fire all ready tasks → wait for all → next batch |
| **Flow-level parallelism** | CrewAI | Coarse-grained parallel steps within a Flow |
| **Graph-based dynamic parallelism** | LangGraph | Fine-grained Send API, map-reduce, conditional routing |
| **Event-driven sequential** | ralph-orchestrator | Pub/sub routing, serial execution, multi-phase workflows |

---

## Patterns

### Pattern A: DAG Frontier Batch Dispatch (Ralph's Approach)

```
Parse PRD → Build dependency graph → Find ready frontier → Promise.all(frontier) → Wait → Repeat
```

**Characteristics**:
- Static DAG derived from PRD annotations (`depends: TaskN`)
- Batch granularity — all frontier tasks run together, wait for ALL to finish before next batch
- No partial completion handling — if one task in the batch takes 10x longer, fast tasks wait
- No dynamic task creation mid-batch
- Simple to reason about; predictable execution order

**Where this is standard**: This is the classic **level-by-level BFS traversal** of a DAG, widely used in build systems (Make, Bazel), CI/CD pipelines (GitHub Actions job dependencies), and workflow engines (Airflow). It is a well-established, not novel, approach.

### Pattern B: Dynamic Fan-Out / Map-Reduce (LangGraph)

```
Node executes → Sends N sub-tasks dynamically → Sub-tasks run in parallel → Gather node aggregates → Continue
```

**Characteristics**:
- DAG is constructed dynamically at runtime
- Sub-tasks can spawn further sub-tasks (recursive parallelism)
- Gather/reduce step aggregates results
- Supports conditional branching

**Where this is standard**: Apache Spark, MapReduce, Dask, Ray. LangGraph brings this to agent orchestration.

### Pattern C: Worker Pool with Task Queue

```
Tasks submitted to queue → N workers pull from queue → Workers execute independently → Results collected
```

**Not used by any analyzed orchestrator**, but common in general distributed systems (Celery, Bull, SQS workers). Could be adapted: task queue populated from PRD, N Copilot sessions as workers.

### Pattern D: Pipeline Parallelism

```
Task A stage 1 → Task A stage 2 → Task A stage 3
                  Task B stage 1 → Task B stage 2
                                    Task C stage 1
```

**Not used by any analyzed orchestrator**. Assembly-line parallelism where different tasks are at different stages simultaneously. Would require decomposing tasks into stages (plan → implement → verify).

---

## Assessment: Standard, Novel, or Lagging?

### Verdict: **Standard approach, competently implemented, with known gaps**

Ralph's `Promise.all` batch dispatch of DAG frontier tasks is a **well-established pattern** — it's essentially the same algorithm used by:
- **Make/Bazel**: Build independent targets in parallel, respect dependency ordering
- **GitHub Actions**: Jobs with `needs:` dependencies run in parallel when ready
- **Apache Airflow**: Tasks with upstream dependencies form a DAG; ready tasks execute in parallel
- **Kubernetes Jobs**: Parallel job execution with completion dependencies

This is **not novel** — it's a proven, reliable approach. Ralph deserves credit for being the **only VS Code AI coding agent in the analyzed ecosystem** to implement DAG-aware parallel task execution. Among the 7 compared systems (Aider, Continue, Cursor, Cline, AutoGen, CrewAI, LangGraph), only LangGraph and CrewAI offer comparable or superior parallel capabilities, and those are general-purpose orchestration frameworks, not VS Code extensions.

### Where Ralph Leads

1. **Only VS Code extension with DAG-aware parallelism**: Aider, Cline, Cursor, Continue — all sequential
2. **Automatic frontier detection**: `pickReadyTasks()` is clean and correct for its scope
3. **Per-task atomic commits in parallel**: Each parallel task gets its own git commit — good isolation
4. **Configurable concurrency cap**: `maxParallelTasks` and `maxConcurrencyPerStage` provide sensible limits

### Where Ralph Lags

1. **Dependencies ignored in sequential mode**: `pickNextTask()` bypasses the DAG. This means the dependency system is only half-wired. (Source: research-9.md)
2. **No partial completion**: `Promise.all` waits for ALL tasks in a batch. If one task takes 5 minutes and another takes 30 seconds, 4.5 minutes are wasted. `Promise.allSettled` or individual task tracking would be better.
3. **No dynamic task creation**: Tasks are static from the PRD. LangGraph's Send API allows runtime fan-out based on intermediate results.
4. **No map-reduce aggregation**: No mechanism to collect and combine results from parallel tasks.
5. **No post-batch consistency check**: Research-10 identifies that parallel tasks can write conflicting changes. Each passes individual verification, but combined state may be incorrect.
6. **No cycle detection**: Circular dependencies in `pickReadyTasks()` create silent deadlocks — the loop terminates with `AllDone` while tasks remain pending. (Source: research-9.md)
7. **Parallel is OFF by default**: `maxParallelTasks: 1` and `useParallelTasks: false` mean most users never see this capability.
8. **Shared PRD file as state**: All parallel tasks read/write the same PRD file — potential race condition on `markTaskComplete()`.

---

## Gaps/Concerns

### Critical Gaps

| Gap | Impact | Comparison |
|-----|--------|------------|
| Dependencies ignored in sequential mode | Tasks execute out of order, violating user-declared constraints | Build systems never allow this — `make` always respects dependencies |
| No cycle detection | Silent deadlock; tasks stuck forever with no error | Every production DAG scheduler (Airflow, Bazel) detects and reports cycles |
| No post-parallel consistency check | Conflicting changes from parallel tasks go undetected | CI systems run integration tests after parallel jobs merge |

### Moderate Gaps

| Gap | Impact | Comparison |
|-----|--------|------------|
| `Promise.all` blocks on slowest task | Wasted wall-clock time | Airflow, GitHub Actions start next-ready tasks as predecessors complete individually |
| No dynamic task spawning | Can't adapt parallelism to intermediate results | LangGraph's Send API enables this; static PRDs can't |
| Shared mutable PRD state | Race conditions in parallel `markTaskComplete()` | Build systems use atomic task state updates or locks |
| Parallel off by default | Feature is invisible to most users | Should at least be documented prominently |

### Minor Gaps

| Gap | Impact |
|-----|--------|
| No priority ordering within a frontier | All ready tasks treated equally; can't prioritize critical path |
| No resource-aware scheduling | Can't limit parallelism based on system load or model rate limits |
| No cancel-on-failure semantics | If one parallel task fails catastrophically, others continue |

---

## Open Questions

1. **Should `pickNextTask()` respect dependencies?** The sequential path ignoring `dependsOn` is arguably a bug, not a feature. Making sequential mode DAG-aware would unify behavior and prevent out-of-order execution.

2. **Is `Promise.all` the right primitive?** Would `Promise.allSettled` with individual completion tracking allow better throughput — starting the next ready task as soon as any predecessor completes, rather than waiting for the entire batch?

3. **How should checkpoint tasks interact with parallel batches?** If one task in a parallel batch hits a `[CHECKPOINT]`, should the entire batch pause? Should the checkpoint task be excluded from parallel dispatch entirely?

4. **Should ralph support cancel-on-failure?** If a parallel task fails with a circuit breaker trip, should sibling tasks in the same batch be cancelled via `AbortController`?

5. **Is file-level locking needed for `markTaskComplete()`?** With `Promise.all` dispatching multiple tasks that each call `markTaskComplete()` on the same PRD file, race conditions are possible. Advisory file locks or atomic state management could prevent corruption.

6. **Would a streaming/reactive model outperform batch dispatch?** Instead of batch → wait → batch, a reactive model where task completion immediately triggers dependents would maximize throughput. This is how Airflow and modern CI systems work.
