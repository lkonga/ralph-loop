# Research Report 2: Wave-Orchestrator Subagent Chaining & Operational Modes

## Findings

### Subagent Chaining Architecture

The wave-orchestrator (`vscode-config-files/agents/wave-orchestrator.agent.md`) is the top-level dispatch agent. Its frontmatter declares seven subagents it can invoke via `runSubagent`:

```yaml
agents: ['wave-decompose', 'wave-researcher', 'wave-group-aggregator',
         'wave-master-aggregator', 'wave-context-grounder',
         'wave-spec-generator', 'wave-prd-generator']
tools: [read, search, agent]
```

The chaining follows a **fan-out / fan-in** topology with strict parallelism rules:

1. **wave-decompose** — 1 agent. Takes `{N} {TOPIC}`, outputs N non-overlapping questions with search hints (file paths, grep patterns). Not invocable by users (`user-invocable: false`).
2. **wave-researcher** — N agents dispatched in ONE parallel batch. Each researches one question, writes `research/_wave/{WAVE_ID}/research-{I}.md`, returns ≤10-line summary.
3. **wave-group-aggregator** — `ceil(N/K)` agents in ONE parallel batch.  Reads K research reports per group, writes `aggregation-{GROUP}.md`. Deduplicates findings, builds priority matrix, preserves `[source: research-{I}.md#L{start}-L{end}]` references.
4. **wave-master-aggregator** — 1 agent. Reads ONLY aggregation reports (never raw research), writes `FINAL-REPORT.md`. Preserves `[via:]` reference chains for progressive disclosure traceability.

Total agent count for aggregate mode: `N + ceil(N/K) + 2` (N researchers + ceil(N/K) group-aggregators + 1 decomposer + 1 master).

**Mandatory parallelism**: The orchestrator document states "PARALLEL DISPATCH IS MANDATORY" — all same-tier dispatches must use a single `runSubagent` batch call. Sequential or 2-3-at-a-time dispatch is explicitly forbidden.

### Intermediate agent: wave-research (dispatch engine)

There is an intermediate `wave-research.agent.md` that acts as a "parallel dispatch engine" — it receives N questions and dispatches N `wave-researcher` subagents in one batch. This adds a layer of indirection between the orchestrator and the individual researchers.

### All output goes to `research/_wave/{WAVE_ID}/`

WAVE_ID format: `{date}-{topic-slug}` (e.g., `2026-03-15-auth-patterns`). All files live in this directory — no cross-directory writes. N is capped at 12.

---

### Mode 1: Aggregate (default — no flags)

**Chain**: decompose → N researchers (parallel) → ceil(N/K) group-aggregators (parallel) → 1 master-aggregator → present
- K defaults to 3, configurable via `--aggregate=K` (range 2–6).
- Produces a full file artifact tree: `research-{1..N}.md`, `aggregation-{1..G}.md`, `FINAL-REPORT.md`.
- 5 orchestrator steps: Decompose → Research Wave → Group Aggregation → Master Aggregation → Present.
- The present step prints an executive summary, file manifest, and a `/wave-return-to-agent` prompt.

### Mode 2: Direct (`--direct` flag)

**Chain**: decompose → N researchers (parallel, NO file writes) → inline synthesis
- Lightweight: researchers return findings directly without writing files.
- Orchestrator performs inline synthesis: Deduplicate → Connect → Synthesize (≤40 lines) → Gaps → Next Steps.
- No aggregation agents are dispatched.
- Good for quick exploration where persistent artifacts aren't needed.

### Mode 3: Same (`--same` flag)

**Chain**: N researchers with IDENTICAL prompt (parallel) → inline synthesis
- Skips decompose entirely — all N agents receive the same raw topic prompt.
- Intended for ensemble/majority-vote style exploration where multiple agents independently analyze the same question.
- Same inline synthesis as Direct mode.
- No files written.

### Mode 4: Ralph PRD (`--ralph-prd` flag)

**Chain**: 6 phases with 3 human checkpoints. Extends Aggregate mode with pre/post processing stages.

| Phase | Agent(s) | Output |
|-------|----------|--------|
| 0: Context Grounding | 1× wave-context-grounder | `context-brief.md` — ≤30 lines, ≤2K tokens. Reads PRD.md + README.md + 3-zone git log sampling. |
| 1: Research Wave | Full Aggregate Mode flow (reuses logic, not duplicated) | `FINAL-REPORT.md` — ContextBrief appended to each researcher's prompt. |
| **Checkpoint 1** | Human | Review FINAL-REPORT. Choose: Continue / Refine / Stop. |
| 2: Spec Generation | 1× wave-spec-generator | `research/{NN}-phase{P}-deep-research.md` — raw task specs, NO frontmatter. Auto-detects next phase/task/file numbers. |
| **Checkpoint 2** | Human | Review task list. Choose: Continue / Refine / Back / Stop. |
| 3: Seal Spec | Orchestrator (inline) | Applies YAML frontmatter to spec file (`type: spec`, `tasks`, `phase`, `verification`, `completion_steps`, `principles`). |
| 4: PRD Generation | 1× wave-prd-generator | PRD entries classified as Tier 1 (inline, ≤3 sentences) or Tier 2 (spec reference with line ranges). |
| **Checkpoint 3** | Human | Review PRD entries. Choose: Apply / Refine / Back / Stop. |
| 5: Finalize | Orchestrator (inline) | Appends approved entries to `PRD.md`, updates `research/INDEX.md`. |

**Checkpoint state**: Each phase writes `phase-{N}-state.json` with `{ waveId, phase, inputs, outputs, userSteering, timestamp }`. This enables go-back at any checkpoint — reload state, clear later phases, append user feedback, and re-run.

**Refinement loops**: At each checkpoint, "Refine" re-runs the current phase with user feedback injected as `userSteering`. "Back" reloads a prior phase's state and re-runs from there.

---

## Patterns

### Fan-out / Fan-in with Tiered Aggregation
The core pattern is a MapReduce-style pipeline: decompose a topic into N independent questions, parallel-process them, then reduce through two tiers of aggregation (group → master). This keeps each agent's context small while producing a comprehensive final report.

### Progressive Disclosure Traceability
Every aggregation level preserves source references (`[source:]` → `[via:]` chains), enabling readers to drill from FINAL-REPORT → aggregation → research reports without re-running anything.

### Checkpoint-Retry with State Files
The `--ralph-prd` mode uses JSON state files per phase, enabling non-linear human-in-the-loop control. Users can go back to any checkpoint, inject feedback, and replay from that point. This separates orchestration state from conversation context.

### Frontmatter Sealing as Last Transformation
Spec files are written raw during research, then sealed with YAML frontmatter only after user approval. This prevents premature commitment to task structure before review.

### Mandatory Parallel Dispatch
A hard constraint: never sequential dispatch. This maximizes throughput by ensuring all same-tier agents run concurrently.

### Read-Only Research Constraint
The entire wave system is read-only with respect to source code. It discovers, analyzes, and writes reports but never edits implementation files.

---

## Applicability

**Rating: HIGH** — This is the central orchestration mechanism for the wave research system. Understanding the four modes and chaining topology is essential for:

1. **Implementing ralph-prd in ralph-loop**: The 6-phase pipeline with checkpoints is the target workflow to replicate.
2. **Understanding agent count budgets**: Aggregate mode uses `N + ceil(N/K) + 2` agents; ralph-prd adds 3 more (context-grounder, spec-generator, prd-generator) plus the aggregate pipeline.
3. **Designing checkpoint/replay**: The `phase-{N}-state.json` pattern is the mechanism for human-in-the-loop steering.
4. **Choosing the right mode**: Direct/Same for quick exploration; Aggregate for thorough research; ralph-prd for end-to-end research-to-implementation pipeline.

---

## Open Questions

1. **wave-research.agent.md vs direct orchestrator dispatch**: There's an intermediate "dispatch engine" agent (`wave-research.agent.md`) that sits between the orchestrator and individual researchers. Is this always used, or does the orchestrator dispatch researchers directly in some modes?
2. **Hooks integration**: The orchestrator has `SubagentStart` and `Stop` hooks (`wave-subagent-start.py`, `wave-orchestrator-stop.py`). What do these hooks do and how do they affect the pipeline?
3. **Checkpoint-retry pattern doc**: `docs/patterns/checkpoint-retry.md` and `docs/patterns/frontmatter-sealing.md` are referenced but not found in the workspace — may be planned but not yet written.
4. **Context-grounder cache**: The context-grounder mentions a pre-computed cache at `.ralph/codebase-brief.md` (Task 35) — is this implemented?
5. **Error handling**: No explicit error/retry logic is documented for when a subagent fails or times out during parallel dispatch.
