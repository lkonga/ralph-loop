# Research-4: Orchestrator Main Loop & Baseline Test Verification

## Question
How does the orchestrator's main loop start, and where does baseline test verification happen relative to task execution?

---

## 1. Class Construction (`LoopOrchestrator` — line 309)

The `LoopOrchestrator` class is defined at line 309 of `src/orchestrator.ts`. Its constructor (line 337) accepts:
- `config: RalphConfig` — full configuration including workspace root, bearings config, iteration limits
- `logger: ILogger`
- `onEvent: (event: LoopEvent) => void` — event emitter callback
- `hookService?: IRalphHookService` — optional hook integration
- `consistencyChecker?: IConsistencyChecker`

Constructor initializes:
- Execution strategy (CopilotCommand or DirectAPI, based on `config.executionStrategy`)
- Circuit breaker chain and error hash tracker
- Session persistence (enabled by default, 24h expiry)
- State is set to `LoopState.Idle`

No bearings or tests are run during construction.

---

## 2. Entry Point: `start()` Method (line 399)

```
async start(): Promise<void>
```

1. Guards against double-start (`if state === Running, return`)
2. Sets state to `Running`, clears stop/pause/yield flags
3. Creates fresh `AbortController`
4. Iterates `for await (const event of this.runLoop())` — forwards events to `onEvent`
5. On terminal events (`Stopped`, `AllDone`, `MaxIterations`, `YieldRequested`), clears session persistence and breaks
6. `finally` block calls `cleanup()` and resets state to `Idle`

---

## 3. The Generator: `runLoop()` (line ~527)

This is a `private async *runLoop(): AsyncGenerator<LoopEvent>` — the actual loop body.

### 3a. Pre-loop Initialization (lines 527–600)

Before the `while(true)` loop, the following are set up:

| Step | Lines | Purpose |
|------|-------|---------|
| Linked cancellation signal | ~533 | Combines manual stop + timeout signals |
| Stagnation detector | ~538 | Optional, based on config |
| Auto-decomposer | ~543 | Optional |
| **`bearingsFixAttempted = false`** | ~547 | Tracks if a bearings-fix task was injected |
| **`skipBearingsOnce = false`** | ~548 | Flag to skip bearings after injecting fix task |
| **`startupBearingsDone = false`** | ~549 | **KEY FLAG** — controls startup vs per-task bearings level |
| Verification cache | ~550 | Caches bearings results by git tree hash |
| Knowledge manager | ~553 | Optional learning extraction |
| Struggle detector | ~559 | Optional struggle detection |
| SessionStart hook | ~573 | Fires `onSessionStart`, may inject context or stop |
| **PRD validation** | ~582 | Pre-flight check that PRD is valid; **aborts if invalid** |

### 3b. Main Loop Entry: `while(true)` (line ~596)

Each iteration:

1. **Stop check** — abort if signal is aborted or stop requested
2. **Pause handling** — spin-wait with 1s delay while paused
3. **Circuit breaker** — check before next iteration
4. **Iteration limit check** — auto-expand once by 1.5x if tasks remain
5. **Parse PRD, pick next task(s)** — reads PRD snapshot
6. **Parallel task path** — if `useParallelTasks` && `maxParallelTasks > 1`, picks multiple ready tasks via DAG
7. **Single task path** — `pickNextTask(snapshot)`
8. **Skip completed tasks** — if task.id is in `completedTasks` set
9. **Checkpoint gate** — if `task.checkpoint`, runs checkpoint-level bearings then pauses for human review

---

## 4. Bearings (Baseline Verification) — The Critical Section (lines 830–894)

### Startup vs Per-Task Bearings

The bearings system uses a **stage-aware level selector**:

```typescript
const bearingsLevel = !startupBearingsDone
    ? (bearingsConfig.startup ?? 'tsc')        // First iteration: 'tsc' by default
    : (bearingsConfig.perTask ?? 'none');       // Subsequent: 'none' by default
```

**Default config** (`DEFAULT_BEARINGS_CONFIG`, types.ts line 324):
- `enabled: true`
- `startup: 'tsc'` — TypeScript compilation check on first pass
- `perTask: 'none'` — no checks between tasks by default
- `checkpoint: 'full'` — full tsc + vitest at checkpoint tasks

### What `runBearings()` Does (line 156)

The standalone `runBearings()` function (line 156–212) executes:

1. **tsc check** (if level is `'tsc'` or `'full'`):
   - Looks for `tsconfig.json`
   - Runs `npx tsc --noEmit`
   - Collects first 500 chars of errors if non-zero exit

2. **vitest check** (if level is `'full'`):
   - Looks for `vite.config.ts`, `vitest.config.ts`, or `vitest.config.js`
   - Runs `npx vitest run`
   - Collects first 500 chars of failures if non-zero exit

Returns `{ healthy: boolean, issues: string[], fixTask?: string }`

### Bearings Flow in the Loop (lines 830–894)

```
if bearings enabled AND NOT skipBearingsOnce:
    bearingsLevel = startupBearingsDone ? perTask : startup
    if bearingsLevel != 'none':
        Check verification cache (git branch + tree hash + file hashes)
        if cache hit:
            → BearingsSkipped event
            → BearingsChecked(healthy: true)
        else:
            → BearingsStarted event
            → runBearings(workspaceRoot, ...)
            → BearingsCompleted event
            → BearingsChecked event

            if healthy:
                Save to verification cache
            if NOT healthy:
                Clear cache
                if bearingsFixAttempted already:
                    → BearingsFailed event
                    → PAUSE (human intervention)
                    continue  ← goes back to while(true), does NOT start task
                else:
                    bearingsFixAttempted = true
                    skipBearingsOnce = true
                    Inject fix task line into PRD:
                      "- [ ] Fix baseline: resolve TypeScript errors..."
                    continue  ← re-enters loop, picks up injected fix task

    startupBearingsDone = true   ← SET AFTER FIRST BEARINGS PASS
```

### The Exact Seam: "After Baseline Passes, Before First Task Work" (line ~897)

After bearings completes successfully (or is skipped), execution falls through to:

```typescript
// LINE ~897
iteration++;
task.status = TaskStatus.InProgress;
this._currentTaskId = task.taskId;
this._currentTaskDescription = task.description;
this._currentIteration = iteration;
this._currentNudgeCount = 0;
const taskInvocationId = crypto.randomUUID();
yield { kind: LoopEventKind.TaskStarted, task, iteration, taskInvocationId };
```

**This is the exact insertion point** — right after the bearings block ends (line ~894, where `startupBearingsDone` is set) and right before `iteration++` (line ~897).

---

## 5. Complete Sequence Map

```
start()
  └─ runLoop() generator
       ├─ 1. Linked cancellation setup
       ├─ 2. Detector/decomposer/cache init
       ├─ 3. SessionStart hook
       ├─ 4. PRD validation (abort if invalid)
       └─ while(true):
            ├─ 5. Stop/pause/circuit-breaker checks
            ├─ 6. Iteration limit check (auto-expand)
            ├─ 7. Parse PRD → pickNextTask()
            ├─ 8. Skip completed tasks
            ├─ 9. Checkpoint gate (if task.checkpoint)
            ├─ 10. ★ BEARINGS ★ (baseline verification)
            │       ├─ First time: startup level ('tsc')
            │       ├─ Subsequent: perTask level ('none')
            │       ├─ If unhealthy + first attempt → inject fix task, continue
            │       └─ If unhealthy + second attempt → pause for human
            │
            │   ← ★ INSERTION POINT ★ (line ~897)
            │   ← After bearings, before iteration++ and TaskStarted
            │
            ├─ 11. iteration++, TaskStarted event
            ├─ 12. Build prompt (PRD + progress + knowledge + context)
            ├─ 13. Execute via strategy
            ├─ 14. Nudge loop (if not completed)
            ├─ 15. Stagnation/struggle detection
            ├─ 16. Dual exit gate (checkbox + diff)
            ├─ 17. Verification (review, pre-complete hooks)
            ├─ 18. Atomic git commit
            └─ 19. Countdown → next iteration
```

---

## 6. Key Findings for Feature Branch Enforcement

1. **No git branch check exists anywhere in the startup or bearings flow.** The bearings system checks `tsc` and `vitest` only — not git state.

2. **The `VerificationCache` already reads git branch** via `VerificationCache.getGitBranch(workspaceRoot)` at line ~839, but only for cache key purposes — it never validates it.

3. **The natural insertion point for a branch check** is at line ~897, between the bearings block (line ~894) and `iteration++` (line ~897). At this point:
   - PRD is validated
   - Bearings have passed (or been skipped)
   - The first task has been picked but not yet started
   - The `startupBearingsDone` flag is about to be or has just been set to `true`

4. **Alternative insertion**: Inside `runBearings()` itself (line ~156) as a new check alongside tsc/vitest, but this would couple branch enforcement to the bearings level system, which may not be desired (e.g., `perTask: 'none'` would skip it).

5. **Best insertion point**: A new block at line ~897, immediately after bearings ends and before `iteration++`, as a **startup-only guard** gated by `!startupBearingsDone` (checked before it's set to `true`) or a new flag like `branchCheckDone`. This ensures:
   - Runs exactly once at startup
   - Independent of bearings level config
   - Can emit its own event (e.g., `LoopEventKind.BranchCheckFailed`)
   - Can pause/stop the loop or emit a warning
