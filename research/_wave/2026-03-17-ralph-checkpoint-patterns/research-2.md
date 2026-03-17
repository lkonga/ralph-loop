# Research: Explicit Checkpoints vs Dependency-Chain-with-Failing-Verifier

**Question**: Should the PRD DSL support explicit deterministic checkpoints (`[CHECKPOINT]`, `[HUMAN-REVIEW]`), or should `dependsOn` chains + deliberate verification failure be the only mechanism?

**Date**: 2026-03-17  
**Scope**: `src/prd.ts`, `src/types.ts`, `src/orchestrator.ts`, `src/verify.ts`, `src/decisions.ts`, `src/hookBridge.ts`, `PRD.md`

---

## Findings

### Current DSL Syntax and Parsing

The PRD parser (`src/prd.ts`) recognizes exactly three constructs:

1. **Unchecked checkbox**: `- [ ] description` — regex `CHECKBOX_UNCHECKED`
2. **Checked checkbox**: `- [x] description` — regex `CHECKBOX_CHECKED`
3. **Dependency annotation**: `depends: Task-ID-1, Task-ID-2` — regex `DEPENDS_ANNOTATION` embedded in the description text
4. **Skip annotation**: `[DECOMPOSED]` — causes the line to be **skipped entirely** during parsing (not added to the task list)

Task IDs are extracted from bold markdown (`**TaskName**`) or auto-generated from the first 30 characters. Indentation creates implicit dependency on the nearest less-indented predecessor. Explicit `depends:` overrides indentation inference.

### How Dependencies Gate Execution

In `pickReadyTasks()` (prd.ts:98–113), a task is "ready" only when **all** entries in its `dependsOn` array appear in the `completedDescriptions` set (derived from checked checkboxes). The orchestrator calls `pickReadyTasks()` on each iteration, so a task with unmet dependencies simply never gets selected.

### Existing "Checkpoint-Like" Mechanisms

Ralph already has **three implicit checkpoint mechanisms**, none requiring DSL syntax:

| Mechanism | Trigger | Effect | Source |
|---|---|---|---|
| `HumanCheckpointRequested` event | Stagnation tier 3 (staleIterations ≥ threshold + 2), diff validation retries exhausted, max retries exhausted | Pauses loop, shows VS Code warning with Continue/Skip/Stop/Provide Guidance options | orchestrator.ts:749, 851; extension.ts:163 |
| PreComplete hook chain | After verifiers pass, before `TaskComplete` fires | Chain of hooks (prd-checkbox-check, progress-updated) can return `retry` or `stop`; `stop` halts the loop immediately | types.ts PreCompleteHookConfig; hookBridge.ts:88–109 |
| Stop hook verification gate | Copilot agent calls `task_complete` tool | Stop hook script checks checkbox, progress mtime, tsc, vitest — blocks stopping with reason if any fails | hookBridge.ts:52–140 |

### What a `[CHECKPOINT]` Annotation Would Look Like

A hypothetical explicit checkpoint syntax in the current DSL:

```markdown
- [ ] **Setup database** — implement schema migrations
- [CHECKPOINT] **Review schema** — human reviews migration files before data tasks begin
- [ ] **Seed test data** — depends: Setup database
```

This would require:
1. A new regex in `prd.ts`, e.g. `const CHECKPOINT_ANNOTATION = /^\s*-\s*\[(CHECKPOINT|HUMAN[_-]REVIEW)\]\s+(.+)$/i`
2. A new `TaskStatus.Checkpoint` enum value or a boolean `isCheckpoint` on the `Task` interface
3. Logic in the orchestrator to detect checkpoint tasks and emit `HumanCheckpointRequested` **before** attempting execution
4. The checkpoint task would need to be "completed" by human action (marking it `[x]`) to unblock downstream dependents

### Comparison: Explicit Checkpoint vs Dependency + Failing Verifier

#### Approach A: Explicit `[CHECKPOINT]` / `[HUMAN-REVIEW]` DSL Annotation

**How it works**: Parser recognizes a new annotation. When the orchestrator encounters a checkpoint task, it immediately emits `HumanCheckpointRequested` and pauses — no Copilot invocation, no execution attempt.

**Pros**:
- **Intent is unambiguous** — anyone reading the PRD knows this is a deliberate human gate
- **Zero wasted compute** — no agent invocation, no verification failure, no retry cycle
- **Predictable behavior** — checkpoint always fires at exactly the right position in the DAG
- **Composable** — checkpoints participate in dependency resolution naturally (downstream tasks depend on the checkpoint task)
- **Low implementation cost** — one new regex, one new enum value, one `if` branch in orchestrator

**Cons**:
- **DSL complexity creep** — adds a third bracket annotation (`[x]`, `[DECOMPOSED]`, `[CHECKPOINT]`)
- **Not machine-verifiable** — the checkpoint is a pure human gate with no automated criteria
- **Rigid** — once placed, the checkpoint fires even when it might not be needed (e.g. trivial schema changes)

#### Approach B: Dependency Chain + Deliberately-Failing Verifier

**How it works**: A normal task with a custom verifier configured to always fail (or fail until a human touches a sentinel file):

```markdown
- [ ] **Review schema** — depends: Setup database
```

Config:
```json
{
  "verificationTemplates": [{
    "name": "review schema",
    "verifiers": [
      { "type": "fileExists", "args": { "path": ".approvals/schema-reviewed" } }
    ]
  }]
}
```

The task gets sent to Copilot, fails verification (sentinel file doesn't exist), exhausts retries, triggers `HumanCheckpointRequested`.

**Pros**:
- **No DSL changes** — uses existing `depends:` + `verifiers` infrastructure
- **Machine-verifiable** — the gate has a concrete criterion (file exists, command exits 0)
- **Flexible** — gate can be automated later (CI creates the sentinel file)
- **Composable with existing verifier chain** — multiple conditions can be combined

**Cons**:
- **Wasteful retry cycle** — agent gets invoked 1+ times, burns context/tokens, runs verifiers, exhausts retries, THEN checkpoints. With default settings: 1 execution + 3 nudges + 3 retries = up to 7 Copilot invocations before the human gate fires.
- **Intent is opaque** — nothing in the PRD signals "this is a human gate." A reader sees a normal task. The checkpoint behavior is hidden in config JSON.
- **Fragile coupling** — if config changes (verifier removed, template name typo), the checkpoint silently disappears
- **Slow** — elapsed time from "task starts" to "human gate fires" includes multiple timeout + retry cycles. At default 60s inactivity timeout: worst case ~7 × 60s = 7 minutes of wasted wall clock.
- **Confusing agent behavior** — Copilot receives the task, tries to implement it, gets confused by a task that says "review" but expects file changes

#### Approach C: Hybrid — Lightweight Annotation That Maps to Verifier

```markdown
- [ ] **Review schema** [GATE: file:.approvals/schema-reviewed] — depends: Setup database
```

Parser extracts the `[GATE: ...]` annotation, skips agent execution, directly checks the gate condition. If not met, emits `HumanCheckpointRequested`. If met (file exists), auto-completes the task.

**Pros**: combines intent clarity (visible in PRD) with machine verifiability (concrete criterion)  
**Cons**: most complex to implement; novel syntax with no precedent in the existing DSL

---

## Patterns

### Pattern 1: The "Annotation → Event" Pipeline

The existing `[DECOMPOSED]` annotation shows an established pattern: bracket annotations in task lines change parsing behavior. `[DECOMPOSED]` skips the task entirely. A `[CHECKPOINT]` would follow the same pattern but with different semantics (pause instead of skip). This is the cheapest extension point.

### Pattern 2: Existing Escalation Tiers Already Model Checkpoints

The stagnation detector and diff validator both escalate through: nudge → circuit breaker → `HumanCheckpointRequested`. The checkpoint event infrastructure is mature — VS Code prompt with 4 options, pause/resume machinery, guidance injection. An explicit `[CHECKPOINT]` annotation would just short-circuit to the final tier.

### Pattern 3: Verifier-as-Gate Is Powerful but Expensive

The `VerifierRegistry` + `resolveVerifiers()` chain is designed for post-execution validation, not pre-execution gating. Using it as a checkpoint requires the agent to attempt execution first. The retry/nudge machinery amplifies this cost. For a pure human review gate, this machinery is a poor fit.

### Pattern 4: DAG Dependencies Are Necessary but Insufficient

`depends:` ensures ordering: B won't start until A is complete. But it says nothing about HOW A completes. A checkpoint is a constraint on the completion mechanism (human, not agent). Dependencies are orthogonal to checkpoints — you need both: "this task depends on the review AND the review requires human action."

---

## Applicability

### Recommendation: Add Explicit `[CHECKPOINT]` with Optional Verifier

The strongest approach is **Approach A with an optional verifier escape hatch**:

1. **Add `[CHECKPOINT]` annotation** to the parser. Minimal changes:
   - New regex: `const CHECKPOINT_MARKER = /\[CHECKPOINT\]/i`
   - In `parsePrd()`, detect the marker and set a `checkpoint: boolean` field on the `Task` interface
   - In `pickReadyTasks()`, skip checkpoint tasks (they're never "ready" for agent execution)
   - In the orchestrator, after `pickReadyTasks()` returns empty but checkpoint tasks exist with met dependencies, emit `HumanCheckpointRequested` with the checkpoint task

2. **Optional auto-resolve**: Add `checkpointAutoResolve?: VerifierConfig` to allow a checkpoint to self-resolve when a verifier passes (e.g., CI posts a sentinel file). This handles the "human review in dev, automated in CI" use case.

3. **Do NOT use dependency + failing verifier as the primary checkpoint mechanism**. The retry/nudge overhead is architecturally wasteful and the intent is invisible.

### Implementation Sketch

```typescript
// In prd.ts
const CHECKPOINT_MARKER = /\[CHECKPOINT\]/i;

// In Task interface (types.ts)
readonly checkpoint?: boolean;

// In parsePrd(), when processing a line:
const isCheckpoint = CHECKPOINT_MARKER.test(line);
// ... set task.checkpoint = isCheckpoint

// In pickReadyTasks(), filter out checkpoint tasks
if (task.checkpoint) { continue; }

// In orchestrator, new method:
function pickCheckpointTasks(snapshot: PrdSnapshot): Task[] {
  // Return checkpoint tasks whose dependencies are met but need human action
}
```

Estimated scope: ~40 lines across 3 files. No test infrastructure changes needed — existing checkpoint event handling in extension.ts works as-is.

---

## Open Questions

1. **Should `[CHECKPOINT]` be a task status or a task attribute?** Making it a status (`TaskStatus.Checkpoint`) conflicts with the existing status flow (Pending → InProgress → Complete). Making it an attribute (`checkpoint: boolean`) is cleaner — the task stays Pending until a human marks it `[x]`.

2. **How does a human "pass" a checkpoint?** Currently, marking `[x]` in the PRD is the only completion signal. This works: human reviews, marks checkbox, loop continues. But should there be a VS Code command (`ralph-loop.approveCheckpoint`) that also injects review notes into progress.txt?

3. **Should checkpoints be configurable per-environment?** A checkpoint that's mandatory in dev might be skippable in CI. This suggests the `checkpointAutoResolve` verifier approach, where CI configures a verifier that auto-passes.

4. **Interaction with parallel execution**: If two parallel branches converge at a checkpoint, the checkpoint should fire once after BOTH branches complete. The existing `dependsOn` mechanism handles this naturally if the checkpoint lists both branches as dependencies.

5. **Should `[HUMAN-REVIEW]` be a separate annotation or an alias?** Semantically, "checkpoint" (pause for any reason) and "human review" (pause specifically for code review) might warrant different UI treatments. For V1, treating them as aliases keeps things simple.

6. **Naming**: `[CHECKPOINT]` vs `[GATE]` vs `[PAUSE]` vs `[HUMAN-REVIEW]` — which is most intuitive for PRD authors? `[CHECKPOINT]` has the broadest meaning and aligns with the existing `HumanCheckpointRequested` event name.
