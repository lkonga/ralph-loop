# Research Report 4: Completion Detection — ralph-loop vs. Copilot Autopilot

**Wave**: 2026-03-16-ralph-deep-verification
**Question**: Does ralph-loop implement a binary `task_complete` tool like Copilot autopilot? Compare what ralph adds on top of Copilot's patterns.
**Date**: 2026-03-16

---

## 1. Executive Summary

Ralph-loop does **NOT** implement its own `task_complete` tool. Instead, it **delegates** task completion to Copilot's existing autopilot mode (optionally), wraps it in an **outer multi-task loop**, and adds extensive verification, circuit-breaker, and orchestration machinery that Copilot autopilot was never designed to provide.

Copilot autopilot is a **single-task** autonomous mode — the model calls `task_complete` and the session ends. Ralph turns Copilot into a **multi-task autonomous executor** driven by a PRD file, with machine verification at every gate.

---

## 2. Copilot Autopilot's `task_complete` — How It Works

Source: `vscode-copilot-chat/src/extension/intents/node/toolCallingLoop.ts`

| Aspect | Detail |
|---|---|
| **Tool name** | `task_complete` (built-in VS Code tool, not extension-defined) |
| **Enablement** | Only when `request.permissionLevel === 'autopilot'` |
| **Detection** | Binary boolean: `this.taskCompleted` flipped when any round contains `task_complete` tool call |
| **Nudge mechanism** | Up to 5 consecutive nudges injected as `<UserMessage>` if model stops without calling `task_complete` |
| **Counter reset** | If model does productive work (tool calls) after a nudge, `autopilotIterationCount` resets to 0 |
| **Safety caps** | `MAX_AUTOPILOT_RETRIES = 3` (transient errors), `MAX_AUTOPILOT_ITERATIONS = 5` (consecutive nudges), tool call hard cap auto-expands up to 200 |
| **Scope** | **Single task per session** — once `task_complete` fires, the loop exits |
| **External hooks** | External stop hooks run *before* autopilot check, can block stopping |

**Key limitation**: Copilot autopilot has zero concept of "next task." When `task_complete` is called, that conversation is done.

---

## 3. Ralph-loop's Completion Detection Path

Source: `ralph-loop/src/orchestrator.ts`, `verify.ts`, `decisions.ts`, `strategies.ts`

### 3.1 Completion Detection — NOT a `task_complete` Tool

Ralph does **not** register any tool with VS Code. Instead:

1. **CopilotCommandStrategy** opens a chat session, sends a prompt, then **watches the filesystem** (.PRD file watcher + polling)
2. Completion = **PRD checkbox toggled** (`- [x]`) — detected by `verifyTaskCompletion()` which reads the PRD file and checks if the task's checkbox changed from `[ ]` to `[x]`
3. Timeout detection: if no file activity within `inactivityTimeoutMs`, the wait settles as `completed: false`
4. File activity tracking: any workspace file change resets the inactivity timer and sets `hadFileChanges = true`

### 3.2 Dual Exit Gate

After the strategy reports, the orchestrator runs `dualExitGateCheck()`:

```
canComplete = modelSignal (timed completion) AND machineVerification (all checks pass)
```

Two mandatory checks:
- **checkbox**: PRD task marked `[x]`
- **diff**: workspace had file changes

Both model AND machine must agree. If model claims done but checkbox isn't ticked → rejected. If checkbox is ticked but no code changes → rejected.

### 3.3 Nudge Loop (Outer)

Ralph's nudge loop (`decisions.ts → shouldNudge()`) mirrors autopilot's pattern but operates at the **orchestrator level**, not inside Copilot's tool-calling loop:

- `maxNudgesPerTask` (configurable, default 3)
- Nudge text: *"Continue with the current task. You have NOT marked the checkbox yet..."*
- Counter resets if productive file changes detected (same pattern as autopilot)
- Circuit breakers check **before** each nudge

### 3.4 Autopilot Integration (Optional)

Ralph can optionally enable Copilot's autopilot mode:
```typescript
// copilot.ts
if (options?.useAutopilotMode) {
    requestArgs['permissionLevel'] = 'autopilot';
}
```
Feature flag: `config.features.useAutopilotMode` (default: `false`)

When enabled, Ralph gets **nested completion detection**:
- Inner: Copilot autopilot's `task_complete` tool within the chat session
- Outer: Ralph's filesystem-based PRD checkbox watcher

---

## 4. Patterns Borrowed from Copilot Autopilot

| Pattern | Copilot Implementation | Ralph Adaptation |
|---|---|---|
| **Nudge-on-stall** | Inject nudge as `<UserMessage>` when model stops without `task_complete` | Rebuild entire prompt + append continuation suffix, send as new chat request |
| **Self-resetting nudge counter** | Reset `autopilotIterationCount` when model makes tool calls | Reset `nudgeCount` when `hadFileChanges` detected |
| **Max nudge cap** | `MAX_AUTOPILOT_ITERATIONS = 5` (hardcoded) | `maxNudgesPerTask` (configurable, default 3) |
| **Auto-retry on transient errors** | `MAX_AUTOPILOT_RETRIES = 3`, filters by error type | `shouldRetryError()` with transient pattern matching, `MAX_RETRIES_PER_TASK = 3` |
| **Iteration limit auto-expansion** | Tool call limit auto-expands by 1.5x up to 200 | `effectiveMaxIterations` auto-expands by 1.5x up to `hardMaxIterations` |
| **Binary completion check** | Did model call `task_complete`? (boolean) | Did PRD checkbox change to `[x]`? (boolean) |
| **Inactivity timeout** | Yield request suppression in autopilot (implicit timeout via tool call cap) | Explicit `inactivityTimeoutMs` with file-activity-based reset |
| **Fresh session per task** | N/A (single-task only) | `startFreshChatSession()` before each task |

---

## 5. Patterns Ralph Added (Not in Copilot)

### 5.1 Multi-Task Orchestration
- **PRD-driven task queue**: Parses `PRD.md` for checkbox items, picks next unchecked task, loops until all done
- **DAG-aware parallel execution**: `pickReadyTasks()` resolves `dependsOn` fields, runs independent tasks concurrently
- **Completed-task latch**: `completedTasks: Set<number>` prevents re-execution of finished tasks
- **Per-task atomic git commits**: `atomicCommit()` creates conventional-commit messages with task metadata

### 5.2 Circuit Breaker Chain
Five independent breakers, evaluated as a chain:
| Breaker | Trigger | Action |
|---|---|---|
| `MaxRetriesBreaker` | retry count ≥ threshold | stop |
| `MaxNudgesBreaker` | nudge count ≥ threshold | stop |
| `StagnationBreaker` | N consecutive nudges without file changes | skip |
| `ErrorRateBreaker` | error rate > 60% in sliding window | stop |
| `TimeBudgetBreaker` | elapsed time > budget | skip |

Copilot has no equivalent — its only safety valves are the nudge cap (5) and tool call cap (200).

### 5.3 External Hook Bridge
- **Shell hook provider**: Executes external scripts on lifecycle events (`SessionStart`, `PreCompact`, `PostToolUse`, `PreComplete`, `TaskComplete`)
- **chatSend signal file**: External processes can inject chat messages by writing JSON to `$TMPDIR/ralph-loop-chat-send.signal`
- **Command injection defense**: `DANGEROUS_PATTERNS` regex blocks shell metacharacters in hook scripts
- **Process tree kill**: Proper SIGTERM→SIGKILL cleanup with cross-platform support

Copilot's external hooks are limited to VS Code's `StopHookInput/Output` API — no file-based bridge, no lifecycle events beyond stopping.

### 5.4 Dual Exit Gate (Model + Machine Verification)
Copilot trusts the model's `task_complete` call entirely. Ralph requires **both**:
1. Model signal (checkbox toggled or timeout)
2. Machine verification (all checks pass: checkbox, diff, optionally tsc/vitest)

### 5.5 Confidence Scoring
Weighted scoring system after task completion:
| Check | Weight |
|---|---|
| checkbox | 100 |
| vitest | 20 |
| tsc | 20 |
| diff | 20 |
| no_errors | 10 |
| progress_updated | 10 |

Score below `confidenceThreshold` triggers escalation. Copilot has no equivalent.

### 5.6 Stagnation Detection (3-Tier)
- **Tier 1**: SHA-256 hashes of tracked files unchanged → inject nudge text
- **Tier 2**: Stale iterations exceed threshold+1 → trigger circuit breaker (skip)
- **Tier 3**: Stale iterations exceed threshold+2 → `HumanCheckpointRequested` (pause loop)

### 5.7 Struggle Detection
Independent detector tracking three signals:
- `no-progress`: N iterations with zero file changes
- `short-iteration`: N iterations completing under 30s (model gives up quickly)
- `repeated-error`: Same error hash appearing repeatedly

### 5.8 Diff Validation with Retry
Post-completion gate that verifies actual code changes via `git diff`:
- If no diff → inject nudge and re-execute task
- Max retries exhausted → `HumanCheckpointRequested`
- Optional diff summary appended to progress file

### 5.9 Bearings Phase (Pre-Flight Health Check)
Before each task iteration:
- Run `tsc --noEmit` and `vitest run`
- If unhealthy on first attempt → inject fix-task into PRD and retry
- If unhealthy on second attempt → pause loop for human intervention

### 5.10 Knowledge Extraction & Injection
- Post-task: scan progress output for `[LEARNING]` and `[GAP]` tags
- Persist to `knowledge.md`
- Pre-task: inject relevant learnings (keyword-matched) into prompt

### 5.11 Review-After-Execute
Optional LLM-based code review after task completion (same-session or new-session mode). Copilot has no self-review mechanism.

### 5.12 Session Persistence
Serializes loop state to `.ralph/session.json` for crash recovery (task index, iteration count, circuit breaker state). 24-hour expiry.

### 5.13 Parallel File Monitor
Interval-based monitor tracks PRD mtime, progress mtime, progress size, and checkbox count. Emits `MonitorAlert` if all signals stale for N intervals.

### 5.14 Context Injection API
External caller can inject text into next iteration via `injectContext(text)` — enables operator-in-the-loop steering.

### 5.15 Pause/Resume/Yield Control
- `pause()` / `resume()`: Suspend and resume the loop
- `requestYield()`: Graceful handoff after current task completes
- `setSessionId()`: Detect session changes and auto-pause

---

## 6. What Copilot Autopilot CANNOT Do That Ralph Enables

| Capability | Copilot Autopilot | Ralph-loop |
|---|---|---|
| **Multi-task execution** | Single task per session | N tasks from PRD, sequential or parallel |
| **PRD-driven planning** | No concept of PRD | Parses `PRD.md` checkbox lists as task queue |
| **External orchestration** | None — closed loop | Hook bridge, signal files, context injection API |
| **Machine verification** | Trusts model's `task_complete` | Dual gate: model signal + deterministic checks |
| **Circuit breakers** | Nudge cap (5) + tool cap (200) | 5 independent breakers with configurable thresholds |
| **Crash recovery** | Session lost on restart | `.ralph/session.json` persistence |
| **Stagnation detection** | Counter-based (consecutive nudges) | SHA-256 file hashing + 3-tier escalation |
| **Atomic git commits** | No git integration | Per-task conventional commits with metadata |
| **Knowledge accumulation** | None across tasks | `knowledge.md` extraction and injection |
| **Pre-flight health checks** | None | Bearings phase (tsc + vitest before each task) |
| **Parallel task execution** | N/A (single task) | DAG-aware concurrency with `dependsOn` resolution |
| **Confidence scoring** | None | Weighted multi-check scoring with threshold |
| **Human-in-the-loop escalation** | None (auto-stops after 5 nudges) | `HumanCheckpointRequested` → pause → resume |
| **Operator steering** | None | `injectContext()`, `chatSend` signal file |
| **Diff validation** | None | Post-completion git diff check with retry |
| **Review-after-execute** | None | Optional LLM self-review |

---

## 7. Architecture Relationship

```
┌──────────────────────────────────────────────────────────┐
│                    RALPH ORCHESTRATOR                      │
│  ┌──────────────────────────────────────────────────────┐ │
│  │  for each task in PRD:                                │ │
│  │    ① Bearings check (tsc + vitest)                    │ │
│  │    ② Build prompt with PRD + progress + knowledge     │ │
│  │    ③ Fire Copilot via command API                     │ │
│  │    ④ Wait: filesystem watcher + inactivity timeout    │ │
│  │    ⑤ Nudge loop (re-send prompt on stall)            │ │
│  │    ⑥ Dual exit gate (checkbox + diff)                │ │
│  │    ⑦ Confidence scoring                              │ │
│  │    ⑧ Diff validation + retry                         │ │
│  │    ⑨ Optional review-after-execute                   │ │
│  │    ⑩ Atomic git commit                               │ │
│  │    ⑪ Knowledge extraction                            │ │
│  │    ⑫ Circuit breaker evaluation                      │ │
│  │    ⑬ Stagnation / struggle detection                 │ │
│  │    ⑭ → next task or AllDone                          │ │
│  └──────────────────────────────────────────────────────┘ │
│                                                           │
│  INNER: Copilot Autopilot (optional)                      │
│  ┌──────────────────────────────────────────────────────┐ │
│  │  while (no task_complete):                            │ │
│  │    model → tool calls → execute → nudge if stopping  │ │
│  │    binary: task_complete called? → exit               │ │
│  └──────────────────────────────────────────────────────┘ │
└──────────────────────────────────────────────────────────┘
```

Ralph treats Copilot autopilot as **one execution strategy among several**, wrapping it in a vastly more sophisticated control plane.

---

## 8. Key Source Files

| File | Role |
|---|---|
| `src/orchestrator.ts` | Main loop, multi-task iteration, parallel execution, circuit breaker integration |
| `src/verify.ts` | `dualExitGateCheck()`, `computeConfidenceScore()`, verifier registry |
| `src/decisions.ts` | `shouldNudge()`, `shouldContinueLoop()`, `shouldRetryError()` |
| `src/strategies.ts` | `CopilotCommandStrategy` — filesystem-based completion detection |
| `src/copilot.ts` | `openCopilotWithPrompt()` with optional autopilot `permissionLevel` |
| `src/circuitBreaker.ts` | 5 breaker types + error hash tracker + chain evaluation |
| `src/shellHookProvider.ts` | External hook bridge with command injection defense |
| `src/hookBridge.ts` | `chatSend` signal file watcher for external process communication |
| `src/stagnationDetector.ts` | SHA-256 file hashing for stagnation detection |
| `src/struggleDetector.ts` | Multi-signal struggle detection |
| `src/diffValidator.ts` | Post-completion git diff validation |
| `src/knowledge.ts` | Learning extraction and injection |
| `src/sessionPersistence.ts` | Crash recovery via `.ralph/session.json` |
| `src/gitOps.ts` | Atomic git commits with conventional-commit messages |
| `src/consistencyChecker.ts` | Deterministic consistency checks (checkbox state, progress mtime, file existence) |
| `vscode-copilot-chat/.../toolCallingLoop.ts` | Copilot autopilot implementation (reference) |
