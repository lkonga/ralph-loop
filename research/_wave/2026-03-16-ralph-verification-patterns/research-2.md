# Research Report: Circuit Breakers & Dual Exit Gates in ralph-loop

**Wave**: 2026-03-16-ralph-verification-patterns
**Report**: #2
**Question**: How do ralph-loop's circuit breakers and dual exit gates work — what patterns implement stagnation detection, nudge limits, retry caps, and graceful yield to form the "completion gate" safety net around the autonomous loop?

---

## Findings

### 1. Circuit Breaker Architecture

The circuit breaker system lives in `src/circuitBreaker.ts` and follows a **chain-of-responsibility** pattern. Each breaker is a stateless pure function (factory-returned object) that inspects a shared `CircuitBreakerState` snapshot and returns a `CircuitBreakerResult` with `{ tripped, reason, action }`.

**Six breaker types exist:**

| Breaker | Default | Action on Trip | What it Guards |
|---------|---------|---------------|----------------|
| `MaxRetriesBreaker` | 3 retries | `stop` | Transient error retry cap per task |
| `MaxNudgesBreaker` | 3 nudges | `stop` | Nudge ceiling per task |
| `StagnationBreaker` | 2 consecutive | `skip` | Nudges without file changes |
| `ErrorRateBreaker` | 60% over 5 | `stop` | Sliding-window error rate |
| `TimeBudgetBreaker` | 600s | `skip` | Wall-clock budget per session |
| `RepeatedErrorBreaker` | 3 occurrences | `skip` | Deduplicated error hashes repeating |

**Default chain**: Only `maxRetries`, `maxNudges`, and `stagnation` are **enabled** by default. `repeatedError`, `errorRate`, and `timeBudget` ship disabled — they're opt-in via config.

The `CircuitBreakerChain` iterates breakers in registration order and short-circuits on the first trip. A `disabled` set allows runtime toggling without removing breakers.

**Error Hash Deduplication** (`ErrorHashTracker`): Normalizes errors by stripping ANSI codes, timestamps, stack frame paths, and line numbers, then MD5-hashes the result. The `RepeatedErrorBreaker` queries this tracker for recurring patterns.

### 2. Dual Exit Gate

The **dual exit gate** (`dualExitGateCheck` in `src/verify.ts`) requires **both** the model signal AND machine verification to pass before a task is accepted as complete. It implements a 2×2 truth table:

| Model Signal | Machine Verification | Result |
|-------------|---------------------|--------|
| ✅ complete | ✅ all pass | `canComplete: true` |
| ✅ complete | ❌ some fail | `canComplete: false` — "Model claims complete but verification failed: ..." |
| ❌ incomplete | ✅ all pass | `canComplete: false` — "Verification passes but task not marked complete in PRD" |
| ❌ incomplete | ❌ some fail | `canComplete: false` — "Task not marked complete and verification failed: ..." |

In the orchestrator, `modelSignal` = `execResult.completed` (did Copilot finish?) and machine checks include at minimum `checkbox` (PRD checkbox ticked) and `diff` (file changes detected). When the gate rejects, the orchestrator feeds the `reason` string back as `additionalContext` and re-enters the task.

### 3. Stagnation Detection

Two complementary systems detect stagnation:

**a) `StagnationDetector` (src/stagnationDetector.ts)**: File-hash based. Takes SHA-256 snapshots of configured files (`progress.txt`, `PRD.md` by default) before each iteration. If all tracked files remain byte-identical across `maxStaleIterations` (default: 2) consecutive iterations, it flags stagnation.

The orchestrator applies a **3-tier escalation** on stagnation:

| Tier | Condition | Response |
|------|-----------|----------|
| 1 | `staleIterations >= threshold` | Inject enhanced nudge context |
| 2 | `staleIterations >= threshold + 1` | Emit `CircuitBreakerTripped` with action `skip` |
| 3 | `staleIterations >= threshold + 2` | Emit `HumanCheckpointRequested`, pause loop |

**b) `StruggleDetector` (src/struggleDetector.ts)**: Behavioral signal detector that tracks three independent signals:
- **no-progress**: Consecutive iterations with zero file changes (threshold: 3)
- **short-iteration**: Consecutive iterations completing under 30s (threshold: 3) — indicates the agent is spinning without doing real work
- **repeated-error**: Same normalized error appearing ≥2 times (uses `ErrorHashTracker`)

When any signal fires, the orchestrator injects "try a completely different approach" context.

### 4. Nudge System

Nudging occurs in a **while-loop inside the per-task execution** in `LoopOrchestrator.runLoop()`. When a task execution doesn't complete (`!waitResult.completed`), the orchestrator re-sends a continuation prompt up to `maxNudgesPerTask` (default: 3) times.

Key behaviors:
- **Productive reset**: If file changes are detected between nudges, `nudgeCount` resets to 0 and `consecutiveNudgesWithoutFileChanges` resets — the agent gets more chances while making progress.
- **Final nudge escalation**: `buildFinalNudgePrompt` fires when `nudgeCount >= maxNudges - 1`, injecting a "wrap it up NOW" message demanding partial commit.
- **Circuit breaker integration**: Before each nudge, the full circuit breaker chain is evaluated against current state. If tripped with action `stop`, the loop halts; if `skip`, it breaks out of the nudge loop.

### 5. Retry System

Retries handle **transient errors** (network, timeout, connection reset, etc.) during task execution:

- `shouldRetryError` in `src/decisions.ts` checks error messages against transient patterns and caps at `MAX_RETRIES_PER_TASK` (3).
- Circuit breaker chain is checked before each retry attempt.
- On successful retry, the task completes normally. If all retries exhaust, the error is logged and `TaskComplete` hook fires with `result: 'failure'`.

### 6. Graceful Yield

`requestYield()` sets `yieldRequested = true`. The flag is **not honored mid-task** — it's only checked:
1. After parallel task batches complete
2. After a successful task completion (post-commit, post-review)

This ensures the loop exits at a clean boundary — never mid-execution. On yield, `SessionPersistence` is cleared.

### 7. Auto-Decomposition

When a task fails `failThreshold` (default: 3) consecutive times, `AutoDecomposer` splits it into sub-tasks by detecting boundaries in the description (numbered steps, semicolons, sentences, or midpoint split). The original task line is marked `[DECOMPOSED]` and sub-tasks are injected below it in the PRD.

### 8. Confidence Scoring

After dual exit gate passes, a **weighted confidence score** is computed from verification checks:

| Check | Weight |
|-------|--------|
| `checkbox` | 100 |
| `vitest` | 20 |
| `tsc` | 20 |
| `diff` | 20 |
| `no_errors` | 10 |
| `progress_updated` | 10 |

Total possible: 180. If below `confidenceThreshold` (default: 100), the task is re-entered with context listing missing items. This acts as a **soft gate** on top of the hard dual exit gate.

---

## Patterns

### P1: Chain-of-Responsibility Circuit Breakers
Pure-function breakers with a shared state snapshot enable composition, independent testing, and runtime enable/disable without code changes. Each breaker returns an action (`continue`/`retry`/`skip`/`stop`) that the orchestrator interprets contextually.

### P2: Dual Gate (Model + Machine)
Never trust the model's self-assessment alone. Require independent machine verification (checkbox state, file diffs) as a second signal. This prevents premature task completion when the model hallucinates success.

### P3: Tiered Escalation
Stagnation uses 3 tiers (nudge → skip → human checkpoint). This avoids both over-eagerness (stopping too early) and runaway loops (continuing forever). Each tier applies proportional intervention.

### P4: Productive Activity Reset
Nudge counters reset when file changes are detected. This rewards productive work — an agent making real progress gets unlimited nudges, while an idle agent is capped.

### P5: Hash-Based Error Deduplication
Normalizing errors (strip ANSI, timestamps, line numbers, paths) and hashing prevents the same root cause from consuming all retry attempts with superficially different stack traces.

### P6: Graceful Boundary Yield
Yield is deferred to task completion boundaries. This ensures no half-finished work is left behind — the loop always exits at a commit point.

### P7: Final Nudge Escalation
The very last nudge before cap changes tone to "wrap it up NOW", demanding partial commit rather than graceful completion. This mirrors VS Code's search subagent `isLastTurn` pattern.

### P8: Auto-Decomposition on Repeated Failure
Tasks that fail N times are automatically split into sub-tasks, preventing infinite retries on overly complex tasks.

---

## Applicability

### For VS Code Copilot Chat Agent Mode
- **Dual exit gate** directly maps to the pattern where agent mode tools claim completion but verification (test runs, lint checks) should independently confirm.
- **Circuit breaker chain** could wrap around any autonomous tool-use loop to prevent runaway tool invocations.
- **Stagnation detection via file hashing** is lightweight and framework-agnostic — applicable wherever workspace files are the observable output.
- **Productive activity reset** for nudge counts prevents penalizing agents that are making real but slow progress.
- **Confidence scoring** provides a continuous quality metric that could feed into UI indicators or automatic quality gates.

### For Any Autonomous Agent Loop
- The tiered escalation pattern (nudge → circuit break → human checkpoint) is a reusable blueprint for bounded autonomy.
- Error hash deduplication prevents wasted compute on repeated identical failures.
- Auto-decomposition turns a stuck task into smaller actionable pieces — useful for any task runner.

---

## Open Questions

1. **Checkbox is 100 of 180 in confidence scoring** — this makes the PRD checkbox nearly mandatory. Is this intentional? Tasks that pass `tsc`, `vitest`, `diff`, `no_errors`, and `progress_updated` but miss the checkbox only score 80/180, below the default 100 threshold.

2. **StagnationBreaker vs StagnationDetector overlap**: The `StagnationBreaker` (circuit breaker) checks `consecutiveNudgesWithoutFileChanges`, while `StagnationDetector` hashes file contents. These track similar but not identical signals. Could they conflict or produce confusing cascading trips?

3. **ErrorRate and TimeBudget disabled by default** — are these considered experimental, or is there a design reason they're opt-in? The 10-minute time budget seems useful for cost control.

4. **No circuit breaker state sharing across tasks** — each task starts with a fresh `CircuitBreakerState` for nudge/retry counts. The only cross-task state is the `ErrorHashTracker` and `StagnationDetector`. Is there a scenario where cross-task cumulative fatigue should trigger a breaker?

5. **Retry only on transient errors** — the `shouldRetryError` function pattern-matches on network-like error messages. Deterministic failures (type errors, assertion failures) are never retried. Is there a case where a non-transient error should be retried after auto-decomposition?

6. **Yield clears session persistence** — when yield is honored, `SessionPersistence.clear()` is called. This means a yielded session cannot be resumed. Is this intentional, or should yield preserve state for later continuation?
