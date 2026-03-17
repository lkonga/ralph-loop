# Research: Agent-Initiated Clarification vs Human-Predefined Checkpoints

**Wave**: 2026-03-17-ralph-checkpoint-patterns  
**Researcher**: research-3  
**Question**: Two flavors — agent-initiated clarification (last resort after exhausting all paths) vs human-predefined checkpoint in DSL — tradeoffs of each?

---

## Findings

### 1. Current Human Interaction Surfaces in ralph-loop

Ralph has **four distinct surfaces** where the loop interacts with a human:

#### A. Cooldown Dialog (between-task checkpoint)
- **File**: `src/cooldownDialog.ts` — `showCooldownDialog()`
- **When**: Fires between every task (if `cooldownShowDialog` is true)
- **Options**: Continue (auto-accept on timeout), Pause, Stop, Edit Next Task
- **Nature**: **Periodic, predictable** — always fires at the same structural point
- **Context injection**: "Edit Next Task" opens an input box → text goes to `orchestrator.injectContext()` → surfaced as `ContextInjected` event → rendered via `renderOperatorContext()` in the prompt as `OPERATOR CONTEXT (injected mid-loop)`
- **Auto-timeout**: If user doesn't respond within `countdownSeconds * 1000` ms, defaults to `'continue'` — fully autonomous fallback

#### B. HumanCheckpointRequested (failure-escalation checkpoint)
- **File**: `src/orchestrator.ts` lines 749–753, 851–856  
- **Event shape**: `{ kind: HumanCheckpointRequested, task, reason: string, failCount: number, taskInvocationId }`
- **Triggers** (exactly 2 code paths):
  1. **Stagnation Tier 3**: When `staleIterations >= maxStaleIterations + 2` — progress files haven't changed for multiple consecutive iterations
  2. **Diff validation exhausted**: When `diffAttempt >= maxDiffValidationRetries` — no code changes detected after multiple re-entries
- **Extension handling** (`src/extension.ts` lines 163–188): Shows VSCode warning with 4 choices:
  - **Continue** → `orchestrator.resume()`
  - **Skip Task** → `orchestrator.resume()` (skips to next)
  - **Stop Loop** → `orchestrator.stop()`
  - **Provide Guidance** → Input box → appends to `promptBlocks` via `updateConfig()` then resumes
- **Nature**: **Reactive, failure-driven** — only fires when the automated escalation chain is exhausted. The orchestrator sets `pauseRequested = true` and spin-waits until human responds.

#### C. Pause / Stop / Yield Commands
- **Methods**: `orchestrator.pause()`, `orchestrator.stop()`, `orchestrator.requestYield()`
- **Nature**: **Imperative, human-initiated** — VS Code commands the user can trigger at any time
- **Pause behavior**: Sets `pauseRequested = true`, causes spin-wait in the main loop
- **Yield behavior**: Deferred until task completion (autopilot pattern), then gracefully exits

#### D. Session Change Detection
- **When**: If `useSessionTracking` is enabled and the VS Code chat session ID changes during a running loop
- **Effect**: Auto-pauses the loop, shows warning message
- **Nature**: **Environmental trigger** — not explicitly human-initiated but caused by human action (opening new chat)

### 2. The additionalContext Injection Mechanism

This is ralph's primary way to "communicate" corrective information to the agent. The `additionalContext` variable is a mutable string in `runLoop()` that gets appended to the next prompt:

```
prompt += '\n\n' + additionalContext;
additionalContext = '';  // consumed once
```

**Sources that set additionalContext** (9 distinct injection points):

| Source | Context Injected | When |
|--------|-----------------|------|
| SessionStart hook | `sessionHook.additionalContext` | Loop startup |
| Shell command blocked | `"Shell command blocked: {reason}..."` | PostToolUse hook returns `blocked: true` |
| Stagnation Tier 1 | `"You appear to be stuck..."` | Progress files unchanged but below escalation threshold |
| Struggle detected | `"Struggle detected: {signals}..."` | StruggleDetector fires |
| Confidence score low | `"Verification confidence: {score}/180..."` | Confidence check fails after task completion |
| Dual exit gate rejection | `gateResult.reason + verification feedback` | Model says done but machine checks disagree |
| TaskComplete hook (success) | `completeHook.additionalContext` | Hook returns extra context |
| TaskComplete hook (failure) | `failHook.additionalContext` | Hook returns extra context after timeout |
| Pre-complete chain | Inherited from hooks | preCompleteHooks chain |

**Key design property**: additionalContext is always **one-shot** (consumed on next prompt build) and **agent-facing** (never shown to user). It's the machine-to-agent communication channel.

### 3. The Escalation Chain: Full Analysis

Ralph implements a **tiered escalation** for stuck tasks. The chain from mildest to most severe:

```
nudge (Tier 0)
  → stagnation Tier 1 + struggle detection (enhanced nudge)
    → circuit breaker / stagnation Tier 2 (skip task)
      → auto-decompose (break task into sub-tasks)
        → stagnation Tier 3 / diff validation exhausted (HumanCheckpointRequested)
          → stop (if human chooses or circuit breaker forces)
```

**Detailed tier breakdown:**

| Tier | Mechanism | Action | Human Involved? |
|------|-----------|--------|-----------------|
| 0 — Nudge | `maxNudgesPerTask` (default: 3) | Re-send prompt with continuation suffix | No |
| 0.5 — Final Nudge | `buildFinalNudgePrompt()` | "Produce your final result NOW" | No |
| 1 — Stagnation Tier 1 | `staleIterations >= maxStaleIterations` | Inject "try different approach" | No |
| 1 — Struggle | `StruggleDetector.isStruggling()` | Inject "completely different approach" | No |
| 1.5 — Confidence rejection | `score < confidenceThreshold` | Re-enter task with missing items | No |
| 1.5 — Dual gate rejection | Checkbox + diff mismatch | Re-enter task with feedback | No |
| 2 — Circuit breaker | Various thresholds | Skip task or stop loop | No |
| 2 — Stagnation Tier 2 | `staleIterations >= maxStaleIterations + 1` | Skip task (circuit breaker trip) | No |
| 3 — Auto-decompose | `failCount >= failThreshold` (default: 3) | Split task into sub-tasks in PRD | No |
| 4 — HumanCheckpoint | Stagnation Tier 3 or diff validation exhausted | Pause loop, ask human | **Yes** |
| 5 — Stop | User choice or circuit breaker `action: 'stop'` | Terminate loop | **Yes** (or automated) |

### 4. Agent-Initiated Clarification: What Information Is Available?

When ralph reaches the point where it "gets confused" (Tier 4), here's the diagnostic context available:

**From the orchestrator state:**
- `task` — the full Task object (description, id, lineNumber, status)
- `taskInvocationId` — UUID for this specific attempt
- `failCount` / `staleIterations` — how many times it failed
- `reason` — human-readable string ("Stagnation detected — no progress after multiple attempts" or "Diff validation failed after N attempts")
- `additionalContext` history — what corrective instructions were already injected

**From detectors:**
- `StagnationDetector`: which files haven't changed (`filesUnchanged: string[]`)
- `StruggleDetector`: what signals fired (e.g., "no_progress", "short_iterations", "thrashing")
- `BackpressureClassifier`: whether iteration pattern is "productive", "stagnant", or "thrashing"
- `ErrorHashTracker`: de-duped error hashes showing repeated vs unique errors
- `ConfidenceScore`: breakdown of which verification items failed (checkbox, vitest, tsc, progress_updated, diff)

**From file system:**
- `progress.txt` — full log of what the agent claimed to do
- `PRD.md` — current task list state
- Git diff — what files actually changed (via DiffValidator)

**What's NOT available but could be:**
- The actual agent output / response text (ralph doesn't capture LLM responses, only side effects)
- Specific error messages from test runs (only tracked as hashes via ErrorHashTracker)
- The "why" behind stagnation (ralph knows *that* files didn't change, not *why* the agent couldn't change them)

### 5. DSL-Predefined Checkpoints: Interaction with Automated Flow

Currently, ralph's DSL (PRD.md) has **no checkpoint syntax**. Tasks are simple markdown checkboxes:
```markdown
- [ ] Implement feature X
- [ ] Add tests for feature Y
```

A DSL checkpoint would add a new task type, e.g.:
```markdown
- [ ] Implement database migration
- [?] CHECKPOINT: Review migration schema before proceeding
- [ ] Apply migration to staging
```

**How this would interact with the flow:**

1. **Parser level**: `src/prd.ts` would need a new regex to detect checkpoint tasks and set a special status
2. **Orchestrator level**: When the task iterator reaches a checkpoint, it would emit `HumanCheckpointRequested` **before** executing, not after failing
3. **Cooldown dialog**: Could potentially be reused, but semantics differ (proactive review vs reactive fix)
4. **Automation bypass**: Checkpoints would need a "force-continue" mechanism for CI/headless runs
5. **Dependency chain**: Checkpoints would naturally block downstream tasks (already supported via `dependsOn`)

---

## Patterns

### Pattern A: Agent-Initiated Clarification (Current Model — Reactive)

```
[agent tries] → [nudge] → [struggle/stagnation] → [decompose] → [STUCK] → HumanCheckpoint
```

**Characteristics:**
- Fires only after *exhausting* all automated recovery mechanisms
- The agent never explicitly *requests* help — ralph's meta-loop detects stuckness via heuristics
- Human gets a generic prompt ("Stagnation detected") without rich diagnostic context
- Guidance path is crude: text appended to `promptBlocks` (permanent) rather than one-shot context

**Strengths:**
- Preserves **automation purity** — humans are never bothered unless genuinely needed
- Low false-positive rate — by the time HumanCheckpoint fires, the task is genuinely stuck
- No DSL changes needed — works with plain checkbox tasks

**Weaknesses:**
- **Late detection** — by the time the checkpoint fires, significant tokens/time have been wasted on failed attempts
- **Poor diagnostic context** — the human sees "Stagnation detected" but doesn't know what specific confusion the agent hit
- **Guidance is permanent** — text goes into `promptBlocks` which persists for ALL subsequent tasks, not just the stuck one
- **No proactive prevention** — can't protect high-risk operations (database migrations, deletes) that should always be reviewed

### Pattern B: Human-Predefined Checkpoint (Proposed — Proactive)

```
[parser sees checkpoint] → PAUSE → [human reviews/approves] → [continue]
```

**Characteristics:**
- The human *declares* in advance where review is needed
- Fires at a deterministic point in the plan, regardless of agent performance
- Can carry structured metadata (what to review, acceptance criteria)

**Strengths:**
- **Proactive safety** — protects high-risk operations before damage occurs
- **Predictable** — human knows exactly when they'll be interrupted
- **Rich context** — checkpoint description can specify exactly what to review
- **Domain-specific** — the human knows which tasks need review better than heuristics can detect

**Weaknesses:**
- **Breaks automation** — every checkpoint is a forced pause, reducing throughput
- **Maintenance burden** — checkpoints must be maintained as the plan evolves
- **Over-use risk** — developers may add too many checkpoints, making the loop effectively manual
- **CI/headless problem** — need a mechanism to skip or auto-approve in non-interactive contexts

---

## Applicability

### Comparison Matrix

| Dimension | Agent-Initiated (Reactive) | DSL Checkpoint (Proactive) |
|-----------|---------------------------|---------------------------|
| **Trigger** | Heuristic (stagnation/failure count) | Structural (position in plan) |
| **False positives** | Low (only after exhausting retries) | Potentially high (checkpoint on easy task) |
| **False negatives** | Medium (may miss confused-but-progressing states) | None for marked tasks, total for unmarked |
| **Time to human contact** | Late (after N failures × M nudges) | Immediately at checkpoint position |
| **Context quality** | Poor (generic "stagnation detected") | Rich (user describes what to check) |
| **Automation purity** | High (only breaks when stuck) | Depends on checkpoint frequency |
| **CI compatibility** | Good (rarely fires in well-tuned config) | Needs auto-approve mechanism |
| **Implementation cost** | Already exists | Needs parser + orchestrator + UI changes |
| **Guidance mechanism** | `promptBlocks` (permanent) or `injectContext` (one-shot) | Could be either |

### Recommended Hybrid Approach

The two patterns are **complementary, not competing**:

1. **Keep agent-initiated** for genuine failures (current behavior) — but improve diagnostic context in the `HumanCheckpointRequested` event to include struggle signals, error hashes, and failed verification items
2. **Add DSL checkpoints** for human-declared review gates — with these design choices:
   - Syntax: `- [?] CHECKPOINT: description` or `- [ ] ⏸ description` 
   - Auto-approve in headless/CI via config flag `checkpointBehavior: 'ask' | 'auto-approve' | 'fail'`
   - One-shot context injection (via `injectContext`) not permanent `promptBlocks`
   - Checkpoint tasks should emit a distinct event (e.g., `LoopEventKind.CheckpointReached`) separate from `HumanCheckpointRequested` to distinguish proactive from reactive

3. **Fix the guidance path**: Currently "Provide Guidance" appends to `promptBlocks` permanently. It should use `injectContext()` instead for one-shot injection, matching the cooldown dialog's "Edit Next Task" behavior.

### Where Each Applies

| Scenario | Best Fit |
|----------|----------|
| Routine feature development | Neither (let it run autonomously) |
| Database migrations | DSL Checkpoint |
| API contract changes | DSL Checkpoint |
| Agent keeps failing tests | Agent-Initiated (already works) |
| Security-sensitive operations | DSL Checkpoint |
| Unfamiliar codebase (agent may be confused) | Agent-Initiated with richer diagnostics |
| Multi-stage deployment | DSL Checkpoints at stage boundaries |

---

## Open Questions

1. **Guidance persistence bug**: The `HumanCheckpointRequested` handler in `extension.ts` (line 182) appends guidance to `promptBlocks` permanently via `updateConfig()`. Should this use `injectContext()` instead to make it one-shot? The cooldown dialog's "Edit Next Task" already uses `injectContext()` correctly.

2. **Skip Task semantics**: In the `HumanCheckpointRequested` handler, "Skip Task" calls `resume()` but doesn't actually mark the task as skipped or advance past it. The orchestrator will re-attempt the same task on resume. Is this intentional?

3. **Agent self-awareness**: Ralph's prompt says "Do not ask questions — act." This fundamentally prevents agent-initiated clarification at the LLM level. If we wanted the agent itself to signal confusion (vs ralph's meta-loop detecting it), we'd need a tool or escape hatch in the prompt, which clashes with the autonomous mandate.

4. **Checkpoint granularity**: Should checkpoints support conditions? E.g., `- [?] CHECKPOINT if tests fail: Review test strategy` — only pausing when a condition is met, blending reactive and proactive.

5. **Response capture gap**: Ralph cannot currently capture the agent's actual response text (only file-system side effects). This limits diagnostic quality for both patterns. Adding response capture would significantly improve human checkpoint context quality.

6. **Stagnation threshold tuning**: The current Tier 3 threshold is `maxStaleIterations + 2` (default: 4 stale iterations). Is this too generous? By iteration 4 with no file changes, substantial token budget has been consumed.

7. **Decomposition happens after timeout, not after stagnation**: Auto-decompose triggers on `failCount` (consecutive timeouts), while `HumanCheckpointRequested` triggers on `staleIterations` (stagnation) or `diffAttempt` exhaustion. These are parallel escalation paths that don't feed into each other — should decompose be tried before human checkpoint on the stagnation path too?
