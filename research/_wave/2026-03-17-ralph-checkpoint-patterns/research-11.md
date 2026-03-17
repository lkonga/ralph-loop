# Research: Dual Exit Gate × Human Checkpoint Layer Interaction

**Date**: 2026-03-17
**Question**: How does ralph's dual exit gate (model signal + machine verification) interact with a potential human checkpoint layer?

---

## Findings

### 1. The Dual Exit Gate (`dualExitGateCheck`)

The dual exit gate in [src/verify.ts](../../../src/verify.ts#L170) requires **two independent signals** to allow task completion:

| Signal | Source | What it checks |
|--------|--------|---------------|
| **Model signal** (`modelSignal: boolean`) | LLM-driven execution result (`waitResult.completed`) | Whether the model believes the task is done |
| **Machine verification** (`machineVerification: VerifyCheck[]`) | Deterministic checks (checkbox in PRD, file diff existence) | Whether observable artifacts confirm completion |

The gate produces four outcomes:

| Model | Machine | Result |
|-------|---------|--------|
| ✓ | ✓ | `canComplete: true` — task proceeds to post-completion pipeline |
| ✓ | ✗ | `canComplete: false` — "Model claims complete but verification failed" |
| ✗ | ✓ | `canComplete: false` — "Verification passes but task not marked complete" |
| ✗ | ✗ | `canComplete: false` — both failed, full reason string |

This is a strict AND gate. No single signal can override the other.

### 2. Existing Post-Gate Pipeline (After `canComplete: true`)

The orchestrator runs a **sequential chain** after the dual gate passes ([orchestrator.ts ~L791–L975](../../../src/orchestrator.ts)):

```
dualExitGate ──✓──→ knowledgeExtraction
                  → consistencyCheck
                  → diffValidation (retry loop, up to maxDiffValidationRetries)
                  → confidenceScoring (threshold check, can loop back)
                  → preCompleteHooks (can retry or stop)
                  → taskCompleteHook (can block)
                  → reviewAfterExecute (LLM review, can retry)  ← REVIEW LAYER
                  → atomicCommit
                  → yield handling
```

**Key observation**: The post-gate pipeline already contains multiple "veto points" that can reject completion and loop the task back. The dual gate is the *entry* gate; the pipeline acts as a series of *additional* gates.

### 3. Human Checkpoint — Already Implemented as Escalation

`HumanCheckpointRequested` is emitted in **two** escalation scenarios:

**Scenario A — Stagnation Tier 3** ([orchestrator.ts ~L749](../../../src/orchestrator.ts)):
- Triggered when `staleIterations >= maxStaleIterations + 2`
- Tier progression: Tier 1 (nudge) → Tier 2 (circuit breaker) → **Tier 3 (human checkpoint)**
- Sets `pauseRequested = true`, loop blocks until human acts

**Scenario B — Diff Validation Exhaustion** ([orchestrator.ts ~L851](../../../src/orchestrator.ts)):
- Triggered when diff validation fails `maxDiffValidationRetries` times
- Sets `pauseRequested = true`

The VS Code extension handler ([extension.ts ~L163](../../../src/extension.ts)) presents four choices:
- **Continue** — resume loop
- **Skip Task** — resume (skip)
- **Stop Loop** — halt entirely
- **Provide Guidance** — inject text into prompt blocks, then resume

### 4. Review-After-Execute — The Existing "Soft Review Layer"

`ReviewAfterExecuteConfig` is **fully implemented** (not just typed):

- **Type**: Defined in [types.ts](../../../src/types.ts) with `enabled`, `mode` ('same-session' | 'new-session'), `reviewPromptTemplate`
- **Default**: `enabled: false` — opt-in
- **Implementation**: `sendReviewPrompt()` sends a review prompt to Copilot; `parseReviewVerdict()` parses the response for APPROVED/NEEDS-RETRY
- **Position**: Runs **after** confidence threshold passes, **before** atomic commit
- **Effect**: If verdict is `needs-retry`, task is un-completed and loops back

This is an **LLM-as-reviewer** pattern, not a human checkpoint. It uses the same model (or a different session) to review its own work.

---

## Patterns

### Pattern 1: Gate Hierarchy as Observed

```
┌─────────────────────────────────────────────────────────────────┐
│ ENTRY GATE: Dual Exit Gate (model ∧ machine)                    │
│   → AND of: model believes done + PRD checkbox + file changes   │
├─────────────────────────────────────────────────────────────────┤
│ POST-GATE PIPELINE (sequential veto chain):                     │
│   1. Consistency check (deterministic)                          │
│   2. Diff validation (deterministic, retry loop → HUMAN ESCALATION) │
│   3. Confidence scoring (weighted score, threshold gate)        │
│   4. PreComplete hooks (pluggable, can veto)                    │
│   5. TaskComplete hook (can block)                              │
│   6. Review-after-execute (LLM review, can veto)               │
│   7. Atomic commit (final action)                               │
├─────────────────────────────────────────────────────────────────┤
│ ESCALATION: Human checkpoint (stagnation or diff exhaustion)    │
│   → Pauses loop, presents VS Code dialog                        │
│   → Human can: continue / skip / stop / inject guidance         │
└─────────────────────────────────────────────────────────────────┘
```

### Pattern 2: Human Checkpoint is Currently Reactive, Not Proactive

The human checkpoint is only triggered by **failure escalation** — it never fires on the happy path. There is no concept of "always require human approval for task X" or "require human sign-off before commit."

### Pattern 3: ReviewAfterExecute is LLM-on-LLM, Not Human

The review layer uses an LLM prompt to check quality. It provides a structured verdict but has no human-in-the-loop mechanism. The `ReviewVerdict` type (`approved` | `needs-retry`) was designed for automated consumption.

---

## Applicability — Where Would a Human Checkpoint Fit?

### Option A: Triple Gate (model ∧ machine ∧ human)

**Mechanism**: Extend `dualExitGateCheck` to `tripleExitGateCheck(modelSignal, machineChecks, humanApproval)`.

**Pros**: Strongest guarantee — nothing passes without explicit human sign-off.
**Cons**: Destroys autonomy. Every task blocks on human. Defeats the purpose of an autonomous loop. The dual gate was designed specifically to avoid requiring human judgment on the happy path.

**Verdict**: ❌ Inappropriate for the general case. Only viable for very high-stakes tasks (production deployments, security-sensitive changes).

### Option B: Sequential Gates — `(model ∧ machine) → human`

**Mechanism**: Add a `humanReview` step in the post-gate pipeline, positioned after confidence scoring and before atomic commit (replacing or augmenting `reviewAfterExecute`).

```
dualExitGate → confidence → preComplete → HUMAN REVIEW → commit
```

**Pros**: 
- Preserves dual gate integrity — model+machine gate still filters obviously incomplete work
- Human only sees tasks that passed all automated checks
- Natural insertion point already exists (reviewAfterExecute slot)
- Can be made conditional: only for tagged tasks, above-threshold complexity, or first N tasks

**Cons**: 
- Blocks loop on every qualifying task until human responds
- Needs timeout/fallback (auto-approve after N minutes?)

**Verdict**: ✅ Best fit for ralph's architecture. The `ReviewAfterExecuteConfig` slot is perfectly positioned for this. Implementation would:
1. Add a `mode: 'human'` option to `ReviewAfterExecuteConfig` (alongside 'same-session' and 'new-session')
2. Emit `HumanCheckpointRequested` with reason "human review required" and a diff summary
3. Pause until human provides verdict via VS Code dialog
4. Parse verdict as `ReviewVerdict` (approved/needs-retry)

### Option C: Human Gate Replaces Machine Gate for Specific Tasks

**Mechanism**: For tasks tagged with e.g. `[human-review]`, skip machine verification and require human approval instead.

**Pros**: Flexible per-task control.
**Cons**: 
- Weakens the system — removing machine verification means the human must catch what automated checks would catch
- Violates the dual gate's core premise (independent signals reduce error)
- Human reviewers are worse at catching deterministic failures (missing checkbox, no diff)

**Verdict**: ❌ Anti-pattern. Machine verification is cheap and reliable — it should always run. Human review should be **additive**, not substitutive.

---

## Open Questions

1. **Should human review be blocking or async?** Current `HumanCheckpointRequested` is blocking (loop pauses). An async pattern could queue tasks for review and continue with the next task, committing only after approval. This requires a review queue and deferred commit mechanism that doesn't exist yet.

2. **Auto-approve timeout?** If human doesn't respond within N minutes, should the task auto-approve (trusting the machine checks) or auto-reject (conservative)? Neither is implemented.

3. **Granularity of human review trigger**: The `ReviewAfterExecuteConfig` is global (applies to all tasks). A per-task or per-category trigger (e.g., tasks touching security-sensitive files, tasks that failed once before, tasks with low confidence scores) would be more practical. The `verificationTemplates` pattern in `resolveVerifiers` shows how task-description-based matching could work for this.

4. **Review UX richness**: The current `HumanCheckpointRequested` handler shows a simple VS Code warning dialog with four buttons. For effective code review, a richer UX (showing the diff, test results, confidence breakdown) would be needed. This is a UI gap, not an architectural one.

5. **Does adding human weaken dual gate?** No — if implemented as Option B (sequential), the dual gate remains intact. The human layer is an additional filter in the post-gate pipeline. It **strengthens** overall quality assurance by adding a third independent signal class (human judgment) that catches semantic issues neither model nor machine verification can detect (e.g., "this is technically correct but architecturally wrong").

6. **ReviewAfterExecute as the natural evolution point**: The existing `ReviewAfterExecuteConfig` with `enabled: false` by default is the clearest insertion point. Extending its `mode` field from `'same-session' | 'new-session'` to include `'human'` or `'human-checkpoint'` would be a minimal, backward-compatible change that slots perfectly into the existing orchestrator flow.
