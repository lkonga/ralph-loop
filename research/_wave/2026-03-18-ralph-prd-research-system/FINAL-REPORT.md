# Final Report: Ralph-Loop PRD Research System — Architecture, Pipeline & Readiness

## Executive Summary

Ralph-loop implements a two-system architecture: a **Wave pipeline** (read-only research MapReduce) and a **Ralph pipeline** (privileged code implementation), bridged by `--ralph-prd` mode through a 6-phase pipeline with 3 human checkpoints. The Wave pipeline fans out N parallel researchers, consolidates via tiered aggregation with unbroken provenance chains (PRD → spec → FINAL-REPORT → aggregation → research → source code), then transforms findings into implementable PRD entries through spec generation and tier-classified task formatting. All inter-agent contracts are prompt-enforced (no schema validation), with deliberate information barriers between tiers forcing genuine synthesis. The core engine (Phases 1–10) is production-ready with 470+ unit tests; all 12 remaining unchecked tasks are in Phase 11 (Wave Pipeline & Research Automation), making it the critical implementation frontier. Key risks: prompt-based contract fragility, stale line-range pointers, absent error recovery, and wave output discoverability gap.

## Consolidated Findings

### 1. PRD Task DSL & Annotation System

The PRD is a flat-file markdown DSL parsed by regex in `src/prd.ts`. Tasks follow strict format: `- [ ] **Task NN — Name**: Description` with six inline annotations controlling orchestration behavior:

| Annotation | Effect |
|---|---|
| `[DECOMPOSED]` | Task skipped (non-actionable) |
| `[CHECKPOINT]` | Pause for human review |
| `[AGENT:name]` | Route to specific agent |
| `[NO_DIFF]` | Skip diff validation |
| `depends: task-id` | DAG ordering |
| `→ Spec: path LNN-LNN` | Link to spec file line range |

Phase-level `[AGENT:name]` on `### ` headers is inherited by all child tasks. `pickReadyTasks()` resolves dependencies for DAG-based execution, falling back to sequential if any task uses a write agent. `validatePrd()` performs non-empty, duplicate, dangling reference, and circular dependency DFS checks.
[via: aggregation-1.md#L31-L68 ← research-1.md#L12-L101]

### 2. Fan-Out/Fan-In Orchestration Architecture

The system implements MapReduce-style pipeline orchestration with mandatory parallel batch dispatch at each tier:

```
wave-decompose (1) → wave-researcher (N, parallel) → wave-group-aggregator (ceil(N/K), parallel) → wave-master-aggregator (1) → wave-spec-generator (1) → wave-prd-generator (1)
```

Total agent count for Aggregate mode: `N + ceil(N/K) + 2`. K defaults to 3, configurable via `--aggregate=K` (range 2–6). Each tier runs in a single parallel batch but tiers execute sequentially. The orchestrator dispatches agents directly (flat dispatch), having subsumed the standalone `wave-research` dispatch engine and deprecated the monolithic `wave-aggregate` agent.
[via: aggregation-1.md#L70-L84 ← research-2.md#L10-L42] [via: aggregation-2.md#L47-L57 ← research-4.md#L86-L92, research-5.md#L115-L120]

### 3. Four Operational Modes

| Mode | Flag | Chain | Artifacts |
|------|------|-------|-----------|
| Aggregate | (default) | decompose → researchers → group-agg → master-agg | Full file tree |
| Direct | `--direct` | decompose → researchers (no writes) → inline synthesis | None |
| Same | `--same` | N researchers with identical prompt → inline synthesis | None |
| Ralph PRD | `--ralph-prd` | 6 phases with 3 checkpoints, extends Aggregate | Full tree + specs + PRD entries |

Direct and Same are lightweight exploration; Aggregate and Ralph PRD produce persistent artifacts.
[via: aggregation-1.md#L86-L100 ← research-2.md#L35-L82]

### 4. Ralph PRD 6-Phase Pipeline

| Phase | Agent | Output | Checkpoint |
|-------|-------|--------|------------|
| 0 | wave-context-grounder | context-brief.md (≤30 lines, ≤2K tokens) | — |
| 1 | Full Aggregate flow | FINAL-REPORT.md | **CP1**: Review report |
| 2 | wave-spec-generator | Raw spec file (no frontmatter) | **CP2**: Review tasks |
| 3 | Orchestrator (inline) | Sealed spec (YAML frontmatter applied) | — |
| 4 | wave-prd-generator | PRD entries (Tier 1 inline / Tier 2 spec-ref) | **CP3**: Review PRD |
| 5 | Orchestrator (inline) | Appends to PRD.md, updates INDEX.md | — |

Checkpoint state files (`phase-{N}-state.json`) enable go-back, refine, and replay from any checkpoint. The `CheckpointStore` manages per-phase JSON with 5 API methods (savePhase, loadPhase, listPhases, goBack, clearWave). Go-back rewind deletes downstream states, injects `userSteering` feedback, and re-runs from the target phase.
[via: aggregation-1.md#L102-L120 ← research-2.md#L60-L85] [via: aggregation-4.md#L49-L68 ← research-11.md#L23-L68]

### 5. Full Provenance Traceability Chain

An unbroken reference chain spans the entire system:

- **Research tier**: `file:line` references in findings sections
- **Group aggregation tier**: `[source: research-{I}.md#L{start}-L{end}]` annotations
- **Master tier**: `[via: aggregation-{G}.md#L... ← research-{I}.md#L...]` chains
- **Spec tier**: Line Range Index mapping task numbers to line ranges
- **PRD tier**: `→ Spec: path LN-LN` back-references

Complete chain: `PRD entry → spec file → FINAL-REPORT → aggregation → research → source code`. Each tier adds its own traceability mechanism, composing into progressive disclosure navigation.
[via: aggregation-2.md#L27-L42 ← research-4.md#L29-L35, research-5.md#L67-L90, research-6.md#L80-L86]

### 6. Spec Generation & Unsealed→Sealed Pipeline Split

The `wave-spec-generator` receives exactly two inputs (FINAL-REPORT.md + context-brief.md) and applies a 4-stage transformation: Filter (drop low-impact/covered) → Order (dependency-aware) → Group (3-4 tasks per sub-phase) → Specify (full task spec blocks). Output is deliberately unsealed (no YAML frontmatter).

Sealing is deferred to Phase 3 (after Checkpoint 2 user review) following: `Research → Spec (raw) → User refines → Seal → PRD entries`. Frontmatter sealing must be the LAST transformation because `buildPrompt()` reads it at runtime via `buildSpecContextLine()` — premature sealing causes agents to execute against stale context.

Auto-numbering uses a fallback chain: ContextBrief cache → PRD.md scan → research/ directory listing.
[via: aggregation-2.md#L59-L77 ← research-6.md#L16-L96] [via: aggregation-4.md#L70-L82 ← research-11.md#L72-L120]

### 7. PRD Generator Tier Classification

The `wave-prd-generator` classifies tasks into two tiers:
- **Tier 1** (inline): ≤3 sentences, single surgical change — full description in PRD entry
- **Tier 2** (spec-backed): deliberately terse one-liner with `→ Spec: path L{start}-L{end}` pointer

Line-range indexing scans `### Task NN` headers to build pointers. Auto-numbering detects `max(Task NN) + 1` from existing PRD.md via regex. Output is a phase section block presented with [Apply]/[Refine]/[Back]/[Stop] human review gate — PRD.md is never auto-written.
[via: aggregation-3.md#L7-L16 ← research-7.md#L1-L63]

### 8. Context Grounder & Duplicate Prevention

Phase 0's `wave-context-grounder` produces a ContextBrief (≤30 lines, ≤2K tokens) containing: Project/Stack/Structure, Completed, In Progress, Numbering, Codebase Fingerprint, Conventions, Do NOT Research.

**3-zone commit-sampling**: reads first 10, middle 10, last 10 git commits (falls back to all if <30 total) with `git log` + `git show --stat`, LLM-summarized into a Codebase Fingerprint. Cacheable at `.ralph/codebase-brief.md`.

**Triple-layer duplicate prevention**:
1. Explicit "Do NOT Research" blocklist in ContextBrief
2. "Completed" section listing finished capabilities
3. Prompt injection: orchestrator appends ContextBrief to every researcher prompt

This negative-space approach tells agents what NOT to investigate — no semantic similarity detection required.
[via: aggregation-3.md#L18-L60 ← research-8.md#L5-L63]

### 9. Agent Privilege Model

Ralph uses an escalating privilege hierarchy with belt-and-suspenders tool restrictions:

| Agent | Privileges | Key Tools |
|-------|-----------|-----------|
| ralph-explore | Read-only codebase | read, search, semantic |
| ralph-research | Read + web access | read, search, web |
| ralph-executor | Full write/execute/terminal | All tools, `manage_todo_list`, dispatches subagents |

Wave agents form a separate read-only pipeline — they never edit source code, only writing to `research/_wave/`. The `--ralph-prd` flag bridges Wave (research) and Ralph (implementation): Wave produces PRD entries that Ralph executor then implements. Only the executor owns task state.
[via: aggregation-4.md#L31-L47 ← research-10.md#L5-L84]

### 10. Entry/Exit Prompt Architecture

- **Entry**: `wave-explore-fast.prompt.md` with `agent: wave-orchestrator` frontmatter — thin routing shim, zero logic, passes `$ARGUMENTS` through
- **Exit**: Dual paths — `wave-return-to-agent.prompt.md` slash command AND orchestrator's `handoffs:` frontmatter declaring `agent: agent` with `send: true`
- **Orchestrator hub**: Declares 7 subagents, lifecycle hooks (`SubagentStart`, `Stop`), and handoff targets

`argument-hint` serves as both UX guidance and implicit API contract for parameter shape.
[via: aggregation-3.md#L62-L72 ← research-9.md#L11-L54]

### 11. Production Readiness Status

**Core engine (Phases 1–10): PRODUCTION-READY** — orchestrator loop, prompt builder, circuit breaker chain, multi-verifier, hook system, session persistence, agent mode routing, knowledge persistence. 24 source files, 29 test files, 470+ unit tests, ~80 completed tasks.

**Phase 11 (Wave Pipeline & Research Automation): UNBUILT** — all 12 remaining unchecked tasks. Key missing pieces:
- Context Grounder, Spec Generator, PRD Generator agents
- `--ralph-prd` mode itself
- Commit-sampling hook, codebase brief cache
- Configurable context source chain
- PRD write protection (Task 77)

Two stubs in production code: `DirectApiStrategy` throws "not implemented"; `runLlmVerification` returns skip.
[via: aggregation-4.md#L84-L107 ← research-12.md#L63-L140]

## Pattern Catalog

### P1: Annotation-in-Text DSL
Both PRD tasks and decompose output embed metadata as inline text annotations parsed by regex/string-splitting — no JSON/YAML for primary data structures. Maximizes hand-editability at the cost of fragile parsing.
[via: aggregation-1.md#L130-L134 ← research-1.md#L105-L108, research-3.md#L64-L66]

### P2: Read-Only Research Constraint
The entire wave system is read-only with respect to source code. The only code-modifying step (Phase 5 PRD append) is guarded by a human checkpoint.
[via: aggregation-1.md#L136-L139 ← research-2.md#L95-L96, research-3.md#L53-L55]

### P3: Stateless Agents with Orchestrator State
Individual agents are stateless — all state management (phase files, checkpoint replay, dependency tracking) lives in the orchestrator or PRD parser.
[via: aggregation-1.md#L141-L143 ← research-3.md#L75-L76, research-2.md#L82-L85, research-1.md#L91-L94]

### P4: Two-Step Commit (Raw → Review → Seal/Apply)
Both spec generation and PRD generation produce raw content first, then pause for human review, then seal/apply. Prevents premature commitment and enables user refinement.
[via: aggregation-1.md#L145-L147 ← research-2.md#L73-L85, research-1.md#L130-L131]

### P5: Hint/Pointer-Based Context Injection
`→ Spec:` pointers and decompose search hints use lightweight inline references. Agents read only the relevant window, not entire files — keeps prompts lean.
[via: aggregation-1.md#L149-L151 ← research-1.md#L115-L116, research-3.md#L68-L70]

### P6: Contract-by-Prompt Enforcement
Every inter-agent boundary relies on textual contracts (prompt directives with caps, bold, warnings) rather than programmatic validation. Pragmatic for LLM agents but creates fragility — contract drift appears as subtle quality degradation, not hard errors.
[via: aggregation-2.md#L83-L90 ← research-4.md#L94-L100, research-5.md#L27-L50, research-6.md#L80-L86]

### P7: Information Isolation as Quality Forcing Function
Master aggregator cannot read raw research; spec generator receives only FINAL-REPORT + ContextBrief. Barriers prevent synthesis bypass, trading potential information loss for guaranteed synthesis quality.
[via: aggregation-2.md#L92-L97 ← research-5.md#L45-L48, research-6.md#L16-L26]

### P8: Flat Dispatch Over Nested Dispatch
Orchestrator controls all agents directly — intermediary dispatch engines (`wave-research`, `wave-aggregate`) deprecated. Simplifies error handling, enables better parallelism.
[via: aggregation-2.md#L99-L103 ← research-4.md#L86-L92, research-5.md#L115-L120]

### P9: Token-Budgeted Information Compression
ContextBrief (≤2K tokens, ≤30 lines) and Tier 2 PRD entries (one sentence) enforce strict brevity, forcing downstream consumers to read source material rather than operating on summaries.
[via: aggregation-3.md#L75-L80 ← research-7.md#L25-L29, research-8.md#L59-L63]

### P10: Privilege Separation as Architecture Principle
Escalating privilege model (explore → research → executor) is reflected in both agent definitions and pipeline architecture. Wave agents write research only; Ralph executor is the sole code modifier. Enforced by tool allowlists.
[via: aggregation-4.md#L109-L113 ← research-10.md#L44-L58, research-12.md#L7-L49]

### P11: Atomic State Management
Both `CheckpointStore` and `SessionPersistence` use tmp+rename atomic writes. Project-wide convention for all recoverable state files.
[via: aggregation-4.md#L115-L117 ← research-11.md#L20-L22, research-11.md#L63-L68]

### P12: Seal-Last Discipline
Frontmatter sealing structurally enforced by separate pipeline phases (Phase 2 generation, Phase 3 sealing) with human checkpoint between them.
[via: aggregation-4.md#L123-L126 ← research-11.md#L117-L120, research-12.md#L95-L109]

## Priority Matrix

| Item | Impact | Effort | Priority | Sources |
|------|--------|--------|----------|---------|
| Phase 11 `--ralph-prd` pipeline implementation | Critical | Large (12 tasks) | **P0** | [via: aggregation-4.md ← research-10.md#L60-L84, research-11.md#L51-L61, research-12.md#L95-L109] |
| Fan-out/fan-in orchestration topology | Critical | High | **P0** | [via: aggregation-1.md ← research-2.md#L10-L42, research-3.md#L20-L55] |
| PRD task format & annotation DSL | Critical | Low (implemented) | **Done** | [via: aggregation-1.md ← research-1.md#L12-L53] |
| Full provenance traceability chain | Critical | Low (implemented) | **Done** | [via: aggregation-2.md ← research-4.md#L29-L35, research-5.md#L67-L90, research-6.md#L80-L86] |
| PRD write protection (Task 77) | High | Small | **P1** | [via: aggregation-4.md ← research-12.md#L109, research-12.md#L131] |
| ContextBrief with duplicate prevention | High | Medium | **P1** | [via: aggregation-3.md ← research-8.md#L5-L57] |
| Checkpoint-replay with state files | High | Medium | **P1** | [via: aggregation-1.md ← research-2.md#L82-L85] [via: aggregation-4.md ← research-11.md#L23-L68] |
| Spec pointer & frontmatter sealing | High | Medium | **P1** | [via: aggregation-1.md ← research-1.md#L55-L73, research-2.md#L73-L75] |
| Tier classification heuristic (Tier 1 vs 2) | High | Low | **P1** | [via: aggregation-3.md ← research-7.md#L13-L29] |
| Prompt-based contract hardening | High (fragility risk) | Medium (schema validation) | **P2** | [via: aggregation-2.md ← research-4.md#L94-L100, research-5.md#L27-L50] |
| Wave output indexing/discovery | Medium | Small | **P2** | [via: aggregation-4.md ← research-12.md#L51-L59] |
| 3-zone commit-sampling | Medium | Medium | **P2** | [via: aggregation-3.md ← research-8.md#L23-L45] |
| Human-in-the-loop review gates | Medium | Low (presentation) | **P2** | [via: aggregation-3.md ← research-7.md#L62-L63] |
| Confidence scoring via convergence | Medium | Low | **P2** | [via: aggregation-2.md ← research-5.md#L122-L133] |
| Entry/exit prompt architecture | Medium | Low (frontmatter routing) | **P2** | [via: aggregation-3.md ← research-9.md#L11-L33] |
| Integration/E2E test coverage | Medium | Large | **P3** | [via: aggregation-4.md ← research-12.md#L137] |
| DirectApiStrategy stub removal | Low | Medium | **P3** | [via: aggregation-4.md ← research-12.md#L135] |
| Agent sync mechanism automation | Low | Medium | **P3** | [via: aggregation-4.md ← research-10.md#L101-L102] |

## Recommended Plan

### Phase A: Foundation (prerequisites for all else)
1. **Implement `CheckpointStore`** with per-phase JSON state files, atomic writes, and go-back/replay API — required by all subsequent phases
   - Depends on: nothing (core engine complete)
2. **Implement `wave-context-grounder`** (Phase 0 agent) with 3-zone commit-sampling, ContextBrief output, and `.ralph/codebase-brief.md` cache
   - Depends on: (1) CheckpointStore for phase state persistence
3. **Add PRD write protection** (Task 77) — safety guard before any automated write path exists
   - Depends on: nothing

### Phase B: Research Pipeline
4. **Wire `--ralph-prd` mode** into orchestrator with 6-phase sequential dispatch and checkpoint pause/resume
   - Depends on: (1) CheckpointStore, (2) ContextBrief
5. **Validate existing Aggregate mode** works end-to-end with new checkpoint infrastructure
   - Depends on: (4)

### Phase C: Spec & PRD Generation
6. **Implement `wave-spec-generator`** with 4-stage transformation pipeline and auto-numbering fallback chain
   - Depends on: (4) `--ralph-prd` mode, (2) ContextBrief for input
7. **Implement frontmatter sealing** (Phase 3) with `SpecFrontmatter` type validation
   - Depends on: (6) spec generator output
8. **Implement `wave-prd-generator`** with Tier 1/2 classification, line-range indexing, and [Apply]/[Refine]/[Back]/[Stop] review gate
   - Depends on: (7) sealed specs

### Phase D: Hardening
9. **Add wave output indexing** — extend INDEX.md or create `_wave/INDEX.md` for discoverability
   - Depends on: nothing
10. **Add reference chain validation** — detect stale `→ Spec:` line-range pointers and `[source:]` references
    - Depends on: (8) PRD entries exist
11. **Harden prompt contracts** — add output schema validation for researcher report structure and aggregator reference format
    - Depends on: (5) working pipeline to test against

## Gaps & Further Research

1. **Error handling and partial failure recovery** — No report documents what happens when a subagent fails mid-pipeline. No retry, fallback, or partial-result handling logic is specified anywhere in the system.
   [via: aggregation-1.md#L177 ← research-2.md#L114-L115] [via: aggregation-2.md#L118-L119]

2. **Spec pointer staleness** — `→ Spec:` line ranges become invalid when spec files are edited. No automated validation or refresh mechanism exists.
   [via: aggregation-1.md#L179 ← research-1.md#L137-L138] [via: aggregation-3.md#L115]

3. **Cache invalidation for ContextBrief** — `.ralph/codebase-brief.md` cache exists but freshness heuristic is unspecified. Stale caches feed incorrect numbering or outdated "Completed" sections.
   [via: aggregation-3.md#L113 ← research-8.md]

4. **Checkpoint concurrency** — What happens if `goBack` is called while a phase is actively running? No locking or concurrency control documented.
   [via: aggregation-4.md#L137 ← research-11.md]

5. **Topic-level deduplication between parallel researchers** — ContextBrief prevents overlap with completed work, but parallel researchers may overlap with each other. `wave-parallel-lock.prompt.md` addresses file conflicts, not topic conflicts.
   [via: aggregation-3.md#L111 ← research-8.md]

6. **Quality gates between pipeline tiers** — Low-quality research can poison aggregation groups. No quality-gating mechanism exists between tiers.
   [via: aggregation-2.md#L121 ← research-5.md]

7. **User refinement flow at Checkpoint 2** — Can users add/delete/reorder tasks during spec review? How is re-numbering handled after edits?
   [via: aggregation-2.md#L122 ← research-6.md]

8. **Scale limits** — No empirical data on maximum practical N (researcher count) before context window, file system, or aggregation quality degrades.
   [via: aggregation-2.md#L123]

9. **Model version drift** — `ralph-executor` uses `Claude Opus 4.6 (fast mode) (Preview) (copilot)` while `explore`/`research` use `claude-opus-4-0-fast`. Intentional tiering vs. accidental drift is unresolved.
   [via: aggregation-4.md#L143 ← research-10.md]

10. **Phase number extraction gap** — `parsePrd()` detects phase headers but does NOT extract phase numbers, limiting phase-aware operations.
    [via: aggregation-1.md#L181 ← research-1.md#L135-L136]

11. **Hook system documentation** — Orchestrator hooks (`SubagentStart`, `Stop`) are mentioned but behavior is undocumented.
    [via: aggregation-1.md#L185 ← research-2.md#L108-L109]

12. **Integration/E2E testing** — 470+ unit tests but zero integration tests. No VS Code extension host test harness.
    [via: aggregation-4.md#L133 ← research-12.md#L137]

## Source Chain

| Aggregation Report | Research Files Consolidated |
|---|---|
| aggregation-1.md | research-1.md (PRD structure & task format), research-2.md (orchestrator modes & chaining), research-3.md (wave-decompose specification) |
| aggregation-2.md | research-4.md (researcher ↔ dispatch engine), research-5.md (group & master aggregation), research-6.md (spec-generator transformation) |
| aggregation-3.md | research-7.md (PRD generator tiers & output), research-8.md (context-grounder & commit-sampling), research-9.md (wave prompt files & entry/exit) |
| aggregation-4.md | research-10.md (agent definitions & privilege model), research-11.md (checkpoint-retry & frontmatter-sealing), research-12.md (file organization & production readiness) |
