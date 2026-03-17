# Research Report: wave-spec-generator Transformation & Auto-Numbering Logic

## Question

How does wave-spec-generator transform a FINAL-REPORT + ContextBrief into raw (unsealed) task specifications, and what auto-numbering logic does it use?

## Sources Analyzed

- [wave-spec-generator.agent.md](../../agents/wave-spec-generator.agent.md) (vscode-config-files) — full agent definition
- [14-phase9-refined-tasks.md](../14-phase9-refined-tasks.md) — example spec output (sealed version)
- [13-phase9-deep-research.md](../13-phase9-deep-research.md) — example FINAL-REPORT input
- [wave-orchestrator.agent.md](../../agents/wave-orchestrator.agent.md) — dispatch context (Phase 2 of `--ralph-prd`)
- [frontmatter-sealing.md](../../docs/patterns/frontmatter-sealing.md) — sealing pattern documentation
- [wave-context-grounder.agent.md](../../agents/wave-context-grounder.agent.md) — ContextBrief numbering source
- [PRD.md](../../PRD.md) (vscode-config-files) — Task 26 definition

---

## Findings

### 1. Inputs

wave-spec-generator receives exactly two inputs, injected by wave-orchestrator during Phase 2 of the `--ralph-prd` pipeline:

| Input | Source | Content |
|-------|--------|---------|
| **FINAL-REPORT.md** | `research/_wave/{WAVE_ID}/FINAL-REPORT.md` | Consolidated research from fan-out + synthesis waves. Contains pattern categories, priority matrix, gap analysis, recommendations. |
| **ContextBrief** | `research/_wave/{WAVE_ID}/context-brief.md` | Output from wave-context-grounder. Contains project state, naming conventions, architecture, current numbering (≤30 lines, ≤2K tokens). |

### 2. Auto-Numbering Logic (Step 1)

The agent determines three numbers before generating any specs:

| Number | Detection Method | Formula |
|--------|-----------------|---------|
| **Next phase number** | Scan `PRD.md` for all `## Phase N` headers | `max(N) + 1` |
| **Next task number** | Scan `PRD.md` for all `- [ ] **Task NN` and `- [x] **Task NN` patterns | `max(NN) + 1` |
| **Next research file number** | List `research/` directory, match filenames `NN-*.md` | `max(NN) + 1` |

**Shortcut**: If the ContextBrief (from wave-context-grounder) already provides these numbers in its "Numbering" section, the agent uses those directly without re-scanning. The context-grounder extracts `Phase/task numbering: Current highest phase number (## Phase N) and task number (Task NN)` from PRD.md during its Phase 0 grounding step.

### 3. Transformation Pipeline (Step 2)

The FINAL-REPORT findings are processed through a 4-stage pipeline:

1. **Filter** — Drop patterns rated Low impact OR already covered by the ContextBrief's "Completed" / "Do NOT Research" sections. This prevents duplicate work.

2. **Order** — Dependency-aware sequencing: foundational types first, features second, integration last. This ensures tasks can be implemented without circular dependencies.

3. **Group** — Cluster related tasks into sub-phases (target 3-4 tasks per sub-phase). Sub-phases are numbered as `{P}.1`, `{P}.2`, etc.

4. **Specify** — Each task receives a full specification block with:
   - `### Task {TN} — {Title}` (TN starts at next task number, increments contiguously)
   - **Goal**: One-sentence intent
   - **Design**: Key interfaces/types, config fields with defaults, integration points
   - **Tests (write FIRST)**: Test cases including edge cases and error scenarios
   - **Files**: Target source and test files
   - **Dependencies**: Task numbers this depends on

### 4. Output Format (Step 3)

The output file is written to `research/{NN}-phase{P}-deep-research.md` where:
- `{NN}` = next research file number
- `{P}` = next phase number

The file is **raw markdown with NO YAML frontmatter**. This is critical — frontmatter sealing is a separate downstream step (Phase 3 in the orchestrator pipeline), applied only after user review and refinement at Checkpoint 2.

Output structure:
```
# Phase {P} — Spec: {Research Objective}
> Generated from FINAL-REPORT.md by wave-spec-generator
> {count} tasks across {sub-phase count} sub-phases

## Summary
## Sub-Phase {P}.1 — {Name}
### Task {TN} — {Title} (full spec block)
### Task {TN+1} — {Title}
## Sub-Phase {P}.2 — {Name}
...
## Dependency Graph
## Line Range Index (task-to-line mapping for PRD → Spec: references)
```

### 5. Constraints

- Every task MUST have at least one test case in "Tests (write FIRST)"
- Task numbers MUST be contiguous from detected next task number
- No features invented beyond what FINAL-REPORT.md contains
- Each task = one clear deliverable
- Line Range Index enables `→ Spec: path LN-LN` references in PRD entries after sealing

---

## Patterns

### Pattern 1: Two-Phase Numbering (Grounding + Detection)
Numbering uses a fallback chain: ContextBrief cache → PRD.md scan → research/ directory listing. This avoids redundant file scanning when the context-grounder has already done the work.

### Pattern 2: Unsealed → Sealed Pipeline Split
The spec generator ONLY produces raw content. Frontmatter sealing is deliberately deferred to a separate phase (Phase 3 in orchestrator) so the user can review/refine at Checkpoint 2 before the spec becomes "executable." This follows the `Research → Spec (raw) → User refines → Seal → PRD entries` pipeline documented in `frontmatter-sealing.md`.

### Pattern 3: Dependency-Aware Ordering
Task sequencing follows `foundational types → features → integration`, mirroring how ralph-loop processes tasks (it reads `dependsOn` fields and picks tasks whose dependencies are met).

### Pattern 4: Sub-Phase Clustering
Tasks are grouped 3-4 per sub-phase with `{P}.{S}` numbering (e.g., 9.1, 9.2). This maps to how PRD phases are structured and how ralph-loop reads them.

### Pattern 5: Line Range Index for PRD Binding
The output includes a task-to-line-range table specifically to support `→ Spec: path LN-LN` syntax in PRD entries. This is how `extractSpecReference()` in `prompt.ts` resolves spec context at runtime.

---

## Applicability

### For ralph-loop PRD Research System
wave-spec-generator is the bridge between research output and implementable engineering tasks. In the `--ralph-prd` pipeline, it sits at Phase 2 (after research, before sealing) and is the only agent that transforms unstructured research into structured specs.

### Real Example
Research file `13-phase9-deep-research.md` (with `type: research` frontmatter, sources, methodology) was the FINAL-REPORT input. wave-spec-generator (or its predecessor) produced `14-phase9-refined-tasks.md` containing Tasks 57-68 across sub-phases 9a and 9b. After sealing, the frontmatter lists `tasks: [57, 58, 59, 60, 61, 62, 63, 64, 65, 66, 67, 68]` with verification commands and principles.

### Integration Points
- **Upstream**: wave-orchestrator dispatches it with file paths; wave-context-grounder provides numbering cache
- **Downstream**: Phase 3 seals with frontmatter; wave-prd-generator reads sealed spec to produce PRD entries

---

## Open Questions

1. **Naming ambiguity**: The output file is named `research/{NN}-phase{P}-deep-research.md` but it's actually a spec file, not a research file. The sealed version gets `type: spec` frontmatter. Should the naming convention distinguish spec outputs from research outputs at the filename level?

2. **ContextBrief numbering completeness**: The context-grounder extracts "current highest phase/task number" but the spec-generator also needs the next research file number. Does the context-grounder always include research file numbering, or is the `research/` directory scan always needed as a fallback?

3. **Sub-phase granularity**: The "3-4 tasks per sub-phase" guideline is soft. Is there a mechanism for the user to control clustering granularity (e.g., "make each task its own sub-phase" or "one large sub-phase")?

4. **Contiguous task number assumption**: The agent requires contiguous task numbers. If a user deletes tasks during Checkpoint 2 refinement, the gap would break contiguity. Is re-numbering handled during sealing, or is the user responsible?
