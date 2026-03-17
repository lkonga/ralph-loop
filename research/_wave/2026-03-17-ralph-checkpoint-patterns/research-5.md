# Research Report: Split PRDs vs Inline Checkpoints

**Wave**: 2026-03-17-ralph-checkpoint-patterns
**Report**: #5
**Question**: Could splitting into two PRDs (automated vs human-review phases) be better than inline checkpoints?

---

## Findings

### 1. PRD Loading Is Single-File, Session-Scoped

Ralph-loop binds to **one PRD per session**. The binding chain:

- `RalphConfig.prdPath` (default: `'PRD.md'`) is set at construction via `loadConfig()` reading `ralph-loop.prdPath` from VS Code settings (`src/orchestrator.ts:1162-1210`).
- `LoopOrchestrator` resolves this once in `runLoop()` with `resolvePrdPath(this.config.workspaceRoot, this.config.prdPath)` and uses that path for the entire session (`src/orchestrator.ts:393`).
- The PRD is re-read from disk on **every iteration** via `readPrdSnapshot(prdPath)` — so file content is live — but the **path** never changes mid-session.

There is an `updateConfig(config: Partial<RalphConfig>)` method that could theoretically accept a new `prdPath`, but it's only used for `promptBlocks` updates during the struggle-detection guidance flow. No code path calls `updateConfig({ prdPath: ... })`, and changing `prdPath` mid-loop would **not** reset the file watcher, session persistence, progress file, or the `completedTasks` set — leading to inconsistent state.

**Verdict**: Switching PRDs mid-session is not supported. A new session (stop + restart) is required.

### 2. Current Phase Structure in PRD.md

The existing `PRD.md` uses markdown headings as phase boundaries:

```markdown
## Phase 2 — Autopilot Patterns
### Nudge System (highest impact)
- [x] **Nudge on premature stop**: ...
### Retry System
- [x] **Auto-retry with error classification**: ...

## Phase 3 — Extended Autopilot Patterns
### Graceful Yield / External Stop Request
- [x] **External yield request**: ...
```

However, `parsePrd()` in `src/prd.ts` **ignores phase headings entirely**. It scans for checkbox lines (`- [ ]` / `- [x]`) and treats the full file as a flat task list. Indentation creates implicit dependencies (child depends on parent), and explicit `depends: ...` annotations are supported. But there is **no phase-aware scheduling** — `pickNextTask()` just finds the first pending task in file order; `pickReadyTasks()` finds any pending task whose dependencies are met.

The `ConsistencyCheckInput` interface has an `expectedPhase` field (`src/types.ts:413`), and `ResearchFrontmatter`/`SpecFrontmatter` types include `phase` numbers (`src/types.ts:641,652`), but these are metadata for the research/spec document system — not connected to task scheduling.

### 3. Dependency Annotations Work Within a Single PRD

`parseDependsOn()` extracts `depends: task-name-1, task-name-2` from task descriptions. `pickReadyTasks()` checks that all named dependencies are in the `completedDescriptions` set before making a task available. This works across phases within a single PRD since the entire file is parsed as one flat list.

Cross-PRD dependencies would require a new mechanism — neither the parser nor the scheduler has any concept of external references.

### 4. The HumanCheckpointRequested Event Is Already an Inline Checkpoint

The orchestrator emits `HumanCheckpointRequested` in two scenarios:
- **Stagnation Tier 3** (`src/orchestrator.ts:750`): After `threshold + 2` stale iterations with no file changes.
- **Diff validation exhaustion** (`src/orchestrator.ts:853`): After `maxDiffValidationRetries` failed attempts to detect code changes.

When emitted, the loop **pauses** (`this.pauseRequested = true`) and spins in a 1-second poll waiting for `resume()`. This is an implicit inline checkpoint — the human must intervene before the loop continues.

However, there is **no proactive/declarative checkpoint** — you cannot annotate a task with `[CHECKPOINT]` to force a pause before it executes. Checkpoints only fire reactively on failure.

### 5. Split PRDs: Workflow Analysis

**Two-PRD workflow**:
```
1. User writes PRD-safe.md (scaffold, tests, non-destructive)
2. ralph runs PRD-safe.md → completes all tasks
3. User reviews output, validates state
4. User writes/enables PRD-destructive.md (migrations, deploys, irreversible ops)
5. ralph runs PRD-destructive.md
```

**Advantages**:
- Hard isolation: destructive tasks literally cannot execute until the user starts a new session
- Clean git history: PRD-safe commit boundary is explicit
- Different config per phase: PRD-destructive could use stricter `maxNudgesPerTask: 1`, `hookScript` for deploy gates, etc.
- No parser changes needed: works with today's code

**Disadvantages**:
- **Lost dependency graph**: Cross-PRD dependencies require manual tracking. The "deploy" task in PRD-2 can't express `depends: build-assets` from PRD-1 — the user must verify this informally.
- **Duplicated context preamble**: Each PRD session starts cold. The agent loses `progress.txt` continuity (new progress file or appending to the same one — ambiguous).
- **UX ceremony**: Stop loop → change VS Code setting or `--prd` arg → restart → wait for warm-up. For a 3-phase project, this is 2 stop/restart cycles.
- **State fragmentation**: `completedTasks` set, circuit breaker state, stagnation detector, knowledge manager all reset between sessions.

### 6. Single PRD with Checkpoint Annotations: Design Sketch

A declarative approach within one PRD:

```markdown
## Phase 1 — Safe Tasks
- [ ] Create data models
- [ ] Write unit tests

<!-- CHECKPOINT: review-before-destructive -->

## Phase 2 — Destructive Tasks
- [ ] Run database migration
- [ ] Deploy to staging
```

**Implementation**: `parsePrd()` would detect `<!-- CHECKPOINT: name -->` markers. When the scheduler exhausts all tasks before a checkpoint, it emits `HumanCheckpointRequested` with the checkpoint name and pauses. The user reviews, then calls `resume()` to continue into the next phase.

**Advantages**:
- Single dependency graph: tasks in Phase 2 can `depends: create-data-models` from Phase 1
- Continuous `progress.txt`, knowledge, and state
- No config changes or session restart needed
- Minimal UX friction: loop pauses naturally at the boundary

**Disadvantages**:
- Requires parser changes (modest: detect HTML comment markers)
- Less config isolation: can't easily change `maxNudgesPerTask` per phase (would need phase-scoped config, which is more complex)
- The agent can still "see" destructive tasks in the PRD content (even if not scheduled yet) — could influence its behavior

---

## Patterns

### Pattern 1: Checkpoint-Annotated Single PRD (Recommended)

**When to use**: Most projects. The natural choice when phases share dependencies and the pause point is "review my work before proceeding."

**Implementation cost**: Low. Add marker detection to `parsePrd()`, emit `HumanCheckpointRequested` at boundary, reuse existing pause/resume machinery.

```
parsePrd() → tasks + checkpoints[] → scheduler runs to checkpoint → pause → user resume → continue
```

### Pattern 2: Split PRDs with Shared Progress

**When to use**: When phases need fundamentally different configs (e.g., Phase 1 uses `model: claude-sonnet`, Phase 2 uses `model: claude-opus` with stricter settings).

**Implementation**: No code changes — use existing `--prd` CLI arg or VS Code setting. Share `progress.txt` across runs for continuity.

### Pattern 3: Hybrid — Phase-Scoped Config Overrides in PRD

**When to use**: Projects needing both dependency continuity AND per-phase config.

```markdown
<!-- CHECKPOINT: pre-deploy | config: {"maxNudgesPerTask": 1, "hookScript": "deploy-gate.sh"} -->
```

**Implementation cost**: Medium. Checkpoint markers carry config JSON that gets merged into `RalphConfig` via `updateConfig()` when the checkpoint is passed.

---

## Applicability

| Criterion | Split PRDs | Inline Checkpoints | Hybrid |
|-----------|-----------|-------------------|--------|
| **Dependency continuity** | ❌ Lost | ✅ Preserved | ✅ Preserved |
| **State continuity** | ❌ Reset | ✅ Preserved | ✅ Preserved |
| **Config isolation** | ✅ Full | ❌ Shared | ✅ Per-phase |
| **UX friction** | High (stop/restart) | Low (auto-pause) | Low (auto-pause) |
| **Implementation cost** | Zero | Low | Medium |
| **Git boundary clarity** | ✅ Natural | ⚠️ Manual | ⚠️ Manual |
| **Works today** | ✅ Yes | ❌ Needs parser change | ❌ Needs parser + config merge |

**For ralph-loop specifically**: Inline checkpoints are the better default because:
1. The existing `HumanCheckpointRequested` + pause/resume machinery already handles the control flow
2. `parsePrd()` is ~90 lines of simple regex — adding checkpoint detection is trivial
3. The dependency graph is one of ralph-loop's strongest features and would be lost with split PRDs
4. `progress.txt` + knowledge manager accumulation across the full session is valuable

Split PRDs remain useful as an **escape hatch** for users who need strict isolation (different AI models per phase, different hook scripts, etc.) — but this already works without code changes.

---

## Open Questions

1. **Checkpoint syntax**: Should checkpoints use HTML comments (`<!-- CHECKPOINT: name -->`), fenced code blocks, or a special checkbox like `- [GATE] Review before deployment`? HTML comments are invisible in rendered markdown but discoverable by parsers.

2. **Auto-commit at checkpoints**: Should the orchestrator automatically run `atomicCommit()` when pausing at a checkpoint? This would give clean git boundaries without requiring split PRDs.

3. **Checkpoint conditions**: Should checkpoints support guards like `<!-- CHECKPOINT: pre-deploy IF remaining-in-phase-1 == 0 -->`? Or is "all preceding tasks complete" always the right trigger?

4. **Phase-scoped config**: If the hybrid pattern is implemented, how should config merging work — deep merge or replace? Should there be a way to "reset" back to base config at the start of a phase?

5. **Progress continuity in split PRD mode**: If users do split PRDs, should `progress.txt` carry over by default? Currently each session appends to the same `progress.txt` (configured path), so this already works — but `knowledge.md` and `SessionPersistence` data are lost.

6. **Visibility of future phases**: In a single PRD, the agent can read Phase 2 tasks even when Phase 1 is active. The existing `buildPrompt` filters to unchecked tasks only — but it doesn't filter by phase. Should checkpoint-delimited phases be hidden from prompt context until active?
