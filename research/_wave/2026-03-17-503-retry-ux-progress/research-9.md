# Research 9: toolCallingLoop — Fetcher Consumption & ChatResponseStream Access During Retries

## Findings

### Stream Architecture in `runOne()`

The `toolCallingLoop` receives `outputStream: ChatResponseStream | undefined` as a parameter threaded through the entire call chain:

- `run()` → `_runLoop()` → `runOne()` — all accept `outputStream` and pass it down.
- Inside `runOne()` (line ~1094), the stream is wrapped in a **participant chain**: `streamParticipants = outputStream ? [outputStream] : []`, with optional `ResponseStreamParticipant` wrappers stacked on top.
- A `FetchStreamSource` bridges the fetcher to the response processor: fetcher deltas arrive via `finishedCb` → `fetchStreamSource.update(text, delta)` → async iterable → `responseProcessor.processResponse(ctx, inputStream, stream, token)`.
- The response processor writes to the final `stream` (last in the streamParticipants chain), which ultimately pushes parts to the VS Code `ChatResponseStream`.

### How the Fetcher Result Is Consumed

1. **Streaming path**: The `finishedCb` callback on every delta calls `fetchStreamSource.update(text, delta)`. The `FetchStreamSource` feeds an `AsyncIterableSource<IResponsePart>` that the response processor consumes in real-time.
2. **Tool calls**: Extracted from `delta.copilotToolCalls` inside the same `finishedCb`, accumulated into a local `toolCalls[]` array.
3. **Finalization**: After `fetch()` resolves, `fetchStreamSource.resolve()` ends the iterable, the `processResponsePromise` settles, `finalizeStreams()` is called, and `_onDidReceiveResponse` fires.
4. **Return**: `runOne()` returns `IToolCallSingleResult` containing the `ChatResponse` (with status/usage), the `ToolCallRound`, and `lastRequestMessages`.

### Auto-Retry Path (Lines 838–843)

When `runOne()` returns a non-success response and `shouldAutoRetry()` is true:

```typescript
if (result.response.type !== ChatFetchResponseType.Success && this.shouldAutoRetry(result.response)) {
    this.autopilotRetryCount++;
    this._logService.info(`[ToolCallingLoop] Auto-retrying on error (attempt ${this.autopilotRetryCount}/${ToolCallingLoop.MAX_AUTOPILOT_RETRIES}): ${result.response.type}`);
    await timeout(1000, token);
    continue;
}
```

**Key observation**: There is **no `outputStream.progress()` call** during the retry path. The loop just logs to `ILogService`, waits 1 second, and `continue`s to re-call `runOne()`. The user sees nothing in the chat pane during retries.

### Stream Availability During Retries

- `outputStream` **is in scope** throughout `_runLoop()`. The variable is the same `ChatResponseStream | undefined` reference for the entire loop lifetime.
- The `progress()` method on `ChatResponseStreamImpl` pushes a `ChatResponseProgressPart` or `ChatResponseProgressPart2` to VS Code's chat UI.
- `hookProgress()` is already used elsewhere (stop hooks, subagent hooks) to push visible progress to the stream during similar "continuation" scenarios (lines 322, 325, 548, 551).
- The `confirmation()` method is used for the tool-call-limit dialog (line ~1020).

So `outputStream` is fully available and functional — calling `outputStream.progress(...)` at the retry site would render a progress message in the chat pane.

### shouldAutoRetry Conditions (Lines 385–399)

- Only in `autoApprove` or `autopilot` permission levels.
- Max 3 retries (`MAX_AUTOPILOT_RETRIES = 3`).
- Excludes `RateLimited`, `QuotaExceeded`, `Canceled`, `OffTopic` — those exit immediately.
- All other error types (including 503/500 transient errors) are retried.

## Patterns

| Pattern | Location | Description |
|---------|----------|-------------|
| **Stream threading** | `run()` → `_runLoop()` → `runOne()` | `outputStream` parameter threaded through every level of the loop |
| **FetchStreamSource bridge** | `runOne()` L1094–1104 | Bridges fetcher deltas to async iterable consumed by response processor |
| **hookProgress for continuation** | `showStopHookBlockedMessage()` L319–327 | Uses `outputStream.hookProgress()` to notify user of hook-blocked stops |
| **Silent retry** | `_runLoop()` L838–843 | Auto-retry on transient errors with only log output, no user-facing feedback |
| **Confirmation dialog** | `hitToolCallLimit()` L1011 | Uses `outputStream.confirmation()` for tool-call-limit UX |

## Applicability

**Direct applicability for 503 retry UX progress**: The `outputStream` is fully available at the retry site in `_runLoop()`. Adding a `progress()` call is a 1–3 line change:

```typescript
if (result.response.type !== ChatFetchResponseType.Success && this.shouldAutoRetry(result.response)) {
    this.autopilotRetryCount++;
    outputStream?.progress(`Retrying request (attempt ${this.autopilotRetryCount}/${ToolCallingLoop.MAX_AUTOPILOT_RETRIES})…`);
    this._logService.info(`[ToolCallingLoop] Auto-retrying...`);
    await timeout(1000, token);
    continue;
}
```

**No architectural barriers**: 
- The stream is not finalized between loop iterations (only finalized per `runOne()` via `finalizeStreams(streamParticipants)` on the inner participant chain, which is freshly created each call).
- The outer `outputStream` persists across the entire `_runLoop()` lifecycle.
- Prior art exists for pushing progress from the loop control flow (hookProgress, confirmation).

## Open Questions

1. **Progress part lifecycle**: Does a `ChatResponseProgressPart` rendered during retry get automatically cleared when the next successful response streams in, or does it persist as a permanent chat bubble? Need to check VS Code's handling of progress parts in the chat rendering layer.
2. **Multiple retries stacking**: If 3 retries happen, will 3 progress messages stack visually, or should the implementation update/replace the previous one? `ChatResponseProgressPart2` supports tasks that resolve, which might be better suited.
3. **Non-autopilot modes**: The retry logic is gated to `autoApprove`/`autopilot` — in normal mode, transient errors simply break the loop. Should progress UX differ for those cases (e.g., show error + "Retry" button via `confirmation`)?
4. **Stream finalization safety**: Verify that `finalizeStreams(streamParticipants)` inside `runOne()` only finalizes the inner participant chain, not the outer `outputStream` — otherwise pushing progress after a failed `runOne()` would error. Initial reading suggests this is safe since `streamParticipants` is local to `runOne()`.
