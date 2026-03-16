## Research 2: Orchestrator Loop Architecture

### Findings

#### Core Class: `LoopOrchestrator` (src/orchestrator.ts)

The orchestrator is a stateful class with three states: `Idle`, `Running`, `Paused`. It is the central execution engine for ralph-loop.

**Lifecycle:**
1. `start()` — Sets state to `Running`, resets stop/pause flags, creates an `AbortController`, and enters a `for await` loop consuming events from the `runLoop()` async generator. Terminates on `Stopped`, `AllDone`, `MaxIterations`, or `YieldRequested`.
2. `stop()` — Sets `stopRequested = true` and aborts the controller.
3. `pause()` / `resume()` — Toggles `pauseRequested`; the inner loop polls with `delay(1000)` while paused.
4. `requestYield()` — Deferred yield; honored only after the current task completes (autopilot pattern).

**Constructor Dependencies:**
- `RalphConfig` — all tuning knobs (iteration limits, timeouts, nudge counts, feature flags)
- `ILogger` — output logging
- `onEvent` callback — receives every `LoopEvent` (30+ event kinds)
- Optional `IRalphHookService` and `IConsistencyChecker`

Internally constructs: execution strategy (`CopilotCommandStrategy` or `DirectApiStrategy`), circuit breaker chain, error hash tracker, and optional session persistence.

#### The `runLoop()` Async Generator — Main Execution Cycle

The heart of the system. It is an `AsyncGenerator<LoopEvent>` containing a `while(true)` loop with the following phases per iteration:

**Phase 0 — Initialization (before loop):**
- Resolve PRD and progress file paths
- Create a `LinkedCancellationSource` combining manual stop + timeout signals
- Initialize detectors: `StagnationDetector`, `AutoDecomposer`, `StruggleDetector`, `KnowledgeManager`
- Run `onSessionStart` hook; if hook returns `stop`, yield `Stopped` and exit

**Phase 1 — Guard checks (top of while-loop):**
- Check abort signal / `stopRequested` → yield `Stopped`
- Poll `pauseRequested` → enter pause loop (1s delay)
- Circuit breaker pre-check on elapsed time
- Iteration limit check with **auto-expand**: if tasks remain and limit not yet expanded, increases by 50% (capped at `hardMaxIterations`)

**Phase 2 — Task selection:**
- Parse PRD.md via `readPrdSnapshot()` (checkbox-based task list)
- **Parallel path**: if `useParallelTasks` enabled and `maxParallelTasks > 1`, use DAG-aware `pickReadyTasks()` with concurrency cap. Runs tasks via `Promise.all`, each getting its own prompt + execution + atomic git commit. After batch completes, countdown then `continue`.
- **Single-task path**: `pickNextTask()` selects the first pending, non-completed task. If none remain → yield `AllDone`.

**Phase 3 — Bearings (pre-flight health check):**
- If `bearings.enabled`, runs `tsc --noEmit` and `vitest run` via `runBearings()`.
- If unhealthy and no prior fix attempt: injects a "Fix baseline" task at top of PRD and retries.
- If unhealthy after fix attempt: pauses loop (human intervention needed).

**Phase 4 — Task execution:**
- Generates a `taskInvocationId` (UUID)
- Takes a stagnation snapshot
- Builds prompt with: task description, PRD content, progress tail, knowledge learnings, operator-injected context, iteration number
- Starts a parallel monitor (file mtime/size/checkbox polling) to detect stuck tasks
- Executes via `ITaskExecutionStrategy.execute()` — either `CopilotCommandStrategy` (VS Code commands: agent mode → chat → clipboard fallback) or `DirectApiStrategy`

**Phase 5 — Nudge loop:**
- If execution times out (not completed), sends increasingly urgent continuation prompts
- Resets nudge count on productive file changes (adaptive)
- Circuit breaker checks before each nudge
- Max `maxNudgesPerTask` attempts

**Phase 6 — Post-execution evaluation:**
- **Stagnation detection**: 3-tier escalation (inject context → circuit breaker → human checkpoint)
- **Struggle detection**: records iteration duration/file changes, detects thrashing patterns
- **Dual exit gate**: requires BOTH model signal (Copilot says done) AND machine verification (checkbox ticked + file changes detected)

**Phase 7 — Completion pipeline (if dual gate passes):**
1. Confidence scoring — weighted `computeConfidenceScore()` across checkbox, vitest, tsc, no_errors, progress_updated. If below threshold, re-enters task with feedback.
2. PreComplete hook chain — sequential hooks with retry/stop/continue semantics
3. TaskComplete hook
4. Review-after-execute — optional LLM review with APPROVED/NEEDS-RETRY verdict
5. Atomic git commit per task
6. Deferred yield honored here

**Phase 8 — Failure path (if dual gate fails or timeout):**
- Auto-decomposition: after N consecutive failures, splits task into sub-tasks in PRD
- TaskComplete hook (failure variant)
- Error retry loop for transient errors (network/timeout), max 3 retries

**Phase 9 — Cooldown:**
- Optional cooldown dialog (pause/stop/edit/continue)
- Or simple countdown timer between tasks
- Session state persisted after each iteration

#### Extension Entry Point (src/extension.ts)

- Registers VS Code commands: `ralph-loop.start`, `ralph-loop.stop`, `ralph-loop.pause`, etc.
- Resolves workspace root by finding `PRD.md`
- Loads config from VS Code settings via `loadConfig()`
- Instantiates `LoopOrchestrator` with event handler that logs + updates status bar
- Optionally registers hook bridge (proposed `chat.hooks` API) and session tracking (polling `activeChatPanelSessionResource`)

#### Execution Strategies (src/strategies.ts)

- `CopilotCommandStrategy`: starts fresh chat session → sends prompt via VS Code commands (agent mode → chat → clipboard) → watches PRD file for checkbox changes with inactivity timeout
- `DirectApiStrategy`: direct Language Model API integration

#### Supporting Subsystems

| Subsystem | File | Role |
|-----------|------|------|
| Circuit Breakers | `circuitBreaker.ts` | Chain of breakers: MaxRetries, MaxNudges, Stagnation, ErrorHash, WallClock |
| Stagnation Detector | `stagnationDetector.ts` | File-hash based stale iteration detection + auto-decomposition |
| Struggle Detector | `struggleDetector.ts` | Short-iteration + thrashing pattern detection |
| Diff Validator | `diffValidator.ts` | Post-task git diff verification with retry/escalation |
| Verify | `verify.ts` | Confidence scoring, dual exit gate, verification feedback |
| Knowledge Manager | `knowledge.ts` | Extracts/persists learnings from task outputs, injects relevant context |
| Session Persistence | `sessionPersistence.ts` | Saves/restores loop state across restarts |
| PRD Parser | `prd.ts` | Checkbox-based task parsing with DAG dependency inference from indentation |
| Decisions | `decisions.ts` | Pure-function loop/nudge/retry decision logic |
| Git Ops | `gitOps.ts` | Atomic commits per task |
| Prompt Builder | `prompt.ts` | Builds prompts with context trimming, model hint, prompt blocks |

### Patterns

1. **Async Generator Pattern**: The entire loop is an `AsyncGenerator<LoopEvent>` — the caller consumes events via `for await`, enabling clean separation between loop logic and side effects (UI updates, logging).

2. **Dual Exit Gate**: Completion requires BOTH model self-report AND machine verification (checkbox + diff). Prevents premature task completion.

3. **Tiered Escalation**: Problems escalate through layers: inject context → circuit breaker → auto-decompose → human checkpoint. Multiple independent detectors (stagnation, struggle, circuit breakers) feed into this.

4. **Adaptive Nudging**: Nudge count resets on productive file changes, avoiding premature abandonment of tasks making actual progress.

5. **Strategy Pattern**: `ITaskExecutionStrategy` abstracts the Copilot interaction method, allowing command-based and API-based approaches.

6. **Hook Service Pattern**: `IRalphHookService` with NoOp default — session start, pre-compact, post-tool-use, pre-complete, task-complete hooks for extensibility.

7. **PRD-as-State**: The PRD.md file IS the task queue. Checkbox status is the completion signal. The orchestrator reads/parses it each iteration, and Copilot modifies it during execution.

8. **Linked Cancellation**: Combines manual stop signal + wall-clock timeout into a single `AbortSignal` for clean shutdown.

### Applicability

- The orchestrator architecture is well-suited to documenting in a README because it has clear phases, clean event-driven boundaries, and a predictable lifecycle.
- Key configuration knobs (`maxIterations`, `maxNudgesPerTask`, `countdownSeconds`, `inactivityTimeoutMs`, feature flags) are user-facing and should be documented with their defaults.
- The dual exit gate and confidence scoring are differentiating features worth highlighting.
- The PRD-as-state-machine concept is central to understanding the system and should be prominent in any overview.

### Open Questions

1. **DirectApiStrategy implementation**: The `DirectApiStrategy` class exists but its full implementation details weren't examined — how does it differ in completion detection from the command-based strategy?
2. **Hook bridge specifics**: The `registerHookBridge` function uses proposed VS Code APIs (`chat.hooks`) — what exact hooks does it intercept and how does it feed back into the orchestrator?
3. **Session tracking edge cases**: When `activeChatPanelSessionResource` changes, the loop pauses — is there an automatic resume mechanism or does it require user intervention?
4. **Context trimming**: The `contextTrimming` config is passed to `buildPrompt` — what is the trimming strategy and how does it interact with the knowledge manager's injected learnings?
5. **Cooldown dialog UX**: The `showCooldownDialog` function returns `pause | stop | edit | timeout` — how does the "edit" flow interact with the next iteration's context injection?
