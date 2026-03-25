# Ralph Loop — Issue Tracker

> Future improvements, enhancements, and tracked technical debt.
> Priority: **P0** (critical) | **P1** (high) | **P2** (medium) | **P3** (nice-to-have)

---

## Open Issues

### ISS-001: Planner→Coordinator→Executor→Reviewer Pipeline — [#2](https://github.com/lkonga/ralph-loop/issues/2)

**Priority**: P1
**Source**: giocaizzi/ralph-copilot sequential pipeline analysis
**Description**: Implement a full Planner→Coordinator→Executor→Reviewer pipeline as a configurable execution mode. Currently ralph-loop uses a simple execute→verify loop. The pipeline would add:
- **Planner**: Analyze task, break into substeps, define acceptance criteria
- **Coordinator**: Manage substep ordering and dependency resolution
- **Executor**: Current execution logic
- **Reviewer**: Post-execution review (partially covered by Phase 5 Task 6)

**DSL Config**: `executionPipeline?: { mode: 'simple' | 'pipeline'; stages: string[] }` with default `'simple'`. Pipeline stages are configurable and composable. A wave-router system could select which pipeline to use per task based on DSL task annotations.
**Future**: Parallelizable stages (e.g., multiple reviewers), wave definitions for task routing.
**Blocked by**: Phase 5 Tasks 6 (review-after-execute) and 7 (parallel monitor)

---

### ISS-002: Wave Router & Roster Definitions — [#3](https://github.com/lkonga/ralph-loop/issues/3)

**Priority**: P2
**Source**: User design direction — DSL-driven task routing
**Description**: Implement a wave-router system where tasks can be annotated with which "wave" (execution pipeline) to use. Waves define the parallel/multi-agent setup for a task. Roster definitions specify which agents/roles participate in each wave.
- Default wave: sequential single-agent (current behavior)
- Advanced waves: parallel execution, review pipeline, multi-agent collaboration
- DSL annotation: `<!-- wave: review-pipeline -->` in PRD task description
- Roster: `{ waveName: string; agents: AgentRole[]; parallelism: number }`
- All defaults to `false`/off — waves and rosters are opt-in

**Depends on**: ISS-001, Phase 5 Tasks 6, 7

---

### ISS-003: maxConcurrencyPerStage as DSL Config Flag — [#4](https://github.com/lkonga/ralph-loop/issues/4)

**Priority**: P1
**Source**: VS Code background pipeline analysis (SearchSubagentToolCallingLoop)
**Description**: Extract the `maxConcurrencyPerStage` pattern from VS Code's background pipeline and expose it as a first-class DSL config flag. This controls how many parallel operations can run at each stage (execution, review, validation). Partially implemented in Phase 5 Task 7 as `maxConcurrencyPerStage` in RalphConfig. This issue tracks making it a full DSL-level annotation that can be set per-task:
- Global default: `maxConcurrencyPerStage: 1`
- Per-task override: `<!-- concurrency: 3 -->` in PRD task description
- Per-stage override: `{ execution: 2, review: 5, validation: 1 }`

**Partially addressed by**: Phase 5 Task 7

---

### ISS-004: Single-Task Parallel Subagents via DSL — [#5](https://github.com/lkonga/ralph-loop/issues/5)

**Priority**: P2
**Source**: User design direction — subagents within a single task
**Description**: Enable running parallel subagents WITHIN a single task (not just parallel tasks). A task could spawn multiple Copilot sessions for subtasks, coordinate their outputs, and merge results. The current Phase 4 DAG parallel execution runs tasks in separate sessions — this issue extends that to subtask-level parallelism.
- Simple mode (same session): sequential subtask execution within one Copilot chat
- Advanced mode (multi-session): parallel subtask execution across sessions
- DSL annotation: `<!-- parallel: true -->` or `<!-- subtasks: [sub1, sub2] -->`
- Default: `false` (sequential, same session)

**Depends on**: ISS-001, ISS-002, Phase 5 Task 7

---

### ISS-005: Extract Hooks from Other Implementations — [#6](https://github.com/lkonga/ralph-loop/issues/6)

**Priority**: P2
**Source**: Ralph ecosystem analysis — 7 implementations reviewed
**Description**: Survey hook implementations across the Ralph ecosystem and extract reusable patterns:
- **frankbria/agentic-cursorrules**: Circuit breaker hooks with escalation
- **Gsaecy/Ralph_copilot**: 6 verifier types (checkbox, fileExists, fileContains, commandExitCode, testsPassing, custom)
- **giocaizzi/ralph-copilot**: Reviewer role hooks with structured feedback
- **sdancy10/project-management-ai-agent**: Quality checkpoint hooks

Create a hook catalog with standardized interfaces that can be plugged into the PreComplete hook chain (Phase 5 Task 4).

**Depends on**: Phase 5 Task 4

---

### ISS-006: Human Checkpoint System Enhancement — [#7](https://github.com/lkonga/ralph-loop/issues/7)

**Priority**: P1
**Source**: User design direction — human-in-the-loop escalation
**Description**: Enhance the human checkpoint system beyond the basic VS Code notification implemented in Phase 5 Task 5. Advanced capabilities:
- **Guided intervention**: Show the agent's current state, recent actions, and suggested next steps
- **Steering input**: User can type instructions that get injected into the next prompt
- **Decision tree**: Offer specific options based on the failure type (circuit breaker trip vs. validation failure vs. stagnation)
- **Auto-resume timer**: Optionally auto-resume after N seconds if user doesn't respond
- **History**: Track human interventions in progress.txt for context
- Integration with VS Code's notification system, webview panels, or chat participant

**Partially addressed by**: Phase 5 Tasks 5, 10

---

### ISS-007: LLM-Powered Consistency Checker — [#8](https://github.com/lkonga/ralph-loop/issues/8)

**Priority**: P3
**Source**: User design direction — hybrid LLM + deterministic validation
**Description**: Implement the LLM verification path in the consistency checker (Phase 5 Task 8). Currently stubbed as `runLlmVerification` returning skip. The full implementation would:
- Send task description + git diff to Copilot asking "verify this implementation matches the requirements"
- Parse structured response for pass/fail verdict
- Weight LLM verdict against deterministic checks
- Use as tiebreaker when deterministic checks pass but output quality is uncertain
- Configurable prompt template for the verification query

**Depends on**: Phase 5 Task 8
**Feature flag**: `useLlmConsistencyCheck: boolean = false` (already defined)

---

### ISS-008: Structured Review Rubric — [#9](https://github.com/lkonga/ralph-loop/issues/9)

**Priority**: P2
**Source**: giocaizzi/ralph-copilot reviewer role analysis
**Description**: Enhance the review-after-execute pattern (Phase 5 Task 6) with a structured scoring rubric:
- **Correctness** (0-10): Does the implementation meet the task requirements?
- **Code quality** (0-10): Idiomatic patterns, readability, maintainability
- **Test coverage** (0-10): Are new behaviors tested? Edge cases covered?
- **Security** (0-10): OWASP compliance, input validation, no secrets
- **Performance** (0-10): No obvious inefficiencies, appropriate algorithms
- Minimum passing score: configurable threshold (default 6.0 average)
- Auto-retry when score is below threshold

**Depends on**: Phase 5 Task 6

---

### ISS-009: Circuit Breaker Human Override — [#10](https://github.com/lkonga/ralph-loop/issues/10)

**Priority**: P2
**Source**: Phase 5 Task 3 — `onTrip` callback stub
**Description**: Implement the `onTrip` callback on `CircuitBreakerChain` that pauses for human input when a breaker trips. The callback returns `'override'` (ignore the trip and continue) or `'accept'` (take the breaker's recommended action). This enables human-in-the-loop override of automated decisions.
- Show which breaker tripped and why
- Offer override option with a warning
- Log all overrides for auditability
- Rate-limit overrides to prevent infinite loops

**Depends on**: Phase 5 Task 3, ISS-006

---

### ISS-010: New-Session Review Mode Optimization — [#11](https://github.com/lkonga/ralph-loop/issues/11)

**Priority**: P3
**Source**: Phase 5 Task 6 — review mode configuration
**Description**: Optimize the `new-session` review mode to provide clean, unbiased review:
- Generate a comprehensive review package (git diff, task description, test results)
- Open a fresh Copilot chat with no prior context
- Use a specialized review prompt that prevents anchoring bias
- Compare review quality between same-session and new-session modes
- Benchmark context usage and response quality

**Depends on**: Phase 5 Task 6

---

### ISS-011: Last Action / Last Tool Field in Status Bar

**Priority**: P2
**Source**: Phase 21 analysis — status bar DX improvements
**Description**: Add a "Last Action" or "Last Tool" field to the status bar tooltip showing what the agent is currently doing (e.g., "Applying edits", "Running tests", "Waiting for Copilot"). This requires plumbing granular tool-level events from the execution strategy (`CopilotCommandStrategy`, `DirectApiStrategy`) through the orchestrator into the `StateSnapshot`. Currently the execution strategies fire a prompt and wait — they don't emit intermediate events.

Implementation would require:
- New event types or callback plumbing in `ITaskExecutionStrategy`
- New state tracking in the orchestrator (`_lastAction: string`, `_lastActionAt: number`)
- Updating the snapshot on every tool invocation
- Surfacing in tooltip as `**Last Activity:** Running vitest... (2s ago)`

**Complexity**: High — invasive change across strategy → orchestrator → snapshot → statusBar.
**Deferred**: Requires event-driven execution strategy refactor. Not feasible as a surgical addition.
**Depends on**: Phase 21 (status bar enrichment foundation)
