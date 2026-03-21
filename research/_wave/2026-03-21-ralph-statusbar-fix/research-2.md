# Research-2: Terminal Event Timing — `updateStatusBar` vs State Reset

**Wave:** 2026-03-21-ralph-statusbar-fix
**Question:** Which terminal events call `updateStatusBar`, and do they read `getStateSnapshot()` before or after the orchestrator resets state to Idle?

---

## Finding: Confirmed Stale State Bug

**All four terminal events call `updateStatusBar(orchestrator!.getStateSnapshot())` BEFORE state is reset to Idle.** The snapshot always returns stale `running` state at the time the terminal event fires.

---

## Evidence

### 1. Terminal Events That Call `updateStatusBar`

In [src/extension.ts](src/extension.ts#L148-L315), the event callback handles these terminal events with `updateStatusBar`:

| Event | Line | Also calls `fireStateChangeNotification`? |
|-------|------|------------------------------------------|
| `AllDone` | L182 | Yes — hardcoded `LoopState.Idle` |
| `MaxIterations` | L188 | Yes — hardcoded `LoopState.Idle` |
| `YieldRequested` | L200 | Yes — hardcoded `LoopState.Idle` |
| `Stopped` | L315 | Yes — hardcoded `LoopState.Idle` |

Every terminal event does both:
```ts
fireStateChangeNotification(LoopState.Idle, '');   // ← hardcoded Idle (correct)
updateStatusBar(orchestrator!.getStateSnapshot()); // ← reads live state (stale!)
```

### 2. `getStateSnapshot()` Returns Live Internal State

In [src/orchestrator.ts](src/orchestrator.ts#L377-L386):
```ts
getStateSnapshot(): StateSnapshot {
    return {
        state: this.state,         // ← reads this.state directly
        taskId: this._currentTaskId,
        taskDescription: this._currentTaskDescription,
        iterationCount: this._currentIteration,
        nudgeCount: this._currentNudgeCount,
        branch: this.activeBranch,
        originalBranch: this.originalBranch,
    };
}
```

### 3. State Reset Happens in `finally` Block — AFTER Event Callback

In [src/orchestrator.ts](src/orchestrator.ts#L403-L453), the `start()` method:

```ts
async start(): Promise<void> {
    this.state = LoopState.Running;      // (1) State set to Running
    // ...
    try {
        for await (const event of this.runLoop()) {
            this.onEvent(event);         // (2) Callback fires → updateStatusBar reads state
            //                                    → getStateSnapshot() returns { state: 'running' }

            if (event.kind === LoopEventKind.Stopped ||
                event.kind === LoopEventKind.AllDone ||
                event.kind === LoopEventKind.MaxIterations ||
                event.kind === LoopEventKind.YieldRequested ||
                event.kind === LoopEventKind.BranchEnforcementFailed) {
                this.sessionPersistence?.clear(...);
                break;                   // (3) Loop exits
            }
        }
        // ... branch switching ...
    } finally {
        this.cleanup();
        this.state = LoopState.Idle;     // (4) State reset to Idle — TOO LATE
    }
}
```

### 4. Execution Sequence for Any Terminal Event

```
Time →
[runLoop yields AllDone] → [onEvent callback] → [updateStatusBar(getStateSnapshot())]
                                                       ↑ state = 'running' (stale!)
                          → [break out of for-await]
                          → [finally block] → this.state = LoopState.Idle
                                                       ↑ state = 'idle' (correct, but too late)
```

### 5. The Dual-Path Inconsistency (Root Cause of the Bug)

`fireStateChangeNotification` sends the **correct** hardcoded `LoopState.Idle` value. This is what the `ralph-loop.status` command and the fork status bar in vscode-copilot-chat receive.

`updateStatusBar(orchestrator!.getStateSnapshot())` reads the **live snapshot** where `this.state` is still `Running`. This is what the Ralph status bar item displays.

**Result:** The status command reports "idle" (correct) while the status bar shows "processing/running" (stale).

### 6. `ralph-loop.status` Command Confirms the Discrepancy

In [src/extension.ts](src/extension.ts#L374-L380):
```ts
vscode.commands.registerCommand('ralph-loop.status', (silent?: boolean) => {
    const state = orchestrator?.getState() ?? 'idle';
    // ...
    return state;
});
```

When a user runs `ralph-loop.status` **after** `start()` has completed (i.e., after `finally` block), `getState()` returns `'idle'`. But the status bar was last updated during the event callback where state was still `'running'` — no subsequent `updateStatusBar` call corrects it.

---

## Summary

| Component | Value at terminal event fire | Value after `finally` |
|-----------|-----------------------------|-----------------------|
| `this.state` | `Running` | `Idle` |
| `getStateSnapshot().state` | `'running'` | `'idle'` |
| `fireStateChangeNotification` arg | `LoopState.Idle` (hardcoded) | N/A |
| Status bar display | Shows "running" ❌ | Never updated again ❌ |
| `ralph-loop.status` command | N/A | Returns `'idle'` ✅ |

---

## Fix Options

**Option A (Minimal):** In the event callback for each terminal event, pass a manually constructed snapshot with `state: 'idle'` instead of calling `getStateSnapshot()`:
```ts
case LoopEventKind.AllDone:
    updateStatusBar({ ...orchestrator!.getStateSnapshot(), state: 'idle' });
```

**Option B (Structural):** Move `this.state = LoopState.Idle` into `runLoop()` before yielding terminal events, so the snapshot is already correct when the callback fires.

**Option C (Post-hoc):** Add an `updateStatusBar` call after `orchestrator.start()` resolves in extension.ts (after the `finally` block has run), ensuring the status bar is corrected.

Option A is the most surgical fix. Option B is cleaner but touches the orchestrator's state machine. Option C is a safety net but doesn't fix the root timing issue.
