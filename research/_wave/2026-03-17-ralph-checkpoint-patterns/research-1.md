# Ralph-Loop Human Checkpoint Patterns

**Research question**: Does ralph-loop have proactive human checkpoint patterns, or only reactive ones (HumanCheckpointRequested on failure)?

**Date**: 2026-03-17

---

## Findings

### 1. HumanCheckpointRequested is Exclusively Reactive

`LoopEventKind.HumanCheckpointRequested` is yielded in exactly **two** places in `src/orchestrator.ts`, both triggered by failure escalation chains:

**Trigger A — Diff Validation Exhaustion** (orchestrator.ts ~L870–L885):
After a task completes (model signals done), `DiffValidator` checks whether any files actually changed. If no diff is found, the loop retries up to `maxDiffValidationRetries` (default 3). Only after **all retries are exhausted** does it yield `HumanCheckpointRequested`:
```
Empty diff → nudge + re-enter (attempt 1)
          → DiffValidationFailed event (attempt 2)
          → DiffValidationFailed event (attempt 3)
          → HumanCheckpointRequested + pause
```

**Trigger B — Stagnation Escalation Tier 3** (orchestrator.ts ~L760–L770):
`StagnationDetector` hashes `progress.txt` and `PRD.md` before/after each iteration. When `staleIterations >= maxStaleIterations + 2` (i.e., ≥4 with default maxStaleIterations=2), the three-tier escalation reaches its final stage:
```
staleIterations = maxStaleIterations   → Tier 1: inject stagnation nudge
staleIterations = maxStaleIterations+1 → Tier 2: circuit breaker (skip)
staleIterations = maxStaleIterations+2 → Tier 3: HumanCheckpointRequested + pause
```

**There are zero proactive (pre-defined, non-failure-driven) checkpoint triggers anywhere in the codebase.**

### 2. The Cooldown Dialog: Closest to Proactive, But Opt-In

The `showCooldownDialog()` in `src/cooldownDialog.ts` fires **between every task** (orchestrator.ts ~L1100–L1125) when `cooldownShowDialog !== false`. It presents:
- **Auto-accept timeout**: If the user doesn't respond within `countdownSeconds * 1000`ms, it auto-continues
- **Options**: Pause, Stop, Edit Next Task

This is a *semi-proactive* interaction point — it gives the human a window to intervene between tasks — but it is **not a checkpoint** in the HumanCheckpoint sense:
- It does **not** yield `HumanCheckpointRequested`
- It does **not** pause the loop waiting for the human — it **auto-continues** on timeout
- It's a "speak now or forever hold your peace" notification, not a gate

### 3. Complete State Machine for HumanCheckpointRequested

```
Running
  → [failure condition met]
  → yield HumanCheckpointRequested { task, reason, failCount, taskInvocationId }
  → this.pauseRequested = true
  → loop enters: while (this.pauseRequested) { state = Paused; delay(1000) }

User sees VS Code showWarningMessage with 4 options:
  ├── "Continue"        → orchestrator.resume() → pauseRequested=false → continues loop
  ├── "Skip Task"       → orchestrator.resume() → continues (task stays uncompleted)
  ├── "Stop Loop"       → orchestrator.stop()   → stopRequested=true → exits
  └── "Provide Guidance"→ showInputBox → injects text as promptBlocks → resume()
  └── [dismissed]       → orchestrator.resume() → continues
```

Key detail: "Skip Task" and "Continue" do the exact same thing — both call `resume()`. There's no explicit skip mechanism in the handler (the task remains in its current state and the loop picks the next pending task naturally).

### 4. Other Human Interaction Points (Non-Checkpoint)

| Interaction Point | Location | Type | Blocks Loop? |
|---|---|---|---|
| Cooldown dialog | orchestrator.ts L1100 | Inter-task notification | No (auto-continues) |
| Context injection command | extension.ts `ralph-loop.injectContext` | On-demand (user-initiated) | No |
| Yield command | extension.ts `ralph-loop.yield` | On-demand (user-initiated) | Deferred to task boundary |
| Session resume prompt | extension.ts L490+ | Activation-time | No (one-time) |
| BearingsFailed pause | orchestrator.ts L640 | Reactive (health check fail) | Yes (sets pauseRequested) |
| Session changed pause | orchestrator.ts L360 | Reactive (session drift) | Yes (sets pauseRequested) |

### 5. BearingsFailed: A Hidden Reactive Checkpoint

When the pre-flight bearings check (`runBearings()`) fails twice consecutively (first failure injects a fix task, second failure gives up), the orchestrator sets `pauseRequested = true` and yields `BearingsFailed`. However, there's **no corresponding UI handler** in `extension.ts` for `BearingsFailed` — the user gets no dialog. The loop just silently pauses with no way to unpause except calling `resume()` programmatically. This appears to be a gap.

---

## Patterns

### Pattern 1: Escalation Ladder (Only Pattern Used)
Every checkpoint follows the same escalation pattern:
1. **Self-heal** — inject a nudge, retry automatically
2. **Circuit break** — skip the task
3. **Human checkpoint** — last resort, pause for human

There is no "ask before acting" pattern. The philosophy is: the agent tries everything it can before involving the human.

### Pattern 2: Passive Window (Cooldown Dialog)
The cooldown dialog creates a time-boxed window for human intervention but defaults to non-blocking. This is the closest thing to a proactive checkpoint, but it's designed to be ignorable.

### Pattern 3: No Scheduled/Milestone Checkpoints
There are no:
- "Pause after every N tasks" checkpoints
- "Pause before high-risk tasks" checkpoints
- "Pause at phase boundaries" checkpoints
- Task-level `requiresConfirmation` flags
- Priority/risk-based checkpoint triggers

---

## Applicability

### For vscode-copilot-chat Agent Mode Integration

Ralph-loop's pattern is **fully reactive** — it only interrupts the human when the system has exhausted its own recovery mechanisms. This is appropriate for a trusted autonomous agent but may not be sufficient for:

1. **Destructive operations**: Agent mode needs pre-action confirmation for `rm -rf`, `git push --force`, etc. Ralph has no equivalent.
2. **Cost-aware pauses**: No mechanism to pause after consuming N tokens or N minutes of model time.
3. **User-defined gates**: No way for users to mark specific PRD tasks as requiring human approval before execution.
4. **Phase transition reviews**: If a PRD has logical phases (setup → implement → test → deploy), there's no way to require human sign-off between phases.

### Adaptation Opportunities

The cooldown dialog pattern (`showCooldownDialog`) could be extended into a true proactive checkpoint by:
- Removing the auto-accept timeout for flagged tasks
- Adding a `checkpoint: true` field to task definitions
- Adding a config `checkpointEveryNTasks: number` option

The `HumanCheckpointRequested` event infrastructure is well-designed and could handle proactive triggers without architectural changes — the event type, the pause mechanism, and the 4-option UI are all reusable.

---

## Open Questions

1. **BearingsFailed has no UI handler** — is this intentional (expecting programmatic resume) or a bug?
2. **"Skip Task" and "Continue" are identical** in the HumanCheckpointRequested handler — should Skip explicitly mark the task as skipped?
3. **No proactive checkpoints by design?** — The PRD (line ~134) only specifies failure-driven checkpoints. Was proactive checkpointing considered and rejected, or simply not yet designed?
4. **Cooldown dialog disabled by default?** — `cooldownShowDialog` defaults to `undefined` (truthy check `!== false`), meaning it's enabled by default. Is this the intended UX for automated runs?
5. **Context injection during pause** — When the loop is paused at a HumanCheckpointRequested, the "Provide Guidance" option injects text into `promptBlocks` (config-level, persistent). Should this be `pendingContext` (one-shot) instead?
