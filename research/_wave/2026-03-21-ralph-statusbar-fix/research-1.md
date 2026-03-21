# Research Report: State→Idle Transition vs updateStatusBar Timing

**Wave:** 2026-03-21-ralph-statusbar-fix
**Question:** Where does `orchestrator.state` transition to `Idle` vs where `updateStatusBar` is called? Does the `for await` loop exit without emitting a terminal event that triggers `updateStatusBar`?

---

## Finding 1: The Single Idle Transition

`this.state = LoopState.Idle` is set in **exactly one place**: the `finally` block of `start()`.

- **File:** [src/orchestrator.ts](../../../src/orchestrator.ts#L452) — line 452
- **Context:** Inside `finally` after the `for await` loop and after the optional branch-switchback logic

```typescript
// Line 451-453
} finally {
    this.cleanup();
    this.state = LoopState.Idle;  // <-- THE ONLY Idle transition
}
```

No event is emitted after this state change. The `onEvent` callback is never called with the Idle state from the `finally` block.

---

## Finding 2: updateStatusBar Call Sites (8 total in extension.ts)

All calls use `orchestrator!.getStateSnapshot()` which reads `this.state` at call time.

| Line | Event Trigger | State at call time |
|------|---------------|-------------------|
| [extension.ts#L151](../../../src/extension.ts#L151) | `TaskStarted` | `Running` (set at L409) |
| [extension.ts#L162](../../../src/extension.ts#L162) | `TaskCompleted` | `Running` |
| [extension.ts#L176](../../../src/extension.ts#L176) | `Countdown` | `Running` |
| [extension.ts#L182](../../../src/extension.ts#L182) | `AllDone` | **`Running`** ← BUG |
| [extension.ts#L188](../../../src/extension.ts#L188) | `MaxIterations` | **`Running`** ← BUG |
| [extension.ts#L200](../../../src/extension.ts#L200) | `YieldRequested` | **`Running`** ← BUG |
| [extension.ts#L206](../../../src/extension.ts#L206) | `SessionChanged` | **`Paused`** (set at L661/872) |
| [extension.ts#L315](../../../src/extension.ts#L315) | `Stopped` | **`Running`** ← BUG |

---

## Finding 3: The Race Condition (Root Cause)

The execution flow in `start()` (lines 403-453) is:

```
1. this.state = LoopState.Running           (L409)
2. for await (const event of this.runLoop()) {
3.     this.onEvent(event)                   ← extension.ts event handler runs HERE
4.                                             calls updateStatusBar(orchestrator.getStateSnapshot())
5.                                             getStateSnapshot() reads this.state → still "Running"
6.     if (terminal event) break;            (L426-432)
7. }
8. // branch switchback logic               (L437-449)
9. finally {
10.    this.cleanup();
11.    this.state = LoopState.Idle;          (L452) ← state changes HERE, AFTER events
12. }
```

**The `onEvent` callback (step 3) fires BEFORE the `for await` loop exits (step 6), and the `finally` block (step 9-11) only runs after the loop breaks.**

So when `AllDone`, `MaxIterations`, `YieldRequested`, or `Stopped` events fire:
- The event handler in extension.ts calls `updateStatusBar(orchestrator.getStateSnapshot())`
- `getStateSnapshot()` returns `{ state: "running", ... }` because `this.state` hasn't been set to Idle yet
- The status bar renders with the spinning icon `$(sync~spin)` for state `"running"`

Meanwhile:
- The `ralph-loop.status` command ([extension.ts#L371](../../../src/extension.ts#L371)) calls `orchestrator?.getState() ?? 'idle'`
- If called **after** the `finally` block runs, it correctly returns `'idle'`
- If the orchestrator is nulled out after completion, it falls back to `'idle'`

**This is the inconsistency: the status bar's LAST update shows "running", but the status command reads the live state which is now "idle".**

---

## Finding 4: Terminal Events and STATE_CHANGE_EVENTS

The `STATE_CHANGE_EVENTS` set ([orchestrator.ts#L393-400](../../../src/orchestrator.ts#L393)) includes:
- `TaskStarted`, `TaskCompleted`, `Stopped`, `AllDone`, `MaxIterations`, `YieldRequested`, `SessionChanged`

When a terminal event fires, the orchestrator also emits a `StateNotified` synthetic event (L420-424) with the **current** `this.state` — which is still `Running` at that point. This `StateNotified` event is logged in extension.ts at [L309-311](../../../src/extension.ts#L309) but doesn't trigger a `updateStatusBar` call.

**Note:** `BranchEnforcementFailed` is a terminal event (it causes `break` at L430) but is NOT in `STATE_CHANGE_EVENTS`, so no `StateNotified` is emitted for it. The extension.ts handler for `BranchEnforcementFailed` ([L327-329](../../../src/extension.ts#L327)) also does NOT call `updateStatusBar`, leaving the bar stuck showing whatever was last displayed.

---

## Finding 5: statusBar.ts Hide Logic

The status bar ([statusBar.ts#L62-71](../../../src/statusBar.ts#L62)) hides itself only when:
```typescript
if (snapshot.state === 'idle' && !snapshot.taskId) {
    bar.hide();
}
```

Since the terminal events pass `state: 'running'` (as analyzed above), the bar never gets the `idle` state to trigger hiding. It remains visible showing the spinning icon.

---

## Finding 6: The `showStatusBarIdle()` Convenience Function

There's an unused-in-event-flow function at [statusBar.ts#L74-76](../../../src/statusBar.ts#L74):
```typescript
export function showStatusBarIdle(): void {
    updateStatusBar({ state: 'idle', taskId: '', taskDescription: '', iterationCount: 0, nudgeCount: 0 });
}
```

This is imported in extension.ts but never called by the event handler. It could serve as the fix mechanism — call it after the orchestrator's `start()` promise resolves.

---

## Summary: Timing Diagram

```
Time →

runLoop() yields AllDone event
  │
  ├──▶ onEvent(AllDone)
  │      └──▶ extension.ts handler
  │             └──▶ updateStatusBar(getStateSnapshot())
  │                    └──▶ state = "running" ← STALE
  │
  ├──▶ StateNotified emitted (state="running") — logged only, no UI update
  │
  ├──▶ break (loop exits)
  │
  ├──▶ branch switchback (optional)
  │
  └──▶ finally { cleanup(); this.state = Idle }  ← CORRECT state, but NO updateStatusBar call
```

---

## Actionable Fix (for implementer)

The `start()` method's `finally` block sets state to Idle but never notifies the UI. Two options:

1. **Quick fix:** After `await orchestrator.start()` resolves in extension.ts, call `updateStatusBar(orchestrator.getStateSnapshot())` or `showStatusBarIdle()`.

2. **Proper fix:** In `start()`'s `finally` block (after `this.state = LoopState.Idle`), emit one final event:
   ```typescript
   this.onEvent({ kind: LoopEventKind.StateNotified, state: this.state as string, taskId: '' });
   ```
   Then handle that in extension.ts to call `updateStatusBar`.

Option 2 is cleaner because it keeps the notification logic inside the orchestrator rather than relying on callers to do post-completion updates.
