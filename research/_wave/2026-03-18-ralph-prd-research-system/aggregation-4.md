## Aggregation Report 4

### Source Reports

**research-10.md** — Ralph-Loop Agent Definitions & Wave Agent Relationship
- 3 ralph agents (executor/explore/research) with escalating privilege hierarchy [source: research-10.md#L5-L42]
- 9 wave agents forming parallel research orchestration pipeline [source: research-10.md#L60-L74]
- Tool restriction matrix: executor has full write/execute, explore is read-only, research adds web access [source: research-10.md#L44-L58]
- Canonical agent definitions live in vscode-config-files, copied to project repos [source: research-10.md#L59]
- Wave and Ralph are complementary: Wave = research pipeline, Ralph = implementation pipeline [source: research-10.md#L76-L84]

**research-11.md** — Checkpoint-Retry & Frontmatter-Sealing Patterns
- `CheckpointStore` manages per-phase JSON state files with 5 API methods (savePhase, loadPhase, listPhases, goBack, clearWave) [source: research-11.md#L23-L36]
- Go-back flow: load target phase, delete downstream states, inject userSteering feedback, re-run [source: research-11.md#L38-L49]
- 6-phase pipeline: Context Grounding → Research Wave → Spec Generation → Seal Spec → PRD Generation → Finalize [source: research-11.md#L51-L61]
- Frontmatter sealing must be the LAST transformation — premature sealing causes buildPrompt() to emit stale instructions [source: research-11.md#L72-L87]
- `→ Spec:` pointer mechanism links PRD tasks to sealed spec line ranges [source: research-11.md#L99-L110]

**research-12.md** — File Organization & Production Readiness Assessment
- 18 wave directories spanning 2026-03-15 to 2026-03-17; 14 completed full pipeline, 4 research-only [source: research-12.md#L7-L49]
- INDEX.md tracks only root research files (01–14), zero coverage of _wave/ outputs [source: research-12.md#L51-L59]
- 24 source files, 29 test files, ~80 completed tasks across Phases 1–10 [source: research-12.md#L63-L93]
- 12 unchecked tasks remain, all but one in Phase 11 (Wave Pipeline & Research Automation) [source: research-12.md#L95-L109]
- Core engine production-ready (orchestrator, circuit breaker, hooks, session persistence); pipeline automation layer entirely unbuilt [source: research-12.md#L113-L140]

### Deduplicated Findings

#### Agent Architecture & Privilege Model
Ralph uses an escalating privilege model with three tiers: explore (read-only codebase) → research (read + web) → executor (full write/execute/terminal). Each subagent uses explicit allow-lists AND deny-lists for belt-and-suspenders safety. Only the executor owns task state (`manage_todo_list`) and dispatches subagents. [source: research-10.md#L5-L58]

Wave agents form a separate parallel research pipeline with 9 specialized agents following a fan-out/fan-in (MapReduce) pattern: decompose → N parallel researchers → K group aggregators → 1 master aggregator → spec generator → PRD generator. Wave agents never edit source code — they only write to `research/_wave/`. [source: research-10.md#L60-L84]

The `--ralph-prd` flag bridges the two systems: Wave produces PRD entries that Ralph executor then implements. [source: research-10.md#L80-L82]

#### Checkpoint-Retry System
Multi-phase pipelines persist per-phase state to `phase-{N}-state.json` using atomic writes (tmp + rename). The `PhaseState` schema captures waveId, phase number, inputs/outputs as `Record<string, unknown>`, optional userSteering feedback, and timestamp. [source: research-11.md#L13-L22]

Go-back rewind works by: (1) loading target phase state, (2) deleting all downstream phase files, (3) injecting user feedback as `userSteering`, (4) re-running the target phase with original inputs + new steering. This generalizes the existing `sessionPersistence.ts` single-file pattern into multi-phase, per-pipeline scoping. [source: research-11.md#L38-L68]

#### Frontmatter-Sealing Discipline
Spec files remain as raw markdown through research and user refinement. Frontmatter (tasks, verification, completion_steps, principles) is applied LAST because `buildPrompt()` reads it at runtime via `buildSpecContextLine()` and `extractSpecReference()`. Premature sealing causes agents to execute against incomplete context. [source: research-11.md#L72-L113]

The pipeline explicitly separates spec generation (Phase 2) from sealing (Phase 3), with a human checkpoint between them for refinement. [source: research-11.md#L117-L120]

#### File Organization & Wave Outputs
Wave directories follow consistent `YYYY-MM-DD-{slug}/` naming with `research-{N}.md` + optional `aggregation-{N}.md` + optional `FINAL-REPORT.md`. Of 18 wave runs, 14 completed the full pipeline. One is empty (`robustness-audit`), four are research-only (no aggregation). [source: research-12.md#L7-L49]

INDEX.md only catalogs the 14 numbered root research files — the entire `_wave/` directory is invisible to the tracking system. This creates a discoverability gap for wave research outputs. [source: research-12.md#L51-L59]

#### Implementation Status & Production Readiness
The core engine (Phases 1–10) is production-ready: orchestrator loop, prompt builder, circuit breaker chain, multi-verifier, hook system, session persistence, agent mode routing, and knowledge persistence are all implemented with 470+ unit tests. [source: research-12.md#L113-L127]

The remaining 12 unchecked tasks are concentrated in Phase 11 (Wave Pipeline & Research Automation), which covers the `--ralph-prd` end-to-end pipeline. Key missing pieces: Context Grounder/Spec Generator/PRD Generator agents, the `--ralph-prd` mode itself, commit-sampling hook, codebase brief cache, and configurable context source chain. [source: research-12.md#L95-L109]

Two stubs exist in production code: `DirectApiStrategy` throws "not implemented" and `runLlmVerification` returns skip. [source: research-12.md#L135-L136]

### Cross-Report Patterns

**1. Privilege Separation as Architecture Principle** (research-10 + research-12)
The escalating privilege model (explore → research → executor) is reflected both in agent definitions AND in the pipeline architecture: wave agents can only write research outputs, ralph executor is the sole code modifier. This same principle extends to task state ownership — only orchestrator/executor manages todos. Confidence: HIGH — documented in agent YAML, enforced by tool allowlists, and validated by the absence of source code modifications in wave output directories. [source: research-10.md#L44-L58] [source: research-12.md#L7-L49]

**2. Atomic State Management Across All Persistence** (research-11 + research-12)
Both `CheckpointStore` (per-phase state) and `SessionPersistence` (crash recovery) use the same tmp+rename atomic write pattern. This is a project-wide convention for any file that represents recoverable state. [source: research-11.md#L20-L22] [source: research-11.md#L63-L68] [source: research-12.md#L83]

**3. Phase 11 as the Critical Frontier** (research-10 + research-11 + research-12)
All three reports converge on Phase 11 as the current development boundary. Research-10 documents the wave agent architecture that Phase 11 will implement. Research-11 details the checkpoint-retry and frontmatter-sealing patterns that Phase 11 tasks depend on. Research-12 confirms all 12 remaining unchecked tasks are Phase 11 items. The core engine is complete — the pipeline automation layer connecting wave research to PRD-driven implementation is what remains. [source: research-10.md#L60-L84] [source: research-11.md#L51-L61] [source: research-12.md#L95-L140]

**4. Seal-Last Discipline Enforced by Architecture** (research-11 + research-12)
The frontmatter-sealing pattern isn't just a convention — it's structurally enforced by the checkpoint pipeline having separate phases for spec generation (Phase 2) and sealing (Phase 3) with a human checkpoint between them. This architectural separation prevents premature sealing. [source: research-11.md#L117-L120] [source: research-12.md#L95-L109]

**5. Two-Tier Research with Tracking Gap** (research-10 + research-12)
Root research files (01–14) are indexed by INDEX.md; wave research outputs are completely untracked. Wave agents produce structured research following consistent naming patterns, but their outputs are invisible to the project's documentation system. This creates a discoverability problem as wave research accumulates. [source: research-10.md#L76-L84] [source: research-12.md#L51-L59]

### Priority Matrix

| Pattern | Impact | Effort | Sources (with line refs) |
|---|---|---|---|
| Phase 11 `--ralph-prd` pipeline implementation | Critical — bridges wave research to code implementation | L — 12 tasks spanning agents, prompts, context tools | [research-10.md#L60-L84](research-10.md#L60-L84), [research-11.md#L51-L61](research-11.md#L51-L61), [research-12.md#L95-L109](research-12.md#L95-L109) |
| PRD write protection (Task 77) | High — safety gap, prevents agent from modifying acceptance criteria | S — single validation guard | [research-12.md#L109](research-12.md#L109), [research-12.md#L131](research-12.md#L131) |
| Wave output indexing/discovery | Medium — growing discoverability gap with 18+ wave runs | S — INDEX.md section or separate `_wave/INDEX.md` | [research-12.md#L51-L59](research-12.md#L51-L59) |
| SpecFrontmatter type in types.ts | Medium — documented type not yet in code | S — type definition + validation | [research-11.md#L89-L97](research-11.md#L89-L97) |
| Agent sync mechanism (vscode-config-files → project repos) | Low — works via manual copy currently | M — automate with symlink or script | [research-10.md#L101-L102](research-10.md#L101-L102) |
| DirectApiStrategy stub removal/implementation | Low — CopilotCommandStrategy is sufficient for now | M — full Copilot API bridge | [research-12.md#L135](research-12.md#L135) |
| Integration/E2E test coverage | Medium — 470+ unit tests but zero integration tests | L — VS Code extension host test harness | [research-12.md#L137](research-12.md#L137) |

### Gaps

1. **Agent synchronization mechanism** — Research-10 confirms agent files are byte-identical copies across repos but doesn't explain HOW synchronization happens (manual copy? symlink? script?). No report investigates the `init-skills` or deployment pipeline mentioned in AGENTS.md.

2. **Checkpoint locking** — Research-11 raises but doesn't answer: what happens if `goBack` is called while a phase is actively running? No concurrency control mechanism is documented.

3. **Planned vs. existing functions** — Research-11 references `buildSpecContextLine()` and `extractSpecReference()` in `prompt.ts`, but these may be planned rather than implemented. Research-12 doesn't confirm their presence in the 24 source files inventory.

4. **Test stub vs. implementation status** — Research-12 notes test files exist for Phase 11 features (codebaseBriefCache, commitSamplingHook, contextSourceChain) but doesn't clarify whether these are TDD-style failing stubs awaiting implementation or tests against partial code. Source file listing shows corresponding `.ts` files exist in `src/`, suggesting at minimum skeleton implementations.

5. **Wave run cleanup policy** — No report addresses whether empty/incomplete wave directories should be cleaned up, archived, or left in place. The empty `robustness-audit` directory and 4 research-only runs lack any lifecycle management.

6. **Model version drift** — Research-10 flags that ralph-executor uses `Claude Opus 4.6 (fast mode) (Preview) (copilot)` while explore/research use `claude-opus-4-0-fast`. Whether this is intentional capability tiering or accidental drift is unresolved.

### Sources
- research-10.md (Ralph-Loop Agent Definitions & Wave Agent Relationship)
- research-11.md (Checkpoint-Retry & Frontmatter-Sealing Patterns)
- research-12.md (Wave File Organization, INDEX.md Tracking, and Production Readiness Assessment)
