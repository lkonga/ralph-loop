# Research Report: Event/Notification System for Branch Operations

**Researcher**: wave-researcher #8
**Date**: 2026-03-21
**Question**: What event/notification system exists for communicating branch operations to the user (status bar, events, logging)?

---

## 1. Architecture Overview

Ralph-loop uses a **three-layer notification architecture**:

1. **LoopEvent system** — Async generator yields typed discriminated-union events from the orchestrator
2. **Status bar** — VS Code `StatusBarItem` showing loop state, task ID, iteration/nudge counts
3. **State change notifications** — Fire-and-forget VS Code command (`ralph-loop.onStateChange`) for cross-extension consumption
4. **ILogger** — Structured logging to a VS Code `LogOutputChannel` ("Ralph Loop")

---

## 2. LoopEventKind Enum — Complete Catalog (39 values)

Source: `src/types.ts` (lines 80–115)

| LoopEventKind | Payload Key Fields | Consumer Action |
|---|---|---|
| `TaskStarted` | `task, iteration, taskInvocationId` | Log, fire state notification, update status bar |
| `CopilotTriggered` | `method, taskInvocationId?` | Log only |
| `WaitingForCompletion` | `task, taskInvocationId` | Log only |
| `TaskCompleted` | `task, durationMs, taskInvocationId` | Log, fire state notification, update status bar |
| `TaskTimedOut` | `task, durationMs, taskInvocationId` | Log + warning message |
| `TaskNudged` | `task, nudgeCount, taskInvocationId` | Log only |
| `TaskRetried` | `task, retryCount, taskInvocationId` | Log (warn level) |
| `Countdown` | `secondsLeft` | Set status bar message (temporary), update status bar |
| `AllDone` | `total` | Log, info message, fire state notification (idle), update status bar |
| `MaxIterations` | `limit` | Log (warn), warning message, fire state notification (idle), update status bar |
| `IterationLimitExpanded` | `oldLimit, newLimit` | Log only |
| `TasksParallelized` | `tasks` | Log only |
| `YieldRequested` | — | Log, info message, fire state notification (idle), update status bar |
| `SessionChanged` | `oldSessionId, newSessionId` | Log (warn), warning message, fire state notification (paused), update status bar |
| `CircuitBreakerTripped` | `breakerName, reason, action, taskInvocationId` | Log (warn) |
| `DiffValidationFailed` | `task, nudge, attempt, taskInvocationId` | Log (warn) |
| `HumanCheckpointRequested` | `task, reason, failCount, taskInvocationId` | Log (warn), interactive dialog (Continue/Skip/Stop/Guidance) |
| `TaskReviewed` | `task, verdict, taskInvocationId` | Log only |
| `MonitorAlert` | `alert, taskId` | Log (warn) |
| `TaskCommitted` | `task, commitHash, taskInvocationId` | Log only |
| `StagnationDetected` | `task, staleIterations, filesUnchanged` | Log (warn) |
| `TaskDecomposed` | `originalTask, subTasks` | Log only |
| `ConsistencyCheckPassed` | `phase, checks` | Log only |
| `ConsistencyCheckFailed` | `phase, checks, failureReason?` | Log (warn) |
| `ContextInjected` | `text` | Log only (truncated to 100 chars) |
| `StruggleDetected` | `signals, taskId` | Log (warn) |
| `CommandBlocked` | `command, reason, taskId` | Log (warn) |
| `BearingsStarted` | `level` | Log only |
| `BearingsProgress` | `stage, status` | Log only |
| `BearingsCompleted` | `healthy, durationMs, issues` | Log (info/warn based on health) |
| `BearingsSkipped` | `reason` | Log only |
| `BearingsChecked` | `healthy, issues` | Log (info/warn) |
| `BearingsFailed` | `issues` | Log (error) |
| `PlanRegenerated` | `taskId, regenerationCount` | Log only |
| `ConfidenceScored` | `score, threshold, breakdown, taskId` | Log only |
| `ContextHandoff` | `estimatedTokens, maxTokens, pct` | Log (warn) |
| `PrdValidationFailed` | `errors` | Log (error), error message |
| `StateNotified` | `state, taskId` | Log only |
| `Stopped` | — | Log, fire state notification (idle), update status bar |
| `Error` | `message` | Log (error), error message |

---

## 3. How Events Are Consumed

### 3.1 Orchestrator → Extension (callback pattern)

The `LoopOrchestrator` constructor takes an `onEvent: (event: LoopEvent) => void` callback. In `extension.ts` (lines 127–302), a massive switch statement handles every event kind with appropriate logging, UI notifications, state notification firing, and status bar updates.

### 3.2 State Change Events Set

The orchestrator defines `STATE_CHANGE_EVENTS` (line 388) — a static set of event kinds that trigger state transitions:
- `TaskStarted`, `TaskCompleted`, `Stopped`, `AllDone`, `MaxIterations`, `YieldRequested`, `SessionChanged`

### 3.3 Cross-Extension Notification

`fireStateChangeNotification()` in `src/stateNotification.ts` fires `ralph-loop.onStateChange` command with `{ state, taskId }`. This is fire-and-forget (catches errors silently) — designed for the Copilot Chat fork to consume.

---

## 4. Status Bar System

Source: `src/statusBar.ts` (80 lines)

### 4.1 Visual Structure

```
Ralph: $(sync~spin) T-42 I:5 N:2
```

- **Icon**: `$(sync~spin)` (running), `$(debug-pause)` (paused), `$(circle-outline)` (idle)
- **Task ID**: Shown if present
- **Counters**: `I:N` format for iteration/nudge counts

### 4.2 Tooltip (MarkdownString)

Shows: State, Task ID, Task Description, Iterations, Nudges

### 4.3 Visibility Logic

- Hidden when `idle` AND no `taskId`
- Otherwise visible
- Uses `StatusBarAlignment.Right` priority 99

### 4.4 StateSnapshot Interface

```typescript
interface StateSnapshot {
  readonly state: string;
  readonly taskId: string;
  readonly taskDescription: string;
  readonly iterationCount: number;
  readonly nudgeCount: number;
}
```

**No branch information is included.**

---

## 5. ILogger Interface

Source: `src/types.ts` (lines 688–692)

```typescript
interface ILogger {
  log(message: string): void;
  warn(message: string): void;
  error(message: string): void;
}
```

Two implementations:
- `createOutputLogger(channel)` — Wraps VS Code `LogOutputChannel` (used in extension)
- `createConsoleLogger()` — ANSI-colored console output with timestamps (used in CLI)

---

## 6. Assessment: Surfacing Branch Info

### 6.1 No Branch Awareness Currently

- Zero references to "branch" in all of `src/`
- `gitOps.ts` only does `atomicCommit` — no branch checking, creation, or switching
- `StateSnapshot` has no branch field
- No `LoopEventKind` relates to branches

### 6.2 Options for Adding Branch Notifications

#### Option A: New LoopEventKind (Recommended)

Add new event kinds to the discriminated union:

```typescript
| { kind: LoopEventKind.BranchValidated; branch: string; expected?: string }
| { kind: LoopEventKind.BranchMismatch; current: string; expected: string; action: string }
```

**Pros**: Clean integration with existing switch statement in `extension.ts`, full logging, can trigger status bar updates and user notifications.
**Cons**: Adds 1-2 new enum values to an already large enum (39 values).

#### Option B: Extend StateSnapshot

Add `branch?: string` to `StateSnapshot` to surface branch name in status bar tooltip.

```typescript
interface StateSnapshot {
  // ...existing fields...
  readonly branch?: string;
}
```

**Pros**: Branch name visible in status bar tooltip at all times. Minimal change surface.
**Cons**: Doesn't communicate enforcement events (mismatch, blocked, etc.) — events still needed for those.

#### Option C: Combined (Best Coverage)

- Add `BranchValidated` / `BranchMismatch` event kinds for enforcement actions → consumed in extension.ts switch for logging + user warnings
- Add `branch?: string` to `StateSnapshot` → always visible in status bar tooltip
- Fire `fireStateChangeNotification()` on branch mismatch → cross-extension consumption

### 6.3 Integration Points

| Layer | Where to Hook | What to Show |
|---|---|---|
| **Status bar tooltip** | `buildTooltip()` in `statusBar.ts` | `**Branch:** feature/xyz` line |
| **Status bar text** | `formatText()` in `statusBar.ts` | Optional branch icon if mismatch |
| **Output channel** | `extension.ts` switch statement | Log branch validation results |
| **Warning dialogs** | `extension.ts` switch statement | Block or warn on wrong branch |
| **Cross-extension** | `fireStateChangeNotification()` | Include branch in payload |
| **getStateSnapshot command** | `orchestrator.getStateSnapshot()` | Return branch name |

---

## 7. Key Findings Summary

1. The event system is mature (39 event kinds) with a clean discriminated-union pattern and centralized consumption in `extension.ts`
2. Status bar shows state/task/iteration/nudge — no branch info
3. Cross-extension notifications exist via `ralph-loop.onStateChange` command
4. `ILogger` has 3 levels (log/warn/error) with two implementations
5. **No branch awareness exists anywhere** in the codebase — zero references to "branch" in `src/`
6. Adding branch support requires: new `LoopEventKind` values (for enforcement events) + optional `branch` field on `StateSnapshot` (for passive display)
7. The existing event dispatch pattern in `extension.ts` makes adding new event kinds straightforward — just add cases to the switch statement
