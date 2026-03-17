# Research 11 — Checkpoint-Retry & Frontmatter-Sealing Patterns

## Question

How do the checkpoint-retry and frontmatter-sealing patterns work — what is the phase-state JSON schema, the go-back flow, and why is frontmatter always the last transformation?

## Findings

### 1. Checkpoint-Retry Pattern

**Source**: `docs/patterns/checkpoint-retry.md`, `src/checkpointRetry.ts`, `test/checkpointRetry.test.ts`

The checkpoint-retry pattern enables multi-phase pipelines (like `--ralph-prd`) to rewind to any prior phase when a user chooses "go back" at a human checkpoint. Each phase persists its state to a JSON file so the pipeline never needs to re-run from scratch.

#### Phase-State JSON Schema

Defined in `src/checkpointRetry.ts` as the `PhaseState` interface:

```typescript
interface PhaseState {
  waveId: string;                     // e.g. "2026-03-15-auth-patterns"
  phase: number;                      // 0-indexed phase number
  inputs: Record<string, unknown>;    // what the subagent received
  outputs: Record<string, unknown>;   // what the subagent produced
  userSteering: string | null;        // feedback from go-back; null on first run
  timestamp: number;                  // epoch ms, auto-set by savePhase()
}
```

Files are stored at `research/_wave/{WAVE_ID}/phase-{N}-state.json` and written atomically (write to `.tmp`, then `fs.renameSync`).

#### CheckpointStore API

The `CheckpointStore` class (constructor takes `workspaceRoot`) exposes five operations:

| Method | Signature | Purpose |
|--------|-----------|---------|
| `savePhase` | `(waveId, phase, state) → void` | Write phase state after subagent completes |
| `loadPhase` | `(waveId, phase) → PhaseState \| null` | Read a specific phase; returns null if missing/corrupt |
| `listPhases` | `(waveId) → number[]` | All saved phase numbers, sorted ascending |
| `goBack` | `(waveId, phase, feedback) → PhaseState \| null` | Rewind: load phase N, delete phases > N, set userSteering |
| `clearWave` | `(waveId) → void` | Remove entire wave directory |

#### Go-Back Flow (step by step)

1. User at Checkpoint N chooses **[Back]** and provides feedback (e.g., "Focus more on OAuth2")
2. `goBack(waveId, targetPhase, feedback)` is called
3. The target phase's `phase-{N}-state.json` is loaded
4. All state files for phases > N are **deleted** (`fs.unlinkSync`)
5. The target phase's file is rewritten with `userSteering` set to the user's feedback
6. The pipeline re-runs the target phase's subagent with:
   - Same `inputs` as the original run
   - `userSteering` text appended to the prompt

This ensures the subagent gets the same context but with additional human guidance, and all downstream phases are recomputed fresh.

#### Pipeline Phase Mapping (from docs)

```
Phase 0: Context Grounding   → saves { inputs: {workspace}, outputs: {contextBriefPath} }
Phase 1: Research Wave        → saves { inputs: {topic, n}, outputs: {finalReportPath} }
  Checkpoint 1: [Back] → goBack(waveId, 0, feedback)
Phase 2: Spec Generation      → saves { inputs: {reportPath}, outputs: {specPath} }
  Checkpoint 2: [Back] → goBack(waveId, 1, feedback)
Phase 3: Seal Spec            → saves phase 3 state
Phase 4: PRD Generation       → saves phase 4 state
  Checkpoint 3: [Back] → goBack(waveId, 2, feedback)
Phase 5: Finalize             → saves phase 5 state
```

#### Relationship to SessionPersistence

`CheckpointStore` generalizes the existing `sessionPersistence.ts` pattern:

- **SessionPersistence**: single file (`.ralph/session.json`), one state for entire loop, resume from last state only
- **CheckpointStore**: one file per phase (`phase-{N}-state.json`), rewind to any phase, per-pipeline scoping via waveId

Both share the atomic-write strategy (tmp + rename).

---

### 2. Frontmatter-Sealing Pattern

**Source**: `docs/patterns/frontmatter-sealing.md` (exists in both `ralph-loop/` and `vscode-config-files/`; content is identical)

#### Core Constraint

Frontmatter (`tasks`, `verification`, `completion_steps`, `principles`) must be the **last transformation** applied to spec files — after all research, synthesis, and user refinement is complete.

#### Why Frontmatter Must Be Last

Ralph's `buildPrompt()` reads frontmatter at runtime to drive agent execution. The functions `buildSpecContextLine()` and `extractSpecReference()` in `prompt.ts` extract frontmatter fields and inject them as context:

- `phase` → context grouping
- `principles` → design constraints in the prompt
- `verification` → commands the agent must run
- `research` → back-link to source research file

If frontmatter is applied before content is finalized, `buildPrompt()` emits instructions based on **stale or incomplete data**, causing agents to execute against partial specs. This produces low-quality output requiring rework.

#### Pipeline Sequence

```
Research → Spec (raw, no frontmatter) → User refines → Seal (apply frontmatter) → PRD entries with → Spec: pointers
```

1. **Research**: Fan-out exploration produces raw findings with `ResearchFrontmatter` (type, id, phase, date, sources, methodology, derived_specs, tags)
2. **Spec (unsealed)**: Synthesis transforms findings into task specs — no execution-critical frontmatter yet
3. **User refines**: Human adjusts scope, reorders tasks, adds constraints
4. **Seal**: Final frontmatter is written, "sealing" the spec as the execution source of truth
5. **PRD entries**: Reference sealed specs via `→ Spec: path LN-LN` syntax

#### SpecFrontmatter Type (from docs — not yet in types.ts)

```typescript
interface SpecFrontmatter {
  tasks: number[];         // task IDs covered by this spec
  verification: string[];  // commands agent must run (e.g., "npx tsc --noEmit")
  completion_steps: string[];  // post-task actions (update progress, commit)
  principles: string[];    // design constraints injected into prompts
}
```

**Note**: `SpecFrontmatter` is documented in pattern docs but not yet defined in `src/types.ts`. It's a planned type for the `--ralph-prd` pipeline.

#### → Spec: Pointer Mechanism

PRD task entries reference sealed specs:
```markdown
- [ ] **Task 57 — Context Budget Awareness**: ...
  → Spec: research/14-phase9-refined-tasks.md L42-L78
```

At runtime, `extractSpecReference()` parses the path + line range, and `buildSpecContextLine()` emits a context line like:
```
[Spec context: Phase 9 | principles: configurable, composable, chainable | verify: tsc --noEmit+vitest run | research: 13]
```

#### Anti-Pattern: Premature Sealing

Sealing too early causes incomplete task lists, missing principles, and missing verification commands in frontmatter. The agent then operates on partial context.

---

## Patterns

| Pattern | Core Mechanism | Data Flow |
|---------|---------------|-----------|
| Checkpoint-Retry | Per-phase JSON state files + go-back rewind | Write on complete → load on retry → delete downstream |
| Frontmatter-Sealing | Sequenced YAML frontmatter application | Research → unsealed spec → refine → seal → reference |
| Atomic Writes | tmp + rename for both patterns | Prevents corruption from interrupted writes |
| → Spec: Pointers | PRD entries link to sealed spec line ranges | `extractSpecReference()` → `buildSpecContextLine()` |

### How They Interact

These patterns are complementary within the `--ralph-prd` pipeline:

1. **Checkpoint-Retry** manages pipeline flow control (which phase to run, rewind capability)
2. **Frontmatter-Sealing** manages data integrity (when to commit execution metadata to specs)
3. Phase 3 ("Seal Spec") in the checkpoint flow is exactly where frontmatter sealing occurs — the pipeline explicitly separates spec generation (Phase 2) from sealing (Phase 3) to allow human refinement between them

---

## Applicability

- **Checkpoint-Retry** applies to any multi-phase pipeline with human-in-the-loop checkpoints where rewinding is needed. The `CheckpointStore` is generic — it works with any `Record<string, unknown>` inputs/outputs.
- **Frontmatter-Sealing** applies specifically to spec files consumed by `buildPrompt()`. Any file whose YAML frontmatter drives agent behavior must follow the seal-last discipline.
- Both patterns are essential for the `--ralph-prd` mode but could extend to other pipeline-style workflows.

---

## Open Questions

1. **SpecFrontmatter type location**: The type is documented in pattern docs but not yet in `src/types.ts`. Is this planned for implementation alongside the `--ralph-prd` pipeline?
2. **prompt.ts functions**: `buildSpecContextLine()` and `extractSpecReference()` are referenced in docs but not found in current `src/prompt.ts` via grep. Are these planned functions or do they exist under different names?
3. **ResearchFrontmatter type**: Similarly referenced in docs but not in `types.ts`. Where will these frontmatter-related types be defined?
4. **Partial go-back**: Can a user go back to phase N but keep phase N+1 outputs if they only want to adjust steering? Currently `goBack` always deletes all phases > N.
5. **Conflict resolution**: What happens if `goBack` is called while a phase is actively running? Is there a locking mechanism?
6. **Frontmatter validation**: Is there a planned schema validator that checks sealed frontmatter completeness before allowing the pipeline to proceed past the seal phase?
