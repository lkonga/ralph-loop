# Research-5: `fireStateChangeNotification` Timing, Push/Poll Interaction, and Stuck "Processing" Bug

## Question

Does `fireStateChangeNotification` interact with the copilot fork's status bar, and can the fork's polling/push mechanism get stuck showing `processing`? Can the push fire before the orchestrator state transitions to Idle, causing the fork to see `running`?

---

## 1. `fireStateChangeNotification` Mechanism (ralph-loop side)

**File**: [src/stateNotification.ts](../../../src/stateNotification.ts)

The function is minimal — a fire-and-forget VS Code command invocation:

```ts
export async function fireStateChangeNotification(state: LoopState, taskId: string): Promise<void> {
    try {
        await vscode.commands.executeCommand('ralph-loop.onStateChange', { state, taskId });
    } catch {
        // Fire-and-forget — command may not be registered (copilot fork not installed)
    }
}
```

**Payload**: `{ state: LoopState, taskId: string }` — where `LoopState` is `'idle' | 'running' | 'paused'`.

---

## 2. Where `fireStateChangeNotification` Is Called (extension.ts event handler)

The function is called from the `onEvent` callback in `extension.ts` (lines 147–330). Here is every call site and the state it pushes:

| Event Kind | State Pushed | taskId | Line |
|---|---|---|---|
| `TaskStarted` | `Running` | `event.task.taskId` | ~150 |
| `TaskCompleted` | `Running` | `event.task.taskId` | ~162 |
| `AllDone` | `Idle` | `''` | ~181 |
| `MaxIterations` | `Idle` | `''` | ~187 |
| `YieldRequested` | `Idle` | `''` | ~199 |
| `SessionChanged` | `Paused` | `''` | ~205 |
| `Stopped` | `Idle` | `''` | ~313 |

**Notable**: `TaskCompleted` fires `Running`, NOT `Idle`. This is correct because the orchestrator is still running (it will pick the next task or finish), but a consumer that interprets `Running` as "actively processing" will remain in that display state until the next notification.

---

## 3. Orchestrator State Transition Timing (the critical race)

### 3.1 The `start()` method flow (orchestrator.ts, line 404)

```
start():
  1. this.state = LoopState.Running
  2. for await (event of runLoop()):
       a. onEvent(event)                    ← fires UI updates + push notifications
       b. if STATE_CHANGE_EVENTS.has(event.kind):
            emit StateNotified event        ← telemetry only
       c. if terminal event (AllDone/Stopped/...):
            break
  3. (optional) switch back to original branch
  finally:
    cleanup()
    this.state = LoopState.Idle             ← ACTUAL state transition to Idle
```

### 3.2 The Race Condition — CONFIRMED

When `AllDone` is yielded:
1. `onEvent(AllDone)` fires → `fireStateChangeNotification(LoopState.Idle, '')` — pushes "idle" to fork
2. `updateStatusBar(orchestrator!.getStateSnapshot())` — ralph-loop's own status bar updates
3. The `for await` loop breaks
4. Branch switch-back runs (may take time)
5. **`finally` block** sets `this.state = LoopState.Idle`

**The push notification at step 1 sends `LoopState.Idle` as a hardcoded value** — it does NOT read `this.state`. So for `AllDone`, `MaxIterations`, `YieldRequested`, and `Stopped`, the correct idle state is pushed immediately.

However, `getStateSnapshot()` at step 2 returns `this.state` which is still `Running` at that point (the `finally` block hasn't executed yet). **This means `updateStatusBar()` (ralph-loop's own bar) may briefly show "running" after the push already sent "idle" to the fork**.

This is an inversion — the fork gets the right state first, but ralph-loop's own status bar may lag.

---

## 4. Fork Status Bar Architecture (copilot-chat side)

**File**: `vscode-copilot-chat/src/extension/prompt/node/forkStatusBar.ts`

The fork's `ForkStatusBarContribution` has **two independent state sources** that drive the status bar text:

### 4.1 Primary: `RequestLifecycleModel` (Copilot request lifecycle)

```ts
this._register(this._requestLifecycle.onDidChangeStatus(updateFromLifecycle));
```

This fires on every Copilot chat request cycle:
- `Processing` → shows `fork • processing • {effort}{model}`
- `Idle` / `Finished` → shows `fork • {status} • {billing}{model}`

### 4.2 Supplementary: Ralph-loop state (push + one-shot snapshot)

```ts
// One-shot activation snapshot
vscode.commands.executeCommand<RalphStateSnapshot>('ralph-loop.getStateSnapshot').then(...)

// Push listener
this._register(vscode.commands.registerCommand('ralph-loop.onStateChange', (event) => {
    updateFromSnapshot({ state: event.state, taskId: event.taskId, ... });
}));
```

### 4.3 Conflict: Two State Sources, No Coordination

**This is the root of the "stuck processing" bug.** The two update functions (`updateFromLifecycle` and `updateFromSnapshot`) write to the same `item.text` without coordination:

- When `updateFromLifecycle(Processing)` fires → shows "processing"
- When `updateFromSnapshot({state: 'idle'})` fires → shows "idle"
- **Whichever fires last wins the status bar text**

If `updateFromLifecycle` fires with `Processing` AFTER `updateFromSnapshot` fires with `idle`, the bar shows "processing" indefinitely — until the Copilot request lifecycle completes.

### 4.4 "Processing" Scenario That Gets Stuck

1. Ralph-loop finishes all tasks → fires `onStateChange({state: 'idle', taskId: ''})` → fork shows "idle"
2. **But the final Copilot chat request is still being processed** by the Copilot engine (the ralph-loop orchestrator completed its loop, but the underlying LM request hasn't finished)
3. `RequestLifecycleModel` fires `Processing` → fork overrides to show "processing"
4. The `ralph-loop.status` command (called by the fork's status command click) returns `'idle'` because the orchestrator's state is idle
5. **Result**: Status bar shows "processing" but the status command reports "idle"

This is NOT a push-before-transition race in ralph-loop — it's a **last-writer-wins conflict between two independent state sources in the fork**.

---

## 5. Specific Sub-Findings

### 5.1 No Polling Fallback in Current Fork Code

The donor comment at the top of `forkStatusBar.ts` explicitly states:
> `REJECTED: polling loop (timer-based interval) — replaced with push-based events`

There is **no polling fallback**. The fork uses:
- One-shot `getStateSnapshot` call at activation
- Push-based `ralph-loop.onStateChange` listener

If the push command is never registered (ralph-loop not installed), the initial snapshot call fails silently and the fork operates purely from `RequestLifecycleModel`.

### 5.2 `TaskCompleted` Pushes `Running`, Not `Idle`

When a single task completes but more tasks remain, `fireStateChangeNotification(LoopState.Running, event.task.taskId)` is sent. This is semantically correct (the loop is still running), but a consumer that expects task-level idle transitions would never see idle until the entire loop finishes.

### 5.3 The `StateNotified` Synthetic Event

After each state-change event, the orchestrator emits a synthetic `StateNotified` event (line 425):
```ts
if (LoopOrchestrator.STATE_CHANGE_EVENTS.has(event.kind)) {
    const stateStr = this.state as string;
    const taskId = this._currentTaskId;
    this.onEvent({ kind: LoopEventKind.StateNotified, state: stateStr, taskId });
}
```

This reads `this.state` at the time of the event — which for terminal events (`AllDone`, `Stopped`) is still `Running` (the `finally` block hasn't run yet). The `StateNotified` event is currently telemetry-only (the extension.ts handler just logs `📡 State notified: running`) and does NOT trigger another push. But it records a misleading `running` state in logs after the loop has conceptually finished.

### 5.4 `getStateSnapshot()` After Terminal Events

`getStateSnapshot()` reads `this.state` directly:
```ts
getStateSnapshot(): StateSnapshot {
    return {
        state: this.state,  // ← still Running until finally block
        taskId: this._currentTaskId,
        ...
    };
}
```

So `updateStatusBar(orchestrator!.getStateSnapshot())` called in the `AllDone`/`Stopped` handlers will show `running` in ralph-loop's own status bar, even though the push already sent `idle` to the fork.

---

## 6. Key Findings Summary

1. **`fireStateChangeNotification` uses hardcoded state values** (not `this.state`), so the push to the fork sends the correct state at the right time. The push itself is not buggy.

2. **The "stuck processing" bug is a last-writer-wins race in the fork**, not a ralph-loop timing issue. The fork's `ForkStatusBarContribution` has two independent state sources (`RequestLifecycleModel` and ralph-loop push) that both write to the same `item.text` without coordination.

3. **There is no polling fallback in the current fork code.** The PRD specified one (Task 99), but the refactored `ForkStatusBarContribution` rejected polling entirely.

4. **`getStateSnapshot()` returns stale state during terminal events** because `this.state` is only set to `Idle` in the `finally` block of `start()`, which runs after the event handler. This affects ralph-loop's own status bar and the `StateNotified` telemetry event, but does NOT affect the fork push (which uses hardcoded values).

5. **The orchestrator's `_currentTaskId` is cleared in `runLoop()`'s finally block** (line 1510: `this._currentTaskId = ''`), which runs before `start()`'s finally block. So `getStateSnapshot()` during terminal event handling shows `{ state: 'running', taskId: '' }` — a misleading intermediate state.

6. **Fix approaches**:
   - **Fork fix**: Give `updateFromLifecycle` and `updateFromSnapshot` a priority system or merge function so lifecycle "processing" doesn't override ralph-loop "idle" (or vice versa) incorrectly.
   - **Ralph-loop fix**: Set `this.state = LoopState.Idle` BEFORE yielding terminal events (inside `runLoop()`) instead of in the `finally` block of `start()`, so `getStateSnapshot()` returns the correct state when consumed by the event handler.
