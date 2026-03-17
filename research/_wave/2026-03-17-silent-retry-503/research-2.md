# Research Report: ToolCallingLoop Error Handling & Stop Hook Flow

**Wave ID**: 2026-03-17-silent-retry-503
**Report**: research-2
**Question**: How does `ToolCallingLoop.run()` handle model request errors, and where does the stop hook with `shouldContinue=false` get triggered?
**Date**: 2026-03-17

---

## 1. High-Level Flow

```
run() → _runLoop() → while(true) { runOne() → check result → stop hook → break/continue }
```

The call chain is:
- [`run()`](../../../vscode-copilot-chat/src/extension/intents/node/toolCallingLoop.ts#L634) creates an OTel span, sets up token listeners, then delegates to `_runLoop()`.
- [`_runLoop()`](../../../vscode-copilot-chat/src/extension/intents/node/toolCallingLoop.ts#L748) is the actual `while(true)` loop.
- [`runOne()`](../../../vscode-copilot-chat/src/extension/intents/node/toolCallingLoop.ts#L1043) builds prompts, calls `this.fetch()`, and returns `IToolCallSingleResult`.

## 2. The Main Loop's Decision Tree (`_runLoop()`, Line ~810)

After `runOne()` returns, the loop evaluates the result at [line 832](../../../vscode-copilot-chat/src/extension/intents/node/toolCallingLoop.ts#L832):

```typescript
if (!result.round.toolCalls.length || result.response.type !== ChatFetchResponseType.Success) {
```

This condition is **true** (i.e., loop considers stopping) when:
- **No tool calls** were returned by the model, OR
- **The response is NOT a success** (any error type)

### 2.1 Critical Insight: Model Errors Enter the Stop Path

A model error (e.g., 503 `Failed`, `NetworkError`, `BadRequest`) makes `result.response.type !== ChatFetchResponseType.Success` true, so the loop enters the "should we stop?" block. This is the **same code path** as a successful response with no tool calls.

## 3. Error Handling Within the Stop Path (Lines 835–907)

Once inside the stop path, the flow is:

### Step 1: Cancellation Check (Line 835)
```typescript
if (token.isCancellationRequested) { break; }
```
If cancelled, break immediately — no stop hooks.

### Step 2: Auto-Retry for Transient Errors (Lines 839–844)
```typescript
if (result.response.type !== ChatFetchResponseType.Success && this.shouldAutoRetry(result.response)) {
    this.autopilotRetryCount++;
    await timeout(1000, token);
    continue;
}
```
`shouldAutoRetry()` ([line 385](../../../vscode-copilot-chat/src/extension/intents/node/toolCallingLoop.ts#L385)) returns `true` only when:
1. Permission level is `autoApprove` or `autopilot`
2. Retry count < `MAX_AUTOPILOT_RETRIES` (3)
3. Error type is NOT `RateLimited`, `QuotaExceeded`, `Canceled`, or `OffTopic`

**Types that ARE auto-retried** (in agent modes): `Failed`, `NetworkError`, `BadRequest`, `NotFound`, `Unknown`, `Filtered`, `PromptFiltered`, `FilteredRetry`, `Length`, `ExtensionBlocked`, `AgentUnauthorized`, `AgentFailedDependency`, `InvalidStatefulMarker`.

**Key finding**: A 503 error would map to `ChatFetchResponseType.Failed` or `ChatFetchResponseType.NetworkError`, and **will be silently retried up to 3 times** (with 1s delay) in agent/autopilot mode.

### Step 3: Stop Hook Execution (Lines 847–883)

If auto-retry doesn't apply (wrong mode, or retries exhausted), the stop hook runs:

#### For subagents (line 848):
```typescript
const stopHookResult = await this.executeSubagentStopHook({...}, sessionId, outputStream, token);
```

#### For top-level agents (line 867):
```typescript
const stopHookResult = await this.executeStopHook({ stop_hook_active: stopHookActive }, sessionId, outputStream, token);
```

### Step 4: `shouldContinue` Determination

The [`executeStopHook()`](../../../vscode-copilot-chat/src/extension/intents/node/toolCallingLoop.ts#L271) method:

1. Calls `this._chatHookService.executeHook('Stop', ...)` to run all registered stop hooks
2. Iterates over results via `processHookResults()`
3. Each hook output is checked: if `decision === 'block'` and `reason` is provided → adds to `blockingReasons`
4. Hook **errors** (stderr from non-zero exit code) are **also** collected as blocking reasons
5. Returns `{ shouldContinue: true, reasons: [...blockingReasons] }` if any blocking reasons exist
6. Returns `{ shouldContinue: false }` otherwise

```typescript
// From executeStopHook() at line 271
if (blockingReasons.size > 0) {
    return { shouldContinue: true, reasons: [...blockingReasons] };
}
return { shouldContinue: false };
```

### Step 5: What Happens With Stop Hook Result

Back in `_runLoop()`:

- **`shouldContinue=true` + reasons**: Loop `continue`s — the model gets another chance with `stopHookReason` injected into the next prompt
- **`shouldContinue=false`**: Falls through to...

### Step 6: Autopilot Internal Stop Hook (Lines 887–895)

Only for `autopilot` mode AND `ChatFetchResponseType.Success`:
```typescript
if (this.options.request.permissionLevel === 'autopilot' && result.response.type === ChatFetchResponseType.Success) {
```
**This will NOT trigger for error responses** — the `Success` type check ensures it.

### Step 7: The Final `break` (Line 898)

If none of the above caused a `continue`, the loop breaks.

## 4. Error Response Flow Summary — The Exact Sequence for a 503

For a 503 error in **autopilot/autoApprove** mode:

| Attempt | What Happens | Result |
|---------|-------------|--------|
| 1st 503 | `shouldAutoRetry()` → true | `continue` (silent retry after 1s) |
| 2nd 503 | `shouldAutoRetry()` → true (count=1) | `continue` (silent retry after 1s) |
| 3rd 503 | `shouldAutoRetry()` → true (count=2) | `continue` (silent retry after 1s) |
| 4th 503 | `shouldAutoRetry()` → false (count=3 ≥ MAX) | Falls to stop hook |
| Stop hook | `executeStopHook()` runs | Returns `shouldContinue` based on hooks |
| If hooks say continue | Loop continues with hook reasons | `continue` |
| If hooks say stop | Falls through autopilot check | Skipped (not Success) |
| **Final** | **`break`** | **Loop terminates** |

For a 503 in **non-agent mode** (e.g., ask mode):

| Attempt | What Happens | Result |
|---------|-------------|--------|
| 1st 503 | `shouldAutoRetry()` → false (wrong permLevel) | Falls to stop hook immediately |
| Stop hook | `executeStopHook()` runs | `shouldContinue=false` (no hooks registered typically) |
| **Final** | **`break`** | **Loop terminates** |

## 5. `StopHookInput` / `StopHookOutput` Interfaces

Defined in [`chatHookService.ts` lines 134–148](../../../vscode-copilot-chat/src/platform/chat/common/chatHookService.ts#L134):

```typescript
export interface StopHookInput {
    readonly stop_hook_active: boolean;  // true if loop is already continuing from a prior stop hook
}

export interface StopHookOutput {
    readonly decision?: 'block';   // Set to 'block' to prevent stopping
    readonly reason?: string;      // Required when decision is 'block'
}
```

Internal `StopHookResult` in [`toolCallingLoop.ts` line 110](../../../vscode-copilot-chat/src/extension/intents/node/toolCallingLoop.ts#L110):

```typescript
interface StopHookResult {
    readonly shouldContinue: boolean;
    readonly reasons?: readonly string[];
}
```

## 6. Key Findings

1. **Model errors and "no tool calls" share the same stop path** (line 832). The `||` condition means both trigger the stop/retry logic.

2. **Silent auto-retry is limited to agent modes** (`autoApprove`/`autopilot`) and capped at 3 attempts. Non-retryable errors (`RateLimited`, `QuotaExceeded`, `Canceled`, `OffTopic`) skip retry entirely.

3. **Stop hooks run AFTER auto-retry is exhausted** — they are a second line of defense. A hook can block termination by returning `decision: 'block'` with a reason.

4. **`shouldContinue=false` is the default** for stop hooks. It only becomes `true` when at least one hook explicitly blocks with a reason. Errors in hook execution also default to `shouldContinue: false`.

5. **The autopilot internal stop hook (`shouldAutopilotContinue`) is skipped for error responses** — it requires `ChatFetchResponseType.Success`, so errors always fall through to the final `break`.

6. **A `catch` block at line 900** handles exceptions thrown during `runOne()` (as opposed to error response types). `CancellationError` causes a `break`; all other exceptions propagate upward.

7. **The `stopHookActive` flag** is passed into the hook input to let hooks know the loop has already been extended, preventing infinite loops.

## 7. File References

| Component | File | Line(s) |
|-----------|------|---------|
| `run()` entry point | [toolCallingLoop.ts](../../../vscode-copilot-chat/src/extension/intents/node/toolCallingLoop.ts#L634) | 634 |
| `_runLoop()` main loop | [toolCallingLoop.ts](../../../vscode-copilot-chat/src/extension/intents/node/toolCallingLoop.ts#L748) | 748 |
| Stop/error decision | [toolCallingLoop.ts](../../../vscode-copilot-chat/src/extension/intents/node/toolCallingLoop.ts#L832) | 832 |
| `shouldAutoRetry()` | [toolCallingLoop.ts](../../../vscode-copilot-chat/src/extension/intents/node/toolCallingLoop.ts#L385) | 385–404 |
| `MAX_AUTOPILOT_RETRIES` | [toolCallingLoop.ts](../../../vscode-copilot-chat/src/extension/intents/node/toolCallingLoop.ts#L331) | 331 |
| Auto-retry invocation | [toolCallingLoop.ts](../../../vscode-copilot-chat/src/extension/intents/node/toolCallingLoop.ts#L839) | 839–844 |
| `executeStopHook()` | [toolCallingLoop.ts](../../../vscode-copilot-chat/src/extension/intents/node/toolCallingLoop.ts#L271) | 271–314 |
| Stop hook result check | [toolCallingLoop.ts](../../../vscode-copilot-chat/src/extension/intents/node/toolCallingLoop.ts#L867) | 867–883 |
| Autopilot internal hook | [toolCallingLoop.ts](../../../vscode-copilot-chat/src/extension/intents/node/toolCallingLoop.ts#L887) | 887–895 |
| Final `break` | [toolCallingLoop.ts](../../../vscode-copilot-chat/src/extension/intents/node/toolCallingLoop.ts#L898) | 898 |
| `runOne()` | [toolCallingLoop.ts](../../../vscode-copilot-chat/src/extension/intents/node/toolCallingLoop.ts#L1043) | 1043 |
| `StopHookInput`/`Output` | [chatHookService.ts](../../../vscode-copilot-chat/src/platform/chat/common/chatHookService.ts#L134) | 134–148 |
| `StopHookResult` (internal) | [toolCallingLoop.ts](../../../vscode-copilot-chat/src/extension/intents/node/toolCallingLoop.ts#L110) | 110–121 |
| `ChatFetchResponseType` enum | [commonTypes.ts](../../../vscode-copilot-chat/src/platform/chat/common/commonTypes.ts#L95) | 95–114 |
