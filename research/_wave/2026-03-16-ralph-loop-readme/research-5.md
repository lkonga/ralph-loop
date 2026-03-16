## Research 5: Safety Mechanisms

### Findings

Ralph-loop implements a **layered safety architecture** with five dedicated modules working together to detect runaway loops, wasted effort, and invalid completions. All are instantiated and orchestrated inside `LoopOrchestrator` in [src/orchestrator.ts](src/orchestrator.ts).

---

#### 1. Circuit Breaker System (`src/circuitBreaker.ts`)

A **chain-of-responsibility** pattern where independent breakers are evaluated sequentially; the first to trip halts further checks.

| Breaker | Default | Trips when | Action |
|---|---|---|---|
| `MaxRetriesBreaker` | 3 retries | `retryCount >= max` | `stop` |
| `MaxNudgesBreaker` | 3 nudges | `nudgeCount >= max` | `stop` |
| `StagnationBreaker` | 2 consecutive | Nudges without file changes ≥ threshold | `skip` |
| `ErrorRateBreaker` | 60% over 5 | Sliding-window error rate > threshold | `stop` |
| `TimeBudgetBreaker` | 600s | Elapsed ms > budget | `skip` |
| `RepeatedErrorBreaker` | 3x same hash | Same normalized error appears ≥ threshold times | `skip` |
| `PlanRegenerationBreaker` | after 2 decomp failures | Post-decomposition failures ≥ threshold | `regenerate` |

**Key supporting classes:**
- `ErrorHashTracker` — normalises errors (strips ANSI, timestamps, paths, line numbers), MD5-hashes them, and tracks occurrence counts. Used by both `RepeatedErrorBreaker` and `StruggleDetector`.
- `PlanRegenerationTracker` — tracks decomposition state and regeneration count; caps regenerations (default 1).
- `CircuitBreakerChain` — evaluates all breakers in order, respects a `disabled` set. Created via `createDefaultChain()` factory.

**Default config:** Only `maxRetries`, `maxNudges`, and `stagnation` are enabled by default. The `bugfix` preset additionally enables `repeatedError` and `errorRate`.

**Actions vocabulary:** `continue | retry | skip | stop | nudge | regenerate`. The orchestrator maps these to concrete behaviours (stop loop, skip to next task, re-enter task, etc.).

---

#### 2. Stagnation Detector (`src/stagnationDetector.ts`)

File-hash based detection of zero progress across iterations.

- **Mechanism:** SHA-256 hashes a configurable set of files (default: `progress.txt`, `PRD.md`) before each task. Compares current vs previous snapshot. Increments `staleCount` when all tracked files are unchanged; resets on any change.
- **Config:** `StagnationDetectionConfig { enabled, maxStaleIterations (default 2), hashFiles }`.
- **Orchestrator integration — 3-tier escalation:**
  1. **Tier 1** (`staleIterations >= threshold`): Injects an enhanced nudge into `additionalContext` ("try a different approach").
  2. **Tier 2** (`staleIterations >= threshold + 1`): Fires a `CircuitBreakerTripped` event with action `skip`.
  3. **Tier 3** (`staleIterations >= threshold + 2`): Emits `HumanCheckpointRequested` and pauses the loop for human intervention.
- **AutoDecomposer** (co-located): Splits stuck tasks into sub-tasks at numbered-step, semicolon, or sentence boundaries. Writes `[DECOMPOSED]` marker and sub-task lines into the PRD.

---

#### 3. Struggle Detector (`src/struggleDetector.ts`)

Composite detector that aggregates four independent signals:

| Signal | Trigger condition |
|---|---|
| `no-progress` | ≥ 3 consecutive iterations with 0 file changes |
| `short-iteration` | ≥ 3 consecutive iterations completing in < 30s |
| `repeated-error` | Any error hash appearing ≥ 2x (via `ErrorHashTracker`) |
| `thrashing` | Same file+region edited ≥ 3x in a 10-edit window |

**Sub-components:**
- `ThrashingDetector` — maintains a sliding window of `{file, regionHash}` edits. Counts per key; flags thrashing when any key exceeds the repetition threshold.
- `BackpressureClassifier` — classifies loop state as `productive | stagnant | thrashing` by tracking `ConvergenceSnapshot` history (error count trends, test pass trends, unique error ratio). Thrashing detection delegates to `ThrashingDetector`.

**Orchestrator integration:** When `isStruggling()` returns true, the orchestrator injects guidance into `additionalContext` ("try a completely different approach") and emits `StruggleDetected` event with the active signal list.

---

#### 4. Diff Validator (`src/diffValidator.ts`)

Git-based validation that real code changes occurred.

- **Mechanism:** Runs `git diff --stat HEAD` and `git diff --name-only HEAD` (in parallel). Parses insertions/deletions from the stat summary line.
- **Config:** `DiffValidationConfig { enabled (true), requireChanges (true), maxDiffLines, generateSummary (true) }`.
- **Nudge generation:** When `requireChanges` is true and no diff exists, returns a nudge message.
- **State block:** `buildStateBlock()` produces a markdown summary (`### Task N State | Files: [...] | Lines: +X/-Y | Status: pass`) appended to `progress.txt`.
- **Orchestrator integration — retry loop with human escalation:**
  1. After task completion, validates diff.
  2. If no diff: emits `DiffValidationFailed`, re-enters the task with the nudge prompt.
  3. After `maxDiffValidationRetries` (configurable) failures: emits `HumanCheckpointRequested` and pauses loop.

---

#### 5. Consistency Checker (`src/consistencyChecker.ts`)

Post-task deterministic checks verifying PRD/progress/filesystem coherence.

Three built-in checks:
| Check | What it verifies |
|---|---|
| `checkbox_state` | Unchecked tasks exist during `in_progress` phase; all checked during `complete` phase |
| `progress_mtime` | `progress.txt` was modified within the last 5 minutes |
| `file_paths_exist` | All file paths mentioned in the task description actually exist in the workspace |

**Architecture:** `IConsistencyChecker` interface with two methods:
- `runDeterministic()` — executes the three filesystem checks above.
- `runLlmVerification()` — stub placeholder for future LLM-based semantic verification.

Two implementations:
- `DeterministicConsistencyChecker` — runs all three checks, returns aggregate pass/fail.
- `LlmConsistencyCheckerStub` — delegates deterministic to the real checker, stubs LLM verification as always-pass.

**Orchestrator integration:** After a task completes (post dual-exit-gate), runs `runDeterministic()`. Emits either `ConsistencyCheckPassed` or `ConsistencyCheckFailed` event. Failures are logged but do not currently block progression.

---

#### 6. Additional Safety Mechanisms (in orchestrator)

- **Dual Exit Gate** (`verify.ts`): Requires BOTH model signal (checkbox marked) AND machine verification (file changes detected) before accepting task completion.
- **Confidence Scoring** (`verify.ts`): Computes a numeric score from multiple checks (checkbox, vitest, tsc, no_errors, progress_updated, diff). Tasks below threshold get re-entered with feedback.
- **Bearings (pre-flight check)**: Runs `tsc --noEmit` and `vitest run` before each task. If unhealthy, injects a fix task; if fix fails, pauses for human.
- **Human Checkpoint Requests**: Multiple mechanisms can trigger pause-for-human: stagnation tier 3, diff validation exhaustion, bearings double-failure.
- **Cooldown Dialog**: Between tasks, shows a countdown dialog allowing the operator to intervene.
- **Iteration Limits**: Soft limit (`maxIterations`, auto-expands 1.5x once) and hard limit (`hardMaxIterations`).
- **Linked Cancellation**: Combines manual stop signal + timeout signal via `AbortController`.

### Patterns

1. **Defense in Depth**: Multiple independent detectors (circuit breakers, stagnation, struggle, diff, consistency) each catch different failure modes. A single runaway scenario is likely caught by at least two systems.

2. **Graduated Escalation**: Most detectors follow a tier pattern: nudge → circuit breaker skip → human checkpoint. This avoids premature termination while preventing infinite loops.

3. **Composable Chain of Responsibility**: Circuit breakers are composable pure functions assembled into a chain. Presets (`bugfix`, `refactor`) toggle different breaker subsets. The disabled set allows runtime configuration.

4. **Hash-Based Deduplication**: Error normalisation (strip ANSI, timestamps, paths, line numbers) + MD5 hashing prevents the same error from consuming retry budget repeatedly.

5. **Sliding Window Analysis**: Both `ErrorRateBreaker` (last N errors) and `ThrashingDetector` (last N edits) use fixed-size sliding windows to detect recent patterns without unbounded memory.

6. **Event-Driven Observability**: Every safety mechanism emits typed `LoopEvent` variants (`CircuitBreakerTripped`, `StagnationDetected`, `StruggleDetected`, `DiffValidationFailed`, `ConsistencyCheckPassed/Failed`, `HumanCheckpointRequested`), enabling UI and logging to surface safety state.

7. **Preset-Driven Profiles**: Safety tuning varies by task type — `bugfix` enables aggressive error tracking; `refactor` raises stagnation tolerance.

### Applicability

- **README documentation**: The safety system is a major differentiator and should be prominently documented. Key points: 7 circuit breaker types, 4 struggle signals, 3-tier stagnation escalation, git-based diff validation, filesystem consistency checks.
- **Architecture diagrams**: A safety layer diagram showing how these modules interact with the orchestrator loop would be valuable.
- **Configuration reference**: Each mechanism has typed config with sensible defaults — the README should reference the preset system and per-mechanism config knobs.
- **Comparison with alternatives**: Most agentic loop tools lack this many safety layers; this is a competitive advantage worth highlighting.

### Open Questions

1. **LLM verification stub**: `runLlmVerification()` is stubbed to always pass. Is there a plan to implement semantic verification (e.g., asking the LLM to verify its own work)?
2. **BackpressureClassifier usage**: The `BackpressureClassifier` class exists in `struggleDetector.ts` but its integration point in the orchestrator is unclear — it may not be wired in yet.
3. **Thrashing region hashes**: `ThrashingDetector.recordEdit()` requires a `regionHash` parameter, but the orchestrator doesn't appear to call `recordEdit()` — only `recordIteration()`. Is thrashing detection for file regions actually active?
4. **Consistency check impact**: Failed consistency checks emit events but don't block task progression or trigger retries. Should they?
5. **Error signal feeding**: The orchestrator passes empty arrays `[]` to `struggleDetector.recordIteration()` for errors. Are actual error strings meant to be captured from execution output?
6. **PlanRegeneration flow**: The breaker exists but is disabled by default and the orchestrator's handling of the `regenerate` action isn't visible in the main loop. Is it wired through a separate code path?
