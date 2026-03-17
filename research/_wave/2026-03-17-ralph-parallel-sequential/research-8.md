# Research 8: Sequential Happy Path End-to-End

**Question**: Sequential mode happy path: Define ONE robust working sequential path end-to-end. What is the actual flow from PRD parse → task pick → prompt build → execute → verify → mark complete → next task?

## Findings

### Complete Sequential Happy Path (Numbered Steps)

The sequential path lives entirely inside `LoopOrchestrator.runLoop()` in [src/orchestrator.ts](../../../src/orchestrator.ts). The generator starts at L392 and the single-task sequential path begins at L598 (after parallel-task branching is skipped/fallen-through).

---

#### Step 0: Loop Entry — `start()` → `runLoop()`
- **File**: `src/orchestrator.ts` L286–312
- `start()` sets `state = Running`, resets `stopRequested`, creates `AbortController`.
- Calls `for await (const event of this.runLoop())` and dispatches events.
- Terminal events (`Stopped`, `AllDone`, `MaxIterations`, `YieldRequested`) break the loop.

#### Step 1: PRD Parse
- **File**: `src/prd.ts` L27–89 (`parsePrd`), L92–94 (`readPrdSnapshot`)
- **Orchestrator call**: `src/orchestrator.ts` L528 — `const snapshot = readPrdSnapshot(prdPath);`
- `readPrdSnapshot(prdPath)` reads the PRD file, calls `parsePrd(content)`.
- `parsePrd` scans every line for markdown checkboxes:
  - `- [ ] description` → `TaskStatus.Pending`
  - `- [x] description` → `TaskStatus.Complete`
  - Lines with `[DECOMPOSED]` are skipped.
  - Assigns sequential `taskId` like `Task-001`, `Task-002`, etc.
  - Infers parent dependencies from indentation (second pass).
- Returns `PrdSnapshot { tasks, total, completed, remaining }`.

#### Step 2: Task Pick
- **File**: `src/prd.ts` L96–98 (`pickNextTask`)
- **Orchestrator call**: `src/orchestrator.ts` L598 — `const task = pickNextTask(snapshot);`
- `pickNextTask` is trivially simple: `snapshot.tasks.find(t => t.status === TaskStatus.Pending)` — first pending task wins.
- If no task found → yields `AllDone` event → loop returns.
- If task is already in `completedTasks` set → `continue` (skip, re-pick).

#### Step 3: Pre-flight Gates (Checkpoint + Bearings)
- **Orchestrator**: L610–636 (checkpoint), L642–666 (bearings)
- **Checkpoint gate**: If `task.checkpoint === true`, the loop immediately pauses for human review. Task is marked complete only after human resumes — no agent execution occurs.
- **Bearings gate**: Runs `runBearings()` (L103–126) which executes `npx tsc --noEmit` and `npx vitest run`. If unhealthy, injects a `- [ ] Fix baseline...` task at PRD top and retries. If fix was already attempted and still unhealthy → pauses for human.

#### Step 4: Prompt Build
- **File**: `src/prompt.ts` L297–400+ (`buildPrompt`), `src/orchestrator.ts` L680–695
- Reads PRD content: `readPrdFile(prdPath)` (same file, re-read for freshness).
- Reads progress file: `fs.readFileSync(progressPath)` (may not exist yet).
- Fetches relevant learnings from `KnowledgeManager` if enabled.
- Consumes any `operatorContext` injected mid-loop.
- Calls `buildPrompt(task.description, prdContent, progressContent, 20, promptBlocks, capabilities, learnings, iteration, ctConfig, operatorContext, taskId, undefined, workspaceRoot)`.
- `buildPrompt` internally:
  1. Sanitizes task description (strips control chars, prompt injection tags, truncates to 5000 chars) — `sanitizeTaskDescription` L33–43.
  2. Applies context trimming tiers based on iteration number (full → abbreviated → minimal).
  3. Assembles structured prompt sections: TASK, ROLE & BEHAVIOR, TDD GATE, SEARCH-BEFORE-IMPLEMENT, SPEC REFERENCE, model hints, capabilities, learnings, operator context.
  4. Appends mandatory update instructions (mark checkbox, update progress.txt, commit).
  5. Optionally annotates token budget warning via `annotateBudget`.
- Any `additionalContext` from hooks/struggle/stagnation is appended after `buildPrompt` returns (L695–698).

#### Step 5: Execute via Strategy
- **File**: `src/strategies.ts` L12–26 (`CopilotCommandStrategy.execute`), `src/orchestrator.ts` L714–720
- Monitor is started first: `startMonitor()` tracks PRD mtime, progress file size, checkbox count — detects stuck tasks.
- `CopilotCommandStrategy.execute(task, prompt, executionOptions)`:
  1. `startFreshChatSession()` — tries `workbench.action.chat.newEditSession` then `workbench.action.chat.newChat`.
  2. `openCopilotWithPrompt(prompt)` — 3-level fallback: agent mode → chat panel → clipboard.
  3. `waitForCompletion()` — watches PRD file and workspace files via `vscode.FileSystemWatcher`:
     - On PRD change: runs `verifyTaskCompletion()` → if checkbox is ticked, resolves `true`.
     - On any workspace file change: resets inactivity timer, marks `hadFileChanges = true`.
     - Inactivity timeout expires → resolves `false`.
     - 5-second poll interval also checks via `verifyTaskCompletion`.
- Monitor is stopped after execution returns.

#### Step 6: Nudge Loop (if timed out)
- **File**: `src/orchestrator.ts` L724–764
- If `waitResult.completed === false` and `nudgeCount < maxNudgesPerTask`:
  - Circuit breaker is checked before each nudge.
  - If file changes occurred, nudge count resets to 0 (productive progress detected).
  - Builds a nudge prompt with continuation suffix or `buildFinalNudgePrompt` (if last nudge).
  - Re-executes via strategy with the nudge prompt.
  - Loop continues until completed or nudges exhausted.

#### Step 7: Dual Exit Gate Verification
- **File**: `src/verify.ts` L188–219 (`dualExitGateCheck`), `src/orchestrator.ts` L813–824
- After execution + nudges, TWO checks are evaluated:
  1. **Checkbox check**: Re-reads PRD snapshot, checks if task's status is `Complete`.
  2. **Diff check**: Did `hadFileChanges` occur during execution?
- `dualExitGateCheck(modelSignal=waitResult.completed, machineVerification=[checkbox, diff])`:
  - Both must pass → `canComplete: true`.
  - Model says done but machine fails → `canComplete: false`, reason injected as `additionalContext`, loop continues.
  - Model didn't signal but machine passes → also `canComplete: false`.

#### Step 8: Mark Complete + Post-Completion Gates
- **File**: `src/orchestrator.ts` L826–960
- On `gateResult.canComplete === true`:
  1. `completedTasks.add(task.id)` — latch to prevent re-execution.
  2. `appendProgress(progressPath, ...)` — appends timestamped completion entry to progress.txt.
  3. Yields `TaskCompleted` event.
  4. **Knowledge extraction**: If enabled, scans progress for learnings/gaps and persists to knowledge.md.
  5. **Consistency check**: If `consistencyChecker` exists, runs deterministic post-task validation.
  6. **Diff validation** (L870–930): If enabled, runs `DiffValidator.validateDiff()` to confirm actual code changes. If no diff, retries with nudge up to `maxDiffValidationRetries`, then requests human checkpoint.
  7. **Confidence scoring** (L932–960): Computes weighted score (checkbox=100, vitest=20, tsc=20, diff=20, no_errors=10, progress_updated=10). If score < threshold, deletes from `completedTasks` and re-enters (loop continues).
  8. **PreComplete hook chain** (L962–975): Runs configured hooks; `retry` or `stop` actions respected.
  9. **TaskComplete hook** (L977–990): External hook script execution.
  10. **Review-after-execute** (L992–1005): If enabled, sends review prompt to Copilot, parses verdict. `needs-retry` causes re-entry.
  11. **Atomic git commit** (L1007–1015): `atomicCommit()` does `git add -A`, `git commit -m ...`, captures hash.

#### Step 9: Next Task Transition
- **File**: `src/orchestrator.ts` L1130–1175
- If `yieldRequested` → yields `YieldRequested` and returns.
- Otherwise, **cooldown dialog** is shown (if configured): user can pause, stop, edit (inject context), or continue.
- If dialog disabled: simple countdown timer (`countdownSeconds` × 1 second sleep).
- **Session state saved** via `SessionPersistence.save()` (L1170).
- Loop continues → back to Step 1 (PRD parse).

---

### Failure Paths from the Happy Path

| Failure Point | What Happens | Recovery |
|---|---|---|
| Step 5: Strategy throws | Retry loop (up to `MAX_RETRIES_PER_TASK=3`) for transient errors | Error logged, TaskComplete hook called with `failure` |
| Step 6: All nudges exhausted | Falls through to dual gate (Step 7) which will likely fail | Task marked timed out, auto-decompose may trigger |
| Step 7: Gate rejects | `additionalContext` injected, `completedTasks.delete()`, loop re-enters task | May eventually stagnate → stagnation detector fires |
| Step 8: Confidence too low | `completedTasks.delete()`, feedback injected, continue | Re-enters task with diagnostic context |
| Step 8: Review says NEEDS-RETRY | `completedTasks.delete()`, continue | Re-enters task |
| Step 8: atomicCommit fails | Warning logged, error event emitted, but loop continues | Non-fatal — task is still considered done |

## Patterns

1. **Generator-based event loop**: `runLoop()` is an `AsyncGenerator<LoopEvent>` — each step yields events consumed by `start()`. This enables clean separation between orchestration logic and UI/telemetry.

2. **Latch-based idempotency**: `completedTasks` Set prevents re-executing tasks already marked done, even if PRD re-parsing would find them pending again.

3. **Layered verification**: Task completion goes through 4+ verification layers: dual exit gate → diff validation → confidence scoring → pre-complete hooks → review. Each layer can force re-entry.

4. **Nudge-with-reset**: File changes during a nudge reset the nudge counter, allowing indefinite execution as long as the agent is making productive progress.

5. **Mark-complete is agent-driven**: The agent is expected to mark the checkbox in PRD.md itself. Ralph monitors for this via `FileSystemWatcher`. Ralph also calls `markTaskComplete` in some paths (checkpoints) but the normal happy path relies on the agent's action.

6. **Re-entry via `continue`**: When any post-completion gate fails, the task is removed from `completedTasks` and the `while(true)` loop body continues — re-picking the same task from PRD since it's still unchecked.

## Gaps/Concerns

1. **`pickNextTask` ignores dependencies**: Unlike `pickReadyTasks` (used in parallel mode), `pickNextTask` simply returns the first pending task with no dependency awareness. A task with unmet dependencies will be picked and attempted anyway in sequential mode.

2. **Dual gate checkbox + diff is incomplete**: The only "machine verification" checks are (a) PRD checkbox ticked and (b) file changes existed. There's no actual test execution or tsc check at the gate — those checks (vitest, tsc) only appear in the confidence scoring step, and even there they're **hardcoded to `VerifyResult.Pass`** (L940–942) rather than actually run. This means confidence scoring is a paper check in the happy path.

3. **`markTaskComplete` in prd.ts is not called in the happy path**: The sequential happy path relies on the **agent** to mark the checkbox. `markTaskComplete()` is only called directly for checkpoint tasks (L636). If the agent fails to mark the checkbox but makes real changes, the dual gate will reject repeatedly.

4. **No explicit task-level timeout**: The only timeout is `inactivityTimeoutMs` (no file changes for N ms). A task that continuously changes files but never completes will run indefinitely, bounded only by the nudge limit and iteration limit.

5. **Bearings fix task may confuse ordering**: When bearings fail, a fix task is prepended to PRD as raw text (`- [ ] Fix baseline: ...`). This mutates the PRD mid-loop, and `pickNextTask` will pick this inserted task next. After the fix attempt, bearings re-check may still fail → loop pauses. This is a fragile insertion mechanism.

6. **atomicCommit uses `--no-verify`**: The git commit in `atomicCommit` (gitOps.ts L87) bypasses git hooks with `--no-verify`, which could skip important pre-commit hooks in projects that use them.

## Open Questions

1. **Why doesn't sequential mode use `pickReadyTasks` for dependency awareness?** Is this intentional (assume PRD is ordered correctly) or an oversight?

2. **Why are vitest/tsc checks in confidence scoring hardcoded to Pass?** Is there a plan to wire them to actual execution, or is this deferred to the bearings phase?

3. **What happens if the agent marks the checkbox but doesn't update progress.txt?** The dual gate doesn't check progress.txt — only the confidence scoring's `progress_updated` check catches this, and only if the threshold is set to require it.

4. **Is `--no-verify` on atomicCommit intentional?** Does the project assume no pre-commit hooks, or is this a safety trade-off for automation speed?

5. **How does session persistence interact with crash recovery?** `SessionPersistence.save()` records state after each iteration, but is it loaded on restart to resume mid-loop?
