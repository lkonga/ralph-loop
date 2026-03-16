# Research Report 11 — Error Trajectory Classification: Copilot Autopilot vs ralph-loop Task 61

**Wave**: 2026-03-16-ralph-deep-verification
**Question**: Does Copilot autopilot already have error trajectory classification (productive/stagnant/thrashing)? Compare with ralph-loop's planned BackpressureClassifier (Task 61).

---

## 1. Executive Summary

**Copilot Chat does NOT have error trajectory classification.** Its "trajectory" system is purely a **logging/export format** (ATIF — Agent Trajectory Interchange Format) for recording agent execution traces, not an analytical system for classifying error patterns. Copilot's autopilot loop uses simple counter-based limits (max iterations, max retries) with no awareness of whether errors are converging, stagnant, or cyclical.

ralph-loop's planned `BackpressureClassifier` (Task 61) **is genuinely novel** relative to Copilot's current implementation. No equivalent exists in the vscode-copilot-chat codebase.

---

## 2. Copilot Chat's Loop Control Mechanisms

### 2.1 Autopilot Stop/Continue Logic

Source: `src/extension/intents/node/toolCallingLoop.ts`

The autopilot loop uses three simple counters:

| Mechanism | Constant | Value | Purpose |
|-----------|----------|-------|---------|
| `MAX_AUTOPILOT_ITERATIONS` | 5 | Max nudge attempts when model stops without calling `task_complete` |
| `MAX_AUTOPILOT_RETRIES` | 3 | Max auto-retries on transient errors (network, server failures) |
| Productive reset | — | If model makes tool calls after being nudged, reset iteration count to 0 |

**Key logic** (`shouldAutopilotContinue`):
- Model must call `task_complete` tool to signal completion
- If it stops without calling it → nudge with "You have not yet marked the task as complete"
- After 5 nudges without productive tool calls → give up
- If model produces non-task_complete tool calls after nudge → reset counter (this is labeled "productive" in a comment)

**Key logic** (`shouldAutoRetry`):
- Only in `autoApprove`/`autopilot` permission mode
- Retries on: NetworkError, Failed, BadRequest
- Does NOT retry on: RateLimited, QuotaExceeded, Canceled, OffTopic
- No classification of error type beyond the response type enum

### 2.2 Claude Agent Max Turns

Source: `src/extension/chatSessions/claude/node/claudeCodeAgent.ts`

- Handles `error_max_turns` subtype: Shows progress "Maximum turns reached ({0})"
- Handles `error_during_execution`: Throws `KnownClaudeError`
- No trajectory analysis — purely reactive to SDK-reported limits

### 2.3 Stop Hooks (Extension Point)

Source: `vscode.proposed.chatHooks.d.ts`

Hook types: `SessionStart | SessionEnd | UserPromptSubmit | PreToolUse | PostToolUse | PreCompact | SubagentStart | SubagentStop | Stop | ErrorOccurred`

Hooks are **extensibility points** for external scripts — they can block the agent from stopping (`StopHookResult.shouldContinue = true`), but they don't classify error trajectories. They're binary go/no-go gates, not analytical classifiers.

### 2.4 Trajectory System (Logging Only)

Source: `src/platform/trajectory/` and `src/extension/trajectory/`

The "trajectory" system is an **ATIF-format structured log**:
- Records: steps, tool calls, observations, token metrics
- Purpose: export, visualization, debugging (e.g., `github.copilot.chat.debug.exportSingleTrajectory` command)
- **Does NOT analyze** trajectory data for patterns
- **Does NOT classify** errors as productive/stagnant/thrashing
- **Does NOT feed back** into loop control decisions

### 2.5 Agent Debug Events

Source: `src/extension/agentDebug/common/agentDebugTypes.ts`

Error types defined: `'toolFailure' | 'rateLimit' | 'contextOverflow' | 'timeout' | 'networkError' | 'redundancy'`

Loop control events: `'start' | 'iteration' | 'yield' | 'stop'`

These are **observability events** for the debug panel, not control signals. The `ErrorType` enum classifies errors by _type_ (what went wrong), not by _trajectory_ (is the situation improving or worsening).

---

## 3. ralph-loop's Error Detection Systems (Implemented)

### 3.1 StagnationDetector (`src/stagnationDetector.ts`) — IMPLEMENTED

- **Method**: SHA-256 hash of tracked files (`progress.txt`, `PRD.md`); compare across iterations
- **Signal**: `stagnating = true` when ALL tracked files unchanged for ≥ `maxStaleIterations` (default: 2) consecutive iterations
- **Self-resetting**: Any file change resets the stale counter to 0
- **Escalation**: 3-tier — (1) inject nudge, (2) trigger circuit breaker, (3) yield HumanCheckpointRequested

### 3.2 StruggleDetector (`src/struggleDetector.ts`) — IMPLEMENTED

Tracks 3 independent signals:
1. **No-progress**: `filesChanged === 0` for ≥ 3 consecutive iterations
2. **Short-iteration**: iteration duration < 30s for ≥ 3 consecutive iterations
3. **Repeated-error**: Uses `ErrorHashTracker` — same error hash appearing ≥ 2x

Returns `{ struggling: boolean, signals: string[] }` — boolean with signal list, not trajectory classification.

### 3.3 CircuitBreaker System (`src/circuitBreaker.ts`) — IMPLEMENTED

Chain of pure-function breakers (priority-ordered):
1. `MaxRetriesBreaker` — stop at retry limit
2. `MaxNudgesBreaker` — stop at nudge limit
3. `StagnationBreaker` — skip when nudges produce no file changes
4. `RepeatedErrorBreaker` — skip when same error appears 3+ times (disabled by default)
5. `ErrorRateBreaker` — stop when error rate > 60% in sliding window (disabled by default)
6. `TimeBudgetBreaker` — skip when time exceeds budget (disabled by default)

### 3.4 ErrorHashTracker (`src/circuitBreaker.ts`) — IMPLEMENTED

- Normalizes errors (strips ANSI, timestamps, stack traces, line numbers, collapses whitespace)
- MD5 hashes normalized errors for dedup comparison
- Counts occurrences per unique hash

---

## 4. ralph-loop's BackpressureClassifier (Task 61) — PLANNED (Not Yet Implemented)

Source: `research/14-phase9-refined-tasks.md` L143-L180

**Three-way classification**:

| Classification | Condition | Orchestrator Response |
|----------------|-----------|----------------------|
| `productive` | Error count decreasing over last 3 snapshots OR test pass count increasing | Continue normally, no intervention |
| `stagnant` | Error count flat (±0), unique/total error ratio < 0.3 | Inject guidance nudge |
| `thrashing` | Delegates to `ThrashingDetector.isThrashing()` | Escalate to circuit breaker |

**Key innovation**: Interprets the _trend_ of error signals, not just current state. Uses `ConvergenceSnapshot` with: `errorCount`, `testPassCount`, `uniqueErrorCount`, `filesEdited`.

---

## 5. Comparative Analysis

| Dimension | Copilot Chat Autopilot | ralph-loop (Implemented) | ralph-loop Task 61 (Planned) |
|-----------|------------------------|--------------------------|------------------------------|
| **Error awareness** | Response type enum (NetworkError, RateLimited, etc.) | ErrorHashTracker (dedup + count) | ConvergenceSnapshot (error count, unique ratio, test passes) |
| **Trajectory analysis** | None — counters only | None — boolean signals only | **Yes** — 3-snapshot sliding window trend analysis |
| **Classification** | None | Binary: struggling / not-struggling | **3-way**: productive / stagnant / thrashing |
| **Progress detection** | "Productive" = model made tool calls after nudge (line 825) | File hash changes, git diff file count | Error count trend, test pass trend, file edit tracking |
| **Loop control** | Hard counter limits (5 iterations, 3 retries) | CircuitBreakerChain with 6 breakers | Classifier determines orchestrator response per category |
| **Stagnation detection** | None | StagnationDetector (file hash comparison) | Inherits + adds stagnant classification |
| **Thrashing detection** | None | Not yet implemented | ThrashingDetector via git diff hunk region hashing |
| **Backpressure concept** | None — stop hooks are binary gates | CircuitBreaker trip = binary gate | **Graduated response**: continue / nudge / escalate based on classification |

### The "productive" concept comparison

- **Copilot**: "productive" appears once in `toolCallingLoop.ts` L825 — it means "the model made non-task_complete tool calls after being nudged." This is not trajectory classification; it's a heuristic to reset the nudge counter when the model resumes working.
- **ralph-loop Task 61**: "productive" means "errors are decreasing over time OR test passes are increasing" — this is convergence detection, a fundamentally different (and more sophisticated) concept.

---

## 6. Key Findings

1. **Copilot's "trajectory" is logging, not classification.** The ATIF trajectory system records what happened but never analyzes patterns to influence loop behavior. There is zero feedback from trajectory data into loop control decisions.

2. **Copilot has no concept of "error trajectory."** Its error handling is type-based (`toolFailure | rateLimit | contextOverflow | timeout | networkError | redundancy`) and response-type-based, not trend-based. It never asks "are errors getting better or worse?"

3. **Copilot's "productive" heuristic is trivial.** One comment on line 825 uses "productive" to mean "model made tool calls" — it's a boolean observation about model behavior, not a classification of error trajectory.

4. **ralph-loop's existing detectors are more sophisticated already.** The implemented `StagnationDetector` (file hash comparison), `StruggleDetector` (3-signal composite), and `ErrorHashTracker` (error dedup) go well beyond Copilot's counter-based approach.

5. **Task 61's BackpressureClassifier is genuinely innovative** relative to Copilot. The three-way classification (productive/stagnant/thrashing) with trend analysis over a snapshot window has no equivalent in vscode-copilot-chat. Copilot's agent debug system has the _data_ (error events, loop control events) but never performs this kind of analysis on it.

6. **The gap is architectural.** Copilot separates observability (trajectory/debug events) from control (hard counter limits). ralph-loop's design creates a closed feedback loop where error patterns directly influence orchestrator behavior. This is a fundamentally different architecture.

---

## 7. Caveats

- Copilot Chat's `Stop` and `ErrorOccurred` hooks could theoretically be used by external extensions to implement trajectory classification, but the core product does not do this.
- Server-side Copilot infrastructure (not visible in this codebase) might have additional loop control logic. This analysis covers only the VS Code extension client-side code.
- ralph-loop's Task 61 is **planned, not implemented**. The classification rules exist only in spec form in `research/14-phase9-refined-tasks.md`.
