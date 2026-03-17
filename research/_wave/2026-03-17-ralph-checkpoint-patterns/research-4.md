# Research Report: Risk of Checkpoint Overuse Deviating from Ralph's Fully-Automated Philosophy

**Wave**: 2026-03-17-ralph-checkpoint-patterns
**Report**: research-4
**Question**: At what point does human intervention defeat the purpose of ralph-loop?

---

## Findings

### Ralph's Declared Philosophy

Ralph-loop's README states:

> "Fully autonomous... verifies completion with deterministic machine checks (not LLM self-report)."

The core insight is explicit: **context rot is unsolvable within a session, so nuke the context and persist state in files**. The system's value proposition is deterministic, unattended task execution — a human writes a PRD, walks away, and returns to find commits.

The original snarktank/ralph (113 lines of bash) had ZERO human checkpoints. It was a pure automation loop: pipe prompt, capture output, check completion, repeat. No cooldown dialogs, no pause buttons, no guidance input boxes.

### Current Human Intervention Points

Ralph-loop has accumulated **at least 7 distinct human intervention pathways**:

| Intervention Point | Trigger | User Action | Source |
|---|---|---|---|
| **Cooldown dialog** | Between every task (`cooldownShowDialog: true` default) | Pause / Stop / Edit Next Task | `cooldownDialog.ts` |
| **Stagnation checkpoint** | `staleIterations >= maxStaleIterations + 2` | Continue / Skip / Stop / Provide Guidance | `orchestrator.ts:750` |
| **Diff validation checkpoint** | No code changes after `maxDiffValidationRetries` (3) | Continue / Skip / Stop / Provide Guidance | `orchestrator.ts:851` |
| **Session changed warning** | Chat session changed externally | Informational (loop paused) | `extension.ts:161` |
| **Error message** | Loop error | Informational | `extension.ts:191` |
| **Task timeout warning** | Inactivity timeout fires | Informational | `extension.ts:139` |
| **Provide Guidance input** | Any HumanCheckpointRequested | User types instructions → injected as context | `extension.ts:179` |

Of these, **3 are blocking checkpoints** that pause the loop until a human responds (cooldown dialog, stagnation checkpoint, diff validation checkpoint). The cooldown dialog fires **after every single task completion** by default.

### The Cooldown Dialog: Most Impactful Deviation

The cooldown dialog (`cooldownDialog.ts`) shows a VS Code information message with "Pause", "Stop", and "Edit Next Task" buttons between every task. It auto-accepts after `countdownSeconds` (default: 12s), so unattended operation IS possible — but:

1. **12 seconds of dead time per task** accumulates. For a 20-task PRD, that's 4 minutes of idle waiting.
2. The dialog's existence implies the user should be watching. If they're watching, they're not getting the benefit of automation.
3. The "Edit Next Task" option mid-loop violates the "PRD as single source of truth" principle — it injects context that isn't captured in any persistent artifact.

### Feature Flag Explosion

`RalphFeatures` has 5 boolean flags. `RalphConfig` has **40+ configuration fields** including nested config objects for: diff validation, parallel monitoring, stagnation detection, auto-decompose, knowledge management, context trimming, struggle detection, bearings, backpressure, confidence threshold, context budget, inactivity, and cooldown. Many of these introduce implicit or explicit human intervention points.

The `HumanCheckpointRequested` event appears in THREE separate code paths in the orchestrator:
- Stagnation tier 3 (line 750)
- Diff validation exhaustion (line 853)
- Both set `this.pauseRequested = true` and spin-wait until a human responds

### The "Provide Guidance" Anti-Pattern

When `HumanCheckpointRequested` fires, the extension offers "Provide Guidance" which opens a VS Code input box. The user's text is appended to `promptBlocks` and injected into the next prompt. This is:
- **Not persisted** to any file artifact (not in progress.txt, not in knowledge.md)
- **Not recoverable** after a crash (session.json doesn't capture dynamic promptBlocks)
- **Invisible** in the audit trail
- **Antithetical** to ralph's file-based state philosophy

---

## Patterns

### Pattern 1: Graduated Autonomy Erosion

Ralph-loop follows a clear evolutionary trajectory:

```
snarktank/ralph (v0)     → Zero human intervention
aymenfurter/ralph (v0.5) → Cooldown countdown (auto-continue)
ralph-loop (current)     → 3 blocking checkpoints + guidance injection
```

Each phase added "just one more safety check" but the cumulative effect transforms the system from an automated loop into an interactive assistant with a loop bolted on.

### Pattern 2: Safety Mechanisms That Assume Presence

The 3-tier stagnation escalation (nudge → circuit breaker → human checkpoint) is well-designed in isolation. But tier 3 **blocks the loop entirely** until a human responds. If the user is asleep, at lunch, or trusting the system to run unattended, the loop simply halts. There is no timeout on `HumanCheckpointRequested` — it spin-waits indefinitely:

```typescript
this.pauseRequested = true;
while (this.pauseRequested) {
    this.state = LoopState.Paused;
    await this.delay(1000);
    if (this.stopRequested) { ... }
}
```

This converts a "safety valve" into a "requires active supervision" constraint.

### Pattern 3: Dual Exit Gate Sufficiency Question

The dual exit gate (model signal AND machine verification) was ralph-loop's key innovation over simpler implementations. It already provides strong guarantees: PRD checkbox must be marked AND tsc/vitest must pass. If this gate is trustworthy enough for task completion, why does the system ALSO need:
- Diff validation (a third check after the dual gate)
- Post-task review (a fourth check)
- Consistency checks (a fifth check)
- PreComplete hooks (a sixth check)
- Human checkpoints (the ultimate override)

Each layer adds diminishing returns in safety but guaranteed latency.

### Pattern 4: Configuration Complexity as a Smell

40+ config fields is a signal that the system is trying to be both fully automated AND fully supervised, and uses configuration to paper over the contradiction. Compare:

| System | Config Fields | Philosophy |
|---|---|---|
| snarktank/ralph | ~3 (PRD path, progress path, model) | Fully automated |
| ralph-loop | 40+ | Configurable automation-supervision hybrid |
| VS Code autopilot | ~5 (permission level, tool limits) | Deterministic within chosen level |

VS Code's autopilot solves this differently: the user picks a **permission level** (confirm → normal → autopilot) and the system operates deterministically within that level. There is no "autopilot but also ask me sometimes" mode.

---

## Applicability

### The Fundamental Tension

Ralph-loop's value proposition is: "Write a PRD, press start, come back to commits."

Human checkpoints break this contract. They convert "come back to commits" into "stay and watch, occasionally clicking Continue." The system cannot be unattended if it blocks on human input.

### Where Checkpoints Are Justified

1. **Destructive operations**: File deletion, database modifications, production deployments — these warrant human gates. Ralph-loop doesn't do these (it edits source code and runs tests).
2. **Cost concerns**: If each task consumes significant API credits, a checkpoint before expensive operations makes economic sense. But ralph-loop delegates to Copilot, which has its own quota management.
3. **First-run trust building**: A cooldown dialog during a user's first few runs helps build confidence. But `cooldownShowDialog: true` as a permanent default assumes the user never trusts the system.

### Where Checkpoints Are Harmful

1. **Stagnation checkpoint without timeout**: Should auto-skip after N minutes, not block forever.
2. **Cooldown dialog on every task**: Should default to `false` once the user has seen it work. Or respect a "headless mode" flag.
3. **Provide Guidance injection**: Should write to knowledge.md or a persistent artifact, not volatile config.

### The "Headless Mode" Solution

Instead of removing checkpoints, ralph-loop should support a clean separation:

```
Interactive mode (default for new users):
  - Cooldown dialog between tasks
  - HumanCheckpointRequested pauses loop
  - Provide Guidance available

Headless mode (for trusted, unattended runs):
  - No dialogs
  - HumanCheckpointRequested → auto-skip task after 60s timeout
  - All interventions logged to progress.txt
  - Circuit breakers still active (auto-stop, not pause)
```

This is similar to VS Code's permission-level approach: the user declares their supervision intent upfront, and the system operates consistently within that contract.

### Quantifying the Cost

For a 20-task PRD with default settings:
- **Best case** (no issues): 20 × 12s cooldown = **4 minutes of idle time**
- **Typical case** (2 stagnations, 1 diff failure): 4 min + indefinite human wait × 3 checkpoints
- **Headless equivalent**: 0 minutes idle, auto-skip stuck tasks, full progress.txt audit trail

---

## Open Questions

1. **Should `cooldownShowDialog` default to `false`?** The auto-accept timeout (12s) makes it functionally a speed bump. Users who want supervision can opt in. Users who trust the system shouldn't pay the latency tax.

2. **Should `HumanCheckpointRequested` have a configurable timeout?** Currently it blocks indefinitely. A `humanCheckpointTimeoutMs: 300000` (5 min) that auto-skips the task would preserve the safety signal (logged in progress.txt) without requiring human presence.

3. **Is "Provide Guidance" worth preserving?** It introduces state that isn't captured in any persistent artifact. If guidance is important enough to inject, it's important enough to persist in knowledge.md or append to the PRD.

4. **Does the verifier chain need all 7 layers?** The dual exit gate (checkbox + tsc/vitest) already catches the vast majority of issues. Each additional layer (diff validation, review, consistency, pre-complete hooks) adds latency. Is there evidence that tasks pass the dual gate but fail subsequent checks frequently enough to justify the overhead?

5. **Should ralph-loop adopt VS Code's permission-level model?** Instead of 40+ config knobs, offer 3 modes: `supervised` (all checkpoints), `standard` (machine-only verification), `headless` (no human interrupts, auto-skip on failure). Let the user declare intent once.

6. **What is the correct granularity for "automated loop" vs "human-assisted agent"?** If every phase needs human review, the user should just use Copilot directly in agent mode. Ralph-loop's value is in the LOOP — the automatic context reset, fresh sessions, PRD tracking — not in being another confirmation dialog layer.

7. **Is the 12-second cooldown an artifact of the original aymenfurter/ralph implementation that was cargo-culted forward?** The original needed it because its file-watcher completion detection had latency. Ralph-loop's dual exit gate with machine verification doesn't have this limitation — it knows with certainty when a task is done.
