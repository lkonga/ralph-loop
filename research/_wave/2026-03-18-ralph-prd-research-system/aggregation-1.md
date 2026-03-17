## Aggregation Report 1

### Source Reports

**research-1.md** — PRD.md Structure & Task Format
- PRD is a flat markdown DSL with `## Phase N` headers, checkbox tasks, and inline annotations
- Task format: `- [ ] **Task NN — Name**: Description → Spec: path LNN-LNN`
- Six annotation types: `[DECOMPOSED]`, `[CHECKPOINT]`, `[AGENT:name]`, `[NO_DIFF]`, `depends:`, `→ Spec:`
- Two-tier task IDs: human-readable (`Task 57 — Name`) and machine-assigned (`Task-001`)
- Spec pointers use YAML frontmatter sealing for context injection into prompts
- `pickReadyTasks()` resolves dependencies for DAG-based execution ordering

**research-2.md** — Wave-Orchestrator Modes & Chaining
- Four operational modes: Aggregate (default), Direct (`--direct`), Same (`--same`), Ralph PRD (`--ralph-prd`)
- Fan-out/fan-in topology: decompose → N researchers (parallel) → group-aggregators → master-aggregator
- Ralph PRD extends Aggregate with 6 phases and 3 human checkpoints using `phase-{N}-state.json`
- Mandatory parallel dispatch: all same-tier agents must use a single batch call
- Agent budget: `N + ceil(N/K) + 2` for Aggregate; ralph-prd adds context-grounder, spec-generator, prd-generator

**research-3.md** — Wave-Decompose Specification
- Input: `{N} {TOPIC}` → Output: N numbered questions with inline search hints
- Five decomposition rules: non-overlapping, independently answerable, search hints required, specific, overflow→cross-validation
- Read-only agent (`read`, `search` tools only), not user-invocable
- Stateless catalyst: no file writes, output flows through orchestrator dispatch
- N capped at 12 by orchestrator constraint

### Deduplicated Findings

#### 1. PRD Task DSL & Parsing Pipeline

The PRD is a self-contained flat-file DSL parsed by regex in `src/prd.ts`. Tasks follow strict format: `- [ ] **Task NN — Name**: Description` with optional inline annotations stripped during parsing. [source: research-1.md#L12-L30]

Six annotation types control orchestration behavior:
| Annotation | Effect |
|---|---|
| `[DECOMPOSED]` | Task skipped (non-actionable) |
| `[CHECKPOINT]` | Pause for human review |
| `[AGENT:name]` | Route to specific agent |
| `[NO_DIFF]` | Skip diff validation |
| `depends: task-id` | DAG ordering |
| `→ Spec: path LNN-LNN` | Link to spec file line range |

[source: research-1.md#L38-L53]

Phase-level `[AGENT:name]` on `### ` headers is inherited by all tasks in that subsection. [source: research-1.md#L51-L52]

#### 2. Spec Pointer & Frontmatter Sealing Contract

`→ Spec:` pointers link PRD tasks to line ranges in spec files. `extractSpecReference()` parses them via regex, `buildSpecContextLine()` reads the spec's YAML frontmatter and injects a one-liner context string into prompts. [source: research-1.md#L55-L73]

Spec files are written raw during research, then sealed with YAML frontmatter (`type: spec`, `tasks`, `phase`, `verification`, `principles`) only after human approval at Checkpoint 2. [source: research-2.md#L73-L75]

This two-step process (raw → sealed) prevents premature commitment to task structure. The SPEC REFERENCE GATE in prompts enforces that agents read the referenced spec before writing code. [source: research-1.md#L69-L73] [source: research-2.md#L92-L93]

#### 3. Wave-Orchestrator Fan-Out/Fan-In Architecture

The orchestrator dispatches subagents in a MapReduce-style pipeline with mandatory parallel batch dispatch at each tier: [source: research-2.md#L10-L30]

```
wave-decompose (1) → wave-researcher (N, parallel) → wave-group-aggregator (ceil(N/K), parallel) → wave-master-aggregator (1)
```

Total agent count for Aggregate mode: `N + ceil(N/K) + 2`. K defaults to 3, configurable via `--aggregate=K` (range 2–6). [source: research-2.md#L34-L42]

An intermediate `wave-research.agent.md` acts as a parallel dispatch engine between orchestrator and individual researchers. [source: research-2.md#L30-L32]

#### 4. Four Operational Modes

| Mode | Flag | Chain | Artifacts |
|------|------|-------|-----------|
| Aggregate | (default) | decompose → researchers → group-agg → master-agg | Full file tree |
| Direct | `--direct` | decompose → researchers (no file writes) → inline synthesis | None |
| Same | `--same` | N researchers with identical prompt → inline synthesis | None |
| Ralph PRD | `--ralph-prd` | 6 phases with 3 checkpoints, extends Aggregate | Full tree + specs + PRD entries |

[source: research-2.md#L35-L82]

Direct and Same modes are lightweight exploration tools; Aggregate and Ralph PRD produce persistent artifacts. [source: research-2.md#L44-L58]

#### 5. Ralph PRD 6-Phase Pipeline

| Phase | Agent | Output | Checkpoint |
|-------|-------|--------|------------|
| 0 | wave-context-grounder | context-brief.md (≤30 lines) | — |
| 1 | Full Aggregate flow | FINAL-REPORT.md | **CP1**: Review report |
| 2 | wave-spec-generator | Raw spec file (no frontmatter) | **CP2**: Review tasks |
| 3 | Orchestrator (inline) | Sealed spec (YAML frontmatter applied) | — |
| 4 | wave-prd-generator | PRD entries (Tier 1 inline / Tier 2 spec-ref) | **CP3**: Review PRD |
| 5 | Orchestrator (inline) | Appends to PRD.md, updates INDEX.md | — |

[source: research-2.md#L60-L80]

Checkpoint state files (`phase-{N}-state.json`) enable go-back, refine, and replay from any checkpoint. [source: research-2.md#L82-L85]

#### 6. Wave-Decompose: The Fan-Out Catalyst

Input: `{N} {TOPIC}` (first token = count, remainder = topic). Output: N numbered questions with inline backtick-formatted search hints. [source: research-3.md#L20-L30]

Five decomposition rules ensure quality: non-overlapping coverage, independent answerability, mandatory search hints, specificity over vagueness, overflow→cross-validation. [source: research-3.md#L33-L39]

The agent is stateless and read-only — it produces structured text consumed by the orchestrator's dispatch logic, never writing files. [source: research-3.md#L53-L55]

#### 7. Task Picking & Dependency Resolution

`pickReadyTasks(snapshot, maxTasks)` returns pending tasks whose `dependsOn` are all complete. Parallel safety: if any task in a batch uses a write agent, falls back to sequential (single task). [source: research-1.md#L91-L94]

`validatePrd(snapshot)` performs: non-empty check, duplicate detection, dangling reference warning, circular dependency DFS. [source: research-1.md#L97-L101]

#### 8. Progressive Disclosure Traceability

Every aggregation level preserves source references: `[source: research-{I}.md#L{start}-L{end}]` in group reports → `[via:]` chains in master report. This enables drill-down from final report to raw research without re-running. [source: research-2.md#L88-L90]

### Cross-Report Patterns

**P1: Annotation-in-Text DSL** (research-1 + research-3)
Both PRD tasks and decompose output use inline text annotations within markdown — no external schema, no JSON/YAML for the primary data structure. Metadata is embedded in human-readable text and parsed by regex/string-splitting. This pattern maximizes hand-editability at the cost of fragile parsing. [source: research-1.md#L105-L108] [source: research-3.md#L64-L66]

**P2: Read-Only Research Constraint** (research-2 + research-3)
The entire wave system — from decompose through aggregation — is read-only with respect to source code. Agents discover, analyze, and write reports but never edit implementation files. The only code-modifying step is Phase 5 of ralph-prd (PRD append), which is guarded by a human checkpoint. [source: research-2.md#L95-L96] [source: research-3.md#L53-L55]

**P3: Stateless Agents with Orchestrator State** (all three reports)
Individual agents (decompose, researcher, aggregator) are stateless — they process input and produce output without maintaining context. All state management (phase files, checkpoint replay, dependency tracking) lives in the orchestrator or PRD parser. [source: research-3.md#L75-L76] [source: research-2.md#L82-L85] [source: research-1.md#L91-L94]

**P4: Two-Step Commit Pattern** (research-1 + research-2)
Both spec generation and PRD generation follow a raw→review→seal/apply pattern: content is first generated without finalization, then reviewed by a human at a checkpoint, then sealed (frontmatter applied) or applied (PRD appended). This prevents premature commitment. [source: research-2.md#L73-L85] [source: research-1.md#L130-L131]

**P5: Hint/Pointer-Based Context Injection** (research-1 + research-3)
Both `→ Spec:` pointers (PRD→spec files) and decompose search hints (questions→file paths) use lightweight inline references to point agents at relevant context without loading it upfront. This keeps prompts lean while ensuring agents can find what they need. [source: research-1.md#L115-L116] [source: research-3.md#L68-L70]

### Priority Matrix

| Pattern | Impact | Effort | Sources |
|---------|--------|--------|---------|
| PRD task format & annotation DSL | Critical — foundation for all task operations | Low — already implemented in `src/prd.ts` | [research-1.md#L12-L53](research-1.md#L12-L53) |
| Fan-out/fan-in orchestration topology | Critical — core architecture for research pipeline | High — requires subagent dispatch infrastructure | [research-2.md#L10-L42](research-2.md#L10-L42), [research-3.md#L20-L55](research-3.md#L20-L55) |
| Ralph PRD 6-phase pipeline | Critical — target workflow for ralph-loop | High — 6 phases, 3 checkpoints, state files | [research-2.md#L60-L85](research-2.md#L60-L85) |
| Checkpoint-replay with state files | High — enables human-in-the-loop steering | Medium — JSON state per phase | [research-2.md#L82-L85](research-2.md#L82-L85) |
| Spec pointer & frontmatter sealing | High — connects PRD tasks to deep specifications | Medium — parsing + YAML manipulation | [research-1.md#L55-L73](research-1.md#L55-L73), [research-2.md#L73-L75](research-2.md#L73-L75) |
| Wave-decompose question generation | High — quality determines downstream research quality | Low — single stateless agent | [research-3.md#L20-L55](research-3.md#L20-L55) |
| Mandatory parallel dispatch | Medium — throughput optimization | Low — dispatch constraint, not new code | [research-2.md#L33-L34](research-2.md#L33-L34) |
| Progressive disclosure traceability | Medium — auditability and drill-down | Low — reference format convention | [research-2.md#L88-L90](research-2.md#L88-L90) |

### Gaps

1. **Error handling in pipeline**: None of the three reports document what happens when a subagent fails mid-pipeline (e.g., researcher times out, decompose produces malformed output). No retry or fallback logic is specified. [source: research-2.md#L114-L115]
2. **Spec pointer staleness**: `→ Spec:` line ranges become invalid when spec files are edited. No automated validation exists to detect or repair stale pointers. [source: research-1.md#L137-L138]
3. **Phase number extraction gap**: `parsePrd()` detects phase headers but does NOT extract phase numbers. This metadata gap could affect phase-aware operations. [source: research-1.md#L135-L136]
4. **Context-grounder implementation status**: Phase 0's pre-computed cache at `.ralph/codebase-brief.md` is referenced but may not yet be implemented. [source: research-2.md#L111-L112]
5. **Decompose quality assurance**: No empirical data on overlap rates or hint accuracy across different topic types. Quality is entirely dependent on LLM judgment without validation. [source: research-3.md#L80-L84]
6. **wave-research dispatch engine role**: Unclear whether the intermediate `wave-research.agent.md` is always used or if the orchestrator sometimes dispatches researchers directly. [source: research-2.md#L106-L107]
7. **Hook system effects**: Orchestrator hooks (`SubagentStart`, `Stop`) are mentioned but their behavior is not documented in any of the three reports. [source: research-2.md#L108-L109]

### Sources
- research-1.md — PRD.md structure, task format, annotations DSL, spec pointers, parsing pipeline, task picking logic
- research-2.md — Wave-orchestrator four operational modes, fan-out/fan-in chaining, ralph-prd 6-phase pipeline, checkpoint-replay pattern
- research-3.md — Wave-decompose agent specification, input/output protocol, decomposition rules, search hints
