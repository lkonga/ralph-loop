# Research 11: IFetchMLOptions / IMakeChatRequestOptions — Progress & Stream Flow

## Findings

### Interface Hierarchy

The progress/stream flow relies on a clear interface chain:

1. **`IMakeChatRequestOptions`** (defined in `src/platform/networking/common/networking.ts:154`) — the base interface. Its key streaming field is:
   - `finishedCb: FinishedCallback | undefined` — the per-chunk streaming callback invoked as SSE tokens arrive.

2. **`IFetchMLOptions`** (defined in `src/platform/chat/common/chatMLFetcher.ts:22`) — extends `IMakeChatRequestOptions`, adding:
   - `endpoint: IChatEndpoint` — the resolved model endpoint
   - `requestOptions: OptionalChatRequestParams` — temperature, tools, max_tokens etc. (makes the optional field required)

3. **`ToolCallingLoopFetchOptions`** (defined in `src/extension/intents/node/toolCallingLoop.ts:101`) — a narrower pick type:
   ```ts
   Required<Pick<IMakeChatRequestOptions, 'messages' | 'finishedCb' | 'requestOptions' | 'userInitiatedRequest' | 'turnId'>>
     & Pick<IMakeChatRequestOptions, 'disableThinking'>
   ```
   This makes `finishedCb` **required** (not optional) at the tool-calling layer.

### The `FinishedCallback` Signature

Defined in `src/platform/networking/common/fetch.ts:275`:

```ts
interface FinishedCallback {
  (text: string, index: number, delta: IResponseDelta): Promise<number | undefined>;
}
```

- `text`: full concatenated response text so far
- `index`: choice index (for multi-completion; typically 0)
- `delta`: the incremental `IResponseDelta` containing `text`, `copilotToolCalls`, `thinking`, `retryReason`, `statefulMarker`, `phase`, `contextManagement`, `serverToolCalls`, etc.
- **Return**: `undefined` to continue streaming; a `number` (byte offset) to signal early stop.

### End-to-End Flow: Conversation → Fetcher

#### Layer 1: ToolCallingLoop (Conversation Layer)

In `toolCallingLoop.ts` (~line 1095–1160), the loop:
1. Creates a `FetchStreamSource` (an `AsyncIterableSource<IResponsePart>`)
2. Wires it into a `responseProcessor.processResponse(…, fetchStreamSource.stream, outputStream, token)` — this pipes streaming parts into the VS Code `ChatResponseStream` (the UI progress stream)
3. Constructs a `finishedCb` closure that:
   - Calls `fetchStreamSource.update(text, delta)` — pushing each delta into the async iterable for the response processor
   - Extracts tool calls from `delta.copilotToolCalls`
   - Captures `delta.statefulMarker`, `delta.thinking`, `delta.phase`, `delta.contextManagement`
   - Returns `stopEarly ? text.length : undefined` — allows the response processor to signal early termination

#### Layer 2: DefaultIntentRequestHandler.fetch()

In `defaultIntentRequestHandler.ts` (~line 688–700), the subclass wraps the loop's `finishedCb`:
```ts
finishedCb: (text, index, delta) => {
    this.telemetry.markReceivedToken();
    return opts.finishedCb!(text, index, delta);
}
```
Then calls `endpoint.makeChatRequest2({...opts, finishedCb, ...otherFields}, token)`.

#### Layer 3: ChatEndpoint.makeChatRequest2()

In `src/platform/endpoint/node/chatEndpoint.ts` (~line 396–430):
- Resolves WebSocket vs HTTP transport and stateful marker settings
- Delegates to `_makeChatRequest2()` which calls `this._chatMLFetcher.fetchOne({...options, endpoint: this}, token)`

#### Layer 4: ChatMLFetcherImpl.fetchMany()

In `src/extension/prompt/node/chatMLFetcher.ts` (~line 140):
- Destructures `finishedCb` from `IFetchMLOptions`
- Wraps it in a `FetchStreamRecorder` that records all deltas and tracks time-to-first-token
- The recorder's `.callback` is passed down to `_fetchAndStreamChat()` → `_doFetchViaHttp()` or `_doFetchViaWebSocket()`

#### Layer 5: HTTP/SSE Processing

In `_doFetchViaHttp()` (~line 1340):
- Calls `chatEndpointInfo.processResponseFromChatEndpoint(…, finishedCb, …)`
- This invokes `SSEProcessor.processSSE(finishCallback)` which calls `finishedCb(text, index, delta)` for each SSE chunk
- The return value from `finishedCb` can stop reading (early termination)

### FetchStreamSource as Bridge

`FetchStreamSource` (in `chatMLFetcher.ts:50+`) bridges the callback-based `finishedCb` pattern to an `AsyncIterableObject<IResponsePart>` consumed by response processors:

- `.update(text, delta)` → emits `{delta}` into the async iterable
- `.resolve()` → signals stream end
- `.pause()` / `.unpause()` — buffers parts during paused state (used during prompt building phase)

### FetchStreamRecorder as Wrapper

`FetchStreamRecorder` (in `chatMLFetcher.ts:130+`) decorates the original `finishedCb`:
- Records all deltas for retry/telemetry
- Tracks `firstTokenEmittedTime` (TTFTe metric)
- Passes through to the original callback

### Retry Flow and `retryReason`

When a retry is needed (filtered content, 503, empty response), the `finishedCb` receives a synthetic delta with `retryReason` set:
```ts
streamRecorder.callback('', 0, { text: '', retryReason: result.category });
```
This propagates up through `FetchStreamSource.update()` → response processor → the delta's `retryReason` field triggers `clearToPreviousToolInvocation` behavior in the UI.

### Non-Conversation Callers

Some callers bypass `ToolCallingLoop`:
- **`feedbackGenerator.ts`**: Creates `finishedCb` that parses partial review comments and calls `progress.report()` directly
- **`xtabProvider.ts`**: Provides inline `finishedCb` for inline completion scenarios
- **`title.ts`**: Sets `finishedCb: undefined` (no streaming needed)
- **`promptCategorizer.ts`**: Uses `finishedCb` to extract tool calls from classification responses

## Patterns

1. **Callback-to-AsyncIterable Bridge**: The codebase converts the `finishedCb` callback into `AsyncIterable<IResponsePart>` via `FetchStreamSource`, allowing response processors to consume streams idiomatically.

2. **Decorator/Wrapper Chain**: `finishedCb` gets wrapped at each layer:
   - ToolCallingLoop creates the core callback (→ FetchStreamSource + tool call extraction)
   - DefaultIntentRequestHandler wraps it (→ telemetry marking)
   - FetchStreamRecorder wraps it again (→ delta recording + TTFT tracking)

3. **Early Termination via Return Value**: The `FinishedCallback` return contract (`number` to stop, `undefined` to continue) allows the response processor to signal the fetcher to abort mid-stream without cancellation tokens.

4. **Retry Signaling via Delta**: Retry reasons flow *through* the same streaming channel using `delta.retryReason`, keeping the retry handling transparent to the UI layer.

5. **Optional finishedCb**: At the `IMakeChatRequestOptions` level, `finishedCb` is `FinishedCallback | undefined`. Non-streaming callers (title generation, classification) pass `undefined`. The `ToolCallingLoopFetchOptions` type makes it `Required` since the tool loop always needs streaming.

## Applicability

For **503 retry UX/progress** work:

- **Progress reporting during retries** can be implemented by emitting synthetic deltas via `finishedCb` with custom `retryReason` or `phase` values — the pattern already exists for content-filter retries.
- **The `delta.phase` field** is already plumbed through the entire chain (captured in toolCallingLoop at line ~1170) and could carry retry-state signals like `"retrying"`, `"waiting_for_retry"`.
- **The `delta.retryReason` field** (`FilterReason | 'network_error' | 'server_error'`) already supports `'server_error'` — 503 retries could use this.
- **`FetchStreamRecorder`** records all deltas including retry signals, so telemetry automatically captures retry events.
- **Silent 503 retries** (in `chatMLFetcher.ts`) currently happen *below* the `finishedCb` layer — they retry the HTTP request but don't signal through `finishedCb`. To show progress, synthetic deltas would need to be emitted before the retry fetch.
- The `enableRetryOnError` flag on `IMakeChatRequestOptions` controls whether the fetchMany layer attempts retries and emits `retryReason` deltas.

## Open Questions

1. **Silent 503 retry gap**: The `_getSilentlyRetryable503Info()` path retries without any `finishedCb` notification — should it emit a `retryReason` delta before retrying so the UI can show "Retrying..." progress?
2. **retryReason propagation to FetchStreamSource**: When `retryReason` is emitted, does the response processor clear previous output correctly in all cases (tool calls mid-stream, thinking blocks)?
3. **WebSocket retry path**: The WebSocket transport (`_doFetchViaWebSocket`) has its own retry logic — does it emit retry signals through `finishedCb` in the same way as HTTP?
4. **Phase vs retryReason**: Should 503 retry progress use `delta.phase` (informational) or `delta.retryReason` (triggers UI clear behavior)? They have different semantic contracts.
5. **Multiple FetchStreamRecorder wrapping**: In the retry path inside `fetchMany`, a new `fetchMany` call is made recursively — does this create nested `FetchStreamRecorder` wrapping, and does the outer recorder correctly capture retry deltas?
