# Research Report: Exit Paths Missing Status Bar Updates

**Wave ID:** 2026-03-21-ralph-statusbar-fix
**Question:** Are there code paths where the loop exits without emitting a terminal event, causing `updateStatusBar` to never be called with the idle snapshot?
**Files Analyzed:** `src/orchestrator.ts`, `src/extension.ts`, `src/statusBar.ts`, `src/types.ts`

---

## 1. Architecture Summary

The status bar is updated **reactively** — `extension.ts` calls `updateStatusBar(orchestrator!.getStateSnapshot())` inside the `onEvent` callback. The orchestrator's `start()` method sets `this.state = LoopState.Idle` in a `finally` block, but **no event is emitted from the finally block**, so the status bar is only updated if a terminal event reaches the event handler.

### Terminal events that trigger `updateStatusBar` in extension.ts:

| Event | Calls `updateStatusBar`? | Calls `fireStateChangeNotification`? |
|---|---|---|
| `TaskStarted` | ✅ | ✅ (Running) |
| `TaskCompleted` | ✅ | ✅ (Running) |
| `Countdown` | ✅ | ❌ |
| `AllDone` | ✅ | ✅ (Idle) |
| `MaxIterations` | ✅ | ✅ (Idle) |
| `YieldRequested` | ✅ | ✅ (Idle) |
| `SessionChanged` | ✅ | ✅ (Paused) |
| `Stopped` | ✅ | ✅ (Idle) |
| `TaskTimedOut` | ❌ | ❌ |
| `Error` | ❌ | ❌ |
| `BranchEnforcementFailed` | ❌ | ❌ |
| `PrdValidationFailed` | ❌ | ❌ |
| `CircuitBreakerTripped` | ❌ | ❌ |

---

## 2. Exit Path Analysis

### 2.1 Normal exits (status bar IS updated)

These paths emit a terminal event handled by extension.ts that calls `updateStatusBar`:

1. **AllDone** — `yield { kind: LoopEventKind.AllDone }; return;` → extension.ts calls `updateStatusBar` ✅
2. **MaxIterations** — `yield { kind: LoopEventKind.MaxIterations }; return;` → extension.ts calls `updateStatusBar` ✅
3. **Stopped** (explicit stop) — `yield { kind: LoopEventKind.Stopped }; return;` → extension.ts calls `updateStatusBar` ✅
4. **YieldRequested** — `yield { kind: LoopEventKind.YieldRequested }; return;` → extension.ts calls `updateStatusBar` ✅

### 2.2 Abnormal exits (status bar is NOT updated) — **BUGS**

#### BUG 1: `BranchEnforcementFailed` — no `updateStatusBar` call

**Location:** `orchestrator.ts` ~lines 637-650 (three `return` paths)

```
yield { kind: LoopEventKind.BranchEnforcementFailed, reason: ... };
return;
```

The `start()` method **does** break out of the `for await` loop when it sees `BranchEnforcementFailed`:
```typescript
if (event.kind === LoopEventKind.BranchEnforcementFailed) {
    this.sessionPersistence?.clear(this.config.workspaceRoot);
    break;
}
```

But in `extension.ts`, the `BranchEnforcementFailed` handler:
```typescript
case LoopEventKind.BranchEnforcementFailed:
    logger.error(`🌿 Branch enforcement failed: ${event.reason}`);
    vscode.window.showErrorMessage(`Ralph Loop: Branch enforcement failed — ${event.reason}`);
    break;
```
**Does NOT call `updateStatusBar` or `fireStateChangeNotification`.** After this, `start()` runs the `finally` block setting `this.state = LoopState.Idle`, but no event is emitted. The status bar remains stale (showing the last "running" state or whatever it was before).

#### BUG 2: `PrdValidationFailed` — no terminal event, no `updateStatusBar` call

**Location:** `orchestrator.ts` ~line 617

```typescript
yield { kind: LoopEventKind.PrdValidationFailed, errors: validation.errors };
return;
```

This `return` exits `runLoop()`, which means the `for await` loop in `start()` ends. The `finally` block sets state to `Idle`. However:

- `PrdValidationFailed` is **NOT** in the `break` set in `start()` (the `if` block only checks for `Stopped`, `AllDone`, `MaxIterations`, `YieldRequested`, `BranchEnforcementFailed`).
- But because `runLoop()` returns (generator completes), the `for await` loop terminates naturally anyway.
- In `extension.ts`, the `PrdValidationFailed` handler does NOT call `updateStatusBar`:

```typescript
case LoopEventKind.PrdValidationFailed: {
    const msgs = event.errors.map(e => `  ${e.level}: ${e.message}`).join('\n');
    logger.error(`PRD validation failed:\n${msgs}`);
    vscode.window.showErrorMessage(...);
    break;
}
```

**Result:** Status bar remains stale.

#### BUG 3: `SessionStart` hook returns `stop` — emits `Stopped`, **IS handled** ✅

At `orchestrator.ts` ~line 606:
```typescript
} else if (sessionHook.action === 'stop') {
    yield { kind: LoopEventKind.Stopped };
    return;
}
```
This emits `Stopped` which IS handled. No bug here.

#### BUG 4: Uncaught exception in `runLoop()` — no terminal event emitted

**Location:** `orchestrator.ts` `start()` method, lines ~437-464

If `runLoop()` throws an unhandled exception (not caught inside the generator), the `for await` loop in `start()` will throw. The `finally` block runs:
```typescript
} finally {
    this.cleanup();
    this.state = LoopState.Idle;
}
```

But **no event is emitted** and **no `updateStatusBar` call** is made. The caller in `extension.ts` catches it:
```typescript
try {
    await orchestrator.start();
} catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.error(`Loop crashed: ${message}`);
    vscode.window.showErrorMessage(`Ralph Loop crashed: ${message}`);
}
```

But this catch block also **does not call `updateStatusBar`** or `fireStateChangeNotification`.

**Result:** Status bar remains permanently stale after a crash.

#### BUG 5: `finally` block in `runLoop()` does not emit any event

**Location:** `orchestrator.ts` ~line 1508

```typescript
} finally {
    this._currentTaskId = '';
    this.linkedSignal?.dispose();
    this.linkedSignal = undefined;
}
```

This `finally` inside `runLoop()` clears state but does NOT yield any event. It can't — you can't `yield` in a `finally` block of an async generator that has already returned. The state fields are cleared but nobody is notified.

#### BUG 6: `Error` event from task exceptions — no `updateStatusBar` call

When a task throws an exception and retries are exhausted:
```typescript
yield { kind: LoopEventKind.Error, message: `Task "${task.description}" failed: ${message}` };
```

The `Error` handler in `extension.ts`:
```typescript
case LoopEventKind.Error:
    logger.error(`❌ ${event.message}`);
    vscode.window.showErrorMessage(`Ralph Loop: ${event.message}`);
    break;
```

**Does not call `updateStatusBar`.** While this isn't a terminal event (the loop continues to next task), the status bar won't reflect the error state.

#### BUG 7: `TaskTimedOut` event — no `updateStatusBar` call

```typescript
case LoopEventKind.TaskTimedOut:
    logger.warn(`⏰ Timed out after ${Math.round(event.durationMs / 1000)}s: ${event.task.description}`);
    vscode.window.showWarningMessage(`Ralph Loop: Task timed out — ${event.task.description}`);
    break;
```

No `updateStatusBar` call. The status bar continues showing the task as "running" until the next event that does update.

---

## 3. The Core Problem: `start()` finally block

The `finally` block in `start()`:
```typescript
} finally {
    this.cleanup();
    this.state = LoopState.Idle;
}
```

Sets `this.state = LoopState.Idle` — so `getState()` correctly returns `'idle'`. But **no `updateStatusBar` is called after this**, so the status bar remains showing the last visual state.

This is the root cause of the reported bug: "status bar shows processing but status command shows idle."

The `status` command directly calls `orchestrator.getState()` which reads `this.state` (correctly `Idle` after `finally`). But the status bar item was last updated during a `TaskStarted` or similar event showing "running", and was never updated back to "idle".

---

## 4. Summary of Bugs Found

| # | Exit Path | Emits Terminal Event? | `updateStatusBar` Called? | Severity |
|---|---|---|---|---|
| 1 | `BranchEnforcementFailed` | ✅ but no statusbar handler | ❌ | Medium |
| 2 | `PrdValidationFailed` + return | ❌ terminal, just returns | ❌ | Medium |
| 3 | Uncaught exception in `runLoop()` | ❌ | ❌ | **High** |
| 4 | `start()` finally block | N/A (can't emit) | ❌ | **High — ROOT CAUSE** |
| 5 | `TaskTimedOut` | ✅ but no statusbar handler | ❌ | Low |
| 6 | `Error` (task failure) | ✅ but no statusbar handler | ❌ | Low |

---

## 5. Recommended Fixes

### Fix A (Primary — covers all paths): Update status bar in `start()` after loop exits

In `orchestrator.ts` `start()`, add an `updateStatusBar` equivalent after the `finally` sets state to Idle. Since the orchestrator itself doesn't import `updateStatusBar`, the fix should be in `extension.ts`:

```typescript
try {
    await orchestrator.start();
} catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.error(`Loop crashed: ${message}`);
    vscode.window.showErrorMessage(`Ralph Loop crashed: ${message}`);
} finally {
    // ALWAYS update status bar when start() finishes, regardless of how
    fireStateChangeNotification(LoopState.Idle, '');
    updateStatusBar(orchestrator!.getStateSnapshot());
}
```

This is the **single most impactful fix** — it covers all exit paths including crashes, early returns from `PrdValidationFailed`, `BranchEnforcementFailed`, etc.

### Fix B (Defense-in-depth): Add `updateStatusBar` to missing event handlers

In `extension.ts`, add `updateStatusBar` calls to:
- `BranchEnforcementFailed` handler
- `PrdValidationFailed` handler
- `Error` handler (optional — for intermediate state accuracy)
- `TaskTimedOut` handler (optional — for intermediate state accuracy)

### Fix C (Auto-resume path): The auto-resume path has no event handler

```typescript
resumeIncompleteSession(wsRoot, logger, config => {
    orchestrator = new LoopOrchestrator(config, logger, event => {
        logger.log(`[resumed] ${event.kind}`);  // NO updateStatusBar calls!
    });
    orchestrator.start();
});
```

The resumed session event handler only logs — it never calls `updateStatusBar`. This is another potential source of stale status bar state.
