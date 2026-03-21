# Research 6: `ralph-loop.status` Command vs `updateStatusBar` — State Disconnect

## Question

What does `ralph-loop.status` return and does it correctly reflect the orchestrator's actual idle state? Also, what drives the visual status bar state via `updateStatusBar`?

## Findings

### 1. The `ralph-loop.status` Command

**Location:** [src/extension.ts](../../src/extension.ts#L371-L378)

```ts
vscode.commands.registerCommand('ralph-loop.status', (silent?: boolean) => {
    const state = orchestrator?.getState() ?? 'idle';
    if (!silent) {
        vscode.window.showInformationMessage(`Ralph Loop: ${state}`);
    }
    return state;
});
```

- Returns `orchestrator?.getState() ?? 'idle'` — a raw `LoopState` string.
- `getState()` ([src/orchestrator.ts#L369](../../src/orchestrator.ts#L369)) just returns `this.state`.

### 2. The `updateStatusBar` Function

**Location:** [src/statusBar.ts#L62-L72](../../src/statusBar.ts#L62-L72)

```ts
export function updateStatusBar(snapshot: StateSnapshot): void {
    const bar = ensureItem();
    bar.text = formatText(snapshot);
    bar.tooltip = buildTooltip(snapshot);
    if (snapshot.state === 'idle' && !snapshot.taskId) {
        bar.hide();
    } else {
        bar.show();
    }
}
```

- Driven entirely by a `StateSnapshot` passed from the event handler.
- Uses snapshot's `.state` for icon selection: `running` → `$(sync~spin)`, `paused` → `$(debug-pause)`, `idle` → `$(circle-outline)`.
- Hides only when `state === 'idle' && !taskId`.

### 3. How the Event Handler Updates the Status Bar

In `extension.ts` (lines 148–315), the `onEvent` callback calls `updateStatusBar(orchestrator!.getStateSnapshot())` for these events:

| Event | Status bar shows |
|---|---|
| `TaskStarted` | running (state=running in orchestrator) |
| `TaskCompleted` | running (still in loop) |
| `Countdown` | running (between tasks) |
| `AllDone` | **running** ← BUG |
| `MaxIterations` | **running** ← BUG |
| `YieldRequested` | **running** ← BUG |
| `Stopped` | **running** ← BUG |
| `SessionChanged` | paused |

### 4. The Core Disconnect — Timing of `this.state = Idle`

**`start()` method** ([src/orchestrator.ts#L404-L455](../../src/orchestrator.ts#L404-L455)):

```ts
async start(): Promise<void> {
    this.state = LoopState.Running;          // ← Set to Running
    try {
        for await (const event of this.runLoop()) {
            this.onEvent(event);             // ← Calls extension callback
            // ...                           //   which calls updateStatusBar(getStateSnapshot())
            if (terminal_event) break;       //   AT THIS POINT state is STILL Running
        }
        // Branch switch-back code (async)   // ← state STILL Running
    } finally {
        this.cleanup();
        this.state = LoopState.Idle;         // ← Set to Idle HERE, AFTER everything
    }
}
```

**The sequence for terminal events (AllDone, Stopped, MaxIterations, YieldRequested):**

1. `runLoop()` yields e.g. `AllDone` event
2. `onEvent(event)` is called → extension callback fires
3. Extension callback calls `updateStatusBar(orchestrator!.getStateSnapshot())`
4. `getStateSnapshot()` returns `{ state: 'running', ... }` because `this.state` is still `Running`
5. Status bar displays running icon `$(sync~spin)`
6. The `break` exits the `for await` loop
7. Branch switch-back runs (may be async/slow)
8. `finally` block sets `this.state = LoopState.Idle`
9. **But nobody calls `updateStatusBar()` again after this point**

### 5. Why the Status Command Later Returns "idle"

After the `finally` block completes, `this.state` becomes `Idle`. So the next call to `ralph-loop.status` correctly returns `'idle'`. But the **visual status bar** was last updated in step 5 above, showing `running`. No subsequent call to `updateStatusBar` is made after the `finally` block.

This creates the reported disconnect:
- **Status bar visual**: Shows `running` (spinning icon) — frozen at the last `updateStatusBar` call
- **Status command**: Returns `'idle'` — reads live state which was updated in `finally`

### 6. Secondary Issue: Auto-Resume Path Missing Status Bar Updates

At line 455, `orchestrator.start()` is called **without `await`** for auto-resume:
```ts
orchestrator.start(); // fire-and-forget, no status bar update on completion
```
The resumed orchestrator's event handler is a bare logger (`logger.log(\`[resumed] ${event.kind}\`)`) with **no `updateStatusBar` calls at all**. If auto-resume completes, the status bar is never touched.

### 7. The `showStatusBarIdle()` Helper Exists But Is Never Called After Loop End

```ts
export function showStatusBarIdle(): void {
    updateStatusBar({ state: 'idle', taskId: '', taskDescription: '', iterationCount: 0, nudgeCount: 0 });
}
```

This convenience function exists in `statusBar.ts` (line 75) but is **never invoked** from `extension.ts`. It was designed for exactly this purpose but wasn't wired in.

## Root Cause Summary

| Issue | Cause |
|---|---|
| Status bar stuck on "running" after loop completes | Terminal events (AllDone, Stopped, etc.) fire `updateStatusBar` BEFORE `finally` sets `state = Idle`. No post-finally update. |
| Status command returns correct "idle" | `getState()` reads live `this.state` which IS updated in `finally` |
| Visual/command disconnect | Two different timing windows: visual frozen at pre-finally, command reads post-finally |

## Recommended Fixes

1. **Set `this.state = Idle` before yielding terminal events** — move `this.state = LoopState.Idle` into the event handling for AllDone/Stopped/MaxIterations/YieldRequested, before the `onEvent` call, so `getStateSnapshot()` returns `idle` when `updateStatusBar` is called.

2. **OR: Add a post-finally `updateStatusBar` call** — after `start()` resolves, call `showStatusBarIdle()` or `updateStatusBar(orchestrator.getStateSnapshot())` in the extension's try/catch block around `await orchestrator.start()`.

3. **Fix auto-resume path** — wire `updateStatusBar` into the resumed orchestrator's event handler, or use the same event handler as the normal start path.
