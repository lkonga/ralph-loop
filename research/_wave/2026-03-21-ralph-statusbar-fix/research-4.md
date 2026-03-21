# Research-4: Does `ralph-loop.stop` Update the Status Bar?

## Question

Does the `ralph-loop.stop` command update the status bar? Is there a race where stop completes but the `updateStatusBar` event is never received?

## Findings

### 1. The Stop Command Implementation

**File:** `src/extension.ts` (lines 363–369)

```ts
vscode.commands.registerCommand('ralph-loop.stop', () => {
    if (!orchestrator || orchestrator.getState() === 'idle') {
        vscode.window.showWarningMessage('Ralph Loop: Not running');
        return;
    }
    orchestrator.stop();
});
```

The stop command calls `orchestrator.stop()` and **does nothing else** — no `updateStatusBar`, no `fireStateChangeNotification`. It relies entirely on the orchestrator emitting a `Stopped` event that will be handled by the event callback.

### 2. `orchestrator.stop()` Is Fire‑and‑Forget

**File:** `src/orchestrator.ts` (lines 456–460)

```ts
stop(): void {
    this.stopRequested = true;
    this.stopController.abort('stop requested');
    this.logger.log('Stop requested');
}
```

This method:
- Sets `stopRequested = true` (a boolean flag polled in the loop)
- Aborts the `stopController` (propagates through `LinkedCancellationSource`)
- Does **not** emit any event
- Does **not** change `this.state`
- Returns immediately

### 3. How the Status Bar Ultimately Gets Updated

The orchestrator's `start()` method runs a `for await` loop over `runLoop()`:

```ts
for await (const event of this.runLoop()) {
    this.onEvent(event);
    ...
}
```

The `onEvent` callback in `extension.ts` handles `LoopEventKind.Stopped`:

```ts
case LoopEventKind.Stopped:
    logger.log('⏹ Loop stopped');
    fireStateChangeNotification(LoopState.Idle, '');
    updateStatusBar(orchestrator!.getStateSnapshot());
    break;
```

So the status bar update for stop **only happens when the `Stopped` event is yielded by `runLoop()` and processed by the `for await` loop**.

### 4. The `delay()` Method Does Not Respond to Abort

**File:** `src/orchestrator.ts` (lines 1515–1517)

```ts
private delay(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
}
```

**This is a critical issue.** The `delay()` method is a plain `setTimeout` — it does **not** listen to the abort signal. When `stop()` is called:

1. `stopController.abort()` fires immediately
2. But if the loop is currently inside a `delay()` call (e.g., during countdown or pause polling), it will not wake up early
3. The loop must wait for the full delay to elapse before it can check `this.stopRequested` and yield `Stopped`

This means there's a **latency window** (up to `countdownSeconds` × 1000ms or 1000ms for pause polling) where:
- The orchestrator internally knows it should stop (`stopRequested = true`)
- `getState()` still returns `'running'` (state isn't set to idle until the `finally` block)
- The `Stopped` event has not been emitted yet
- The status bar still shows "processing/running"

### 5. Where `stopRequested` Is Checked in `runLoop()`

The `runLoop()` generator checks `stopRequested` at **17 distinct points**, always yielding `{ kind: LoopEventKind.Stopped }` and returning. Key checkpoints:

| Location | Context |
|---|---|
| Line 654 | Top of main `while(true)` loop |
| Line 663 | Inside pause-wait loop |
| Line 793 | During countdown between tasks |
| Line 875 | After checkpoint pause |
| Line 1019 | During nudge loop condition |
| Line 1063 | After nudge loop exits |
| Line 1084 | During retry countdown |
| Line 1227 | Parallel task countdown |
| Line 1280 | After diff validation |
| Line 1380 | Post-review stop |
| Line 1450, 1468, 1482 | Various other positions |

### 6. The Race Condition: Identified

**Race scenario:**

1. Loop is inside `await this.delay(1000)` (countdown or pause poll)
2. User presses Stop → `stop()` sets `stopRequested = true` and aborts controller
3. `delay()` does not wake up — it waits the full timeout
4. During this window, `getState()` returns `'running'`, `getStateSnapshot()` reports running state
5. The `ralph-loop.status` command reports `'running'`
6. The status bar shows the spin icon
7. Eventually the delay resolves, the loop checks `stopRequested`, yields `Stopped`, and only then does the status bar update

**This is not a permanent stuck-state bug, but a temporal race** — the status bar lags behind the actual stop by up to 1–N seconds depending on where in the loop the stop was requested.

### 7. Worse Case: `executionStrategy.execute()` Is Blocking

**File:** `src/orchestrator.ts` (around lines 1000–1060)

If `stop()` is called while `executionStrategy.execute()` is running (the actual Copilot chat interaction), the `stopRequested` flag is set and the controller is aborted, but:
- The execution strategy may or may not honor the abort signal
- The `for await` loop in `start()` is blocked waiting for the next `yield` from `runLoop()`
- `runLoop()` itself is blocked on the `await executionStrategy.execute(...)` call
- Until that call resolves/rejects, no `Stopped` event can be yielded

This could cause a **significant delay** (up to the full task timeout) between pressing Stop and the status bar updating.

### 8. The `finally` Block Sets State After Events

**File:** `src/orchestrator.ts` (lines 450–453)

```ts
} finally {
    this.cleanup();
    this.state = LoopState.Idle;
}
```

The `this.state = LoopState.Idle` only happens **after** the `for await` loop breaks. The event handler calls `orchestrator!.getStateSnapshot()` which reads `this.state`. Since the `Stopped` event is processed inside the `for await` loop (before the `break`), when `updateStatusBar(orchestrator!.getStateSnapshot())` runs, `this.state` is still whatever it was (likely `LoopState.Running`).

**Wait — let me re-examine this.** The flow is:

1. `runLoop()` yields `{ kind: LoopEventKind.Stopped }`
2. `for await` receives it
3. `this.onEvent(event)` is called → the extension callback runs:
   - `fireStateChangeNotification(LoopState.Idle, '')` — correct hardcoded idle
   - `updateStatusBar(orchestrator!.getStateSnapshot())` — reads `this.state` which is still **Running**
4. Then the `break` happens
5. Then the `finally` block runs: `this.state = LoopState.Idle`

**This is a confirmed bug.** When the `Stopped` event handler calls `getStateSnapshot()`, the orchestrator's state is still `Running` because `LoopState.Idle` is only set in the `finally` block **after** the loop breaks. The status bar receives a snapshot with `state: 'running'`, so it shows the running icon even though the loop has logically stopped.

### 9. Comparison with Other Terminal Events

Other events that update the status bar (e.g., `AllDone`, `MaxIterations`, `YieldRequested`) have the **same bug** — they call `getStateSnapshot()` before the `finally` block sets `state = Idle`.

However, `fireStateChangeNotification(LoopState.Idle, '')` correctly hardcodes `Idle`, so any consumer of the notification channel gets the right state. Only the status bar's `updateStatusBar(orchestrator!.getStateSnapshot())` reads stale state.

## Root Cause Summary

| Issue | Severity | Description |
|---|---|---|
| **`getStateSnapshot()` reads stale state** | **HIGH** | When `Stopped` event fires, `this.state` is still `Running`. The `finally` block sets it to `Idle` only after the event is processed. Status bar receives `state: 'running'` snapshot. |
| **`delay()` ignores abort signal** | MEDIUM | `stop()` aborts the controller but `delay()` is a plain `setTimeout`. The loop won't check `stopRequested` until the delay naturally expires, causing latency. |
| **`stop()` doesn't directly notify** | LOW | The stop command relies entirely on the async event pipeline. If the pipeline is blocked (e.g., waiting on execution), the notification is delayed. |

## Recommended Fixes

### Fix 1: Set state before yielding Stopped (HIGH priority)
In `runLoop()`, before every `yield { kind: LoopEventKind.Stopped }`, set `this.state = LoopState.Idle`. Alternatively, have `stop()` directly set `this.state = LoopState.Idle`.

### Fix 2: Make the stop command update status bar directly (HIGH priority)
```ts
vscode.commands.registerCommand('ralph-loop.stop', () => {
    if (!orchestrator || orchestrator.getState() === 'idle') {
        vscode.window.showWarningMessage('Ralph Loop: Not running');
        return;
    }
    orchestrator.stop();
    // Immediately reflect stopped state
    fireStateChangeNotification(LoopState.Idle, '');
    updateStatusBar({ state: 'idle', taskId: '', taskDescription: '', iterationCount: 0, nudgeCount: 0 });
});
```

### Fix 3: Make `delay()` abort-aware (MEDIUM priority)
```ts
private delay(ms: number): Promise<void> {
    return new Promise((resolve) => {
        const timer = setTimeout(resolve, ms);
        const onAbort = () => { clearTimeout(timer); resolve(); };
        this.stopController.signal.addEventListener('abort', onAbort, { once: true });
    });
}
```

### Fix 4: Set state in `stop()` method (alternative to Fix 1)
Change `stop()` to also transition state immediately:
```ts
stop(): void {
    this.stopRequested = true;
    this.state = LoopState.Idle;
    this.stopController.abort('stop requested');
    this.logger.log('Stop requested');
}
```
Note: This may have side effects if the loop reads `this.state` for decisions.
