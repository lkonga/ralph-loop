# Research: How `finishedCb` Propagates Deltas Upstream into the Conversation/Intent Layer

**Wave**: 503-retry-ux-progress | **Report**: research-2 | **Date**: 2026-03-17

---

## Findings

### 1. The `FinishedCallback` Contract

Defined in `src/platform/networking/common/fetch.ts` (L276-282):

```ts
(text: string, index: number, delta: IResponseDelta): Promise<number | undefined>;
```

- `text`: Full concatenated response text so far
- `index`: Choice index
- `delta`: The latest chunk (contains `text`, `retryReason`, `copilotToolCalls`, `thinking`, `phase`, `contextManagement`, `statefulMarker`, `beginToolCalls`, `serverToolCalls`, etc.)
- **Return value**: A number to stop reading (`text.length` = stop), or `undefined` to continue

### 2. `FetchStreamRecorder` — the Recording Wrapper

In `src/platform/chat/common/chatMLFetcher.ts` (L114-140), `FetchStreamRecorder` wraps the raw `finishedCb` to:
1. Track **time-to-first-token** (TTFTe) — sets `firstTokenEmittedTime` on the first delta that has text, tool calls, or thinking content
2. Delegate to the original callback: `const result = callback ? await callback(text, index, delta) : undefined;`
3. Record all deltas in `this.deltas: IResponseDelta[]` for later telemetry/replay

The recorder is created in `ChatMLFetcherImpl.fetchMany()` at L230:
```ts
const streamRecorder = new FetchStreamRecorder(finishedCb);
```
All subsequent calls go through `streamRecorder.callback(...)` instead of the raw `finishedCb`.

### 3. Upstream Propagation Path (Full Chain)

The delta propagation follows this chain:

```
ChatMLFetcherImpl.fetchMany()
  └─ streamRecorder.callback(text, 0, delta)     ← called from SSE processor, retry logic, filter logic
       └─ original finishedCb(text, index, delta) ← from IMakeChatRequestOptions
            └─ DefaultIntentRequestHandler.fetch() wraps with telemetry marking
                 └─ opts.finishedCb!(text, index, delta)
                      └─ ToolCallingLoop.runIteration() inline lambda (L1139)
                           ├─ fetchStreamSource.update(text, delta) → FetchStreamSource → AsyncIterableSource → IResponsePart stream
                           ├─ Extracts copilotToolCalls → toolCalls[]
                           ├─ Extracts serverToolCalls → logs them
                           ├─ Extracts statefulMarker, thinking, phase, contextManagement
                           └─ Returns stopEarly ? text.length : undefined
```

### 4. `FetchStreamSource` — The Bridge to Response Processors

`FetchStreamSource` (L48-113 in `chatMLFetcher.ts`) is an `AsyncIterableSource<IResponsePart>` that:
- Receives `update(text, delta)` calls from `finishedCb`
- Emits `{ delta }` via `this._stream.emitOne({ delta })`
- Supports `pause()/unpause()` for flow control
- Filters duplicate code vulnerability annotations

The stream is consumed by `responseProcessor.processResponse(context, fetchStreamSource.stream, outputStream, token)` where `outputStream` is the VS Code `ChatResponseStream`.

### 5. `PseudoStopStartResponseProcessor` — Final Rendering Layer

Defined in `src/extension/prompt/node/pseudoStartStopConversationCallback.ts`, this is the default response processor that:

1. Iterates over the `IResponsePart` async iterable from `FetchStreamSource`
2. Calls `applyDelta(delta, progress)` for each part
3. **Handles `delta.retryReason`** (L174-186):
   - Clears all staged state (`stagedDeltasToApply`, `currentStartStop`, `nonReportedDeltas`, `thinkingActive`)
   - Calls `progress.clearToPreviousToolInvocation(reason)` with a reason mapped from the retry type:
     - `network_error` / `server_error` → `NoReason`
     - `Copyright` → `CopyrightContentRetry`
     - Everything else → `FilteredContentRetry`
   - This wipes the visible response stream back to the last tool invocation boundary
4. For non-retry deltas, applies text/thinking/citations/vulnerabilities/tool invocation progress to the `ChatResponseStream`

### 6. `retryReason` Delta Injection Points in `chatMLFetcher.ts`

The fetcher injects synthetic `retryReason` deltas before retry attempts:

| Location | Reason | Trigger |
|----------|--------|---------|
| L316 | `result.category` (FilterReason) | Snippy/IP filter matched, retrying with augmented messages |
| L372 | `'empty_response'` | Unknown response (no choices), retrying up to 3x |
| L521 | `silentlyRetryable503.retryReason` (e.g. `'service_unavailable_503'`, `'upstream_provider_rate_limit'`) | HTTP 503 with retry signals, up to N retries |
| L553 | `'server_canceled'` | HTTP 499 (server-canceled), retrying up to 10x |
| L591 | `'server_error'` | Configurable server error status codes |
| L654 | `'network_error'` | Network connectivity failure, retrying after connectivity check |
| L858 | `retryReason` (param) | Generic retry-after-error helper |

### 7. `DefaultIntentRequestHandler.fetch()` Wrapping

In `src/extension/prompt/node/defaultIntentRequestHandler.ts` (L692-694):
```ts
finishedCb: (text, index, delta) => {
    this.telemetry.markReceivedToken();
    return opts.finishedCb!(text, index, delta);
}
```
This wrapping adds telemetry timing (`markReceivedToken`) then passes the delta unchanged upstream to the `ToolCallingLoop`'s lambda.

### 8. Tool Calling Loop's `finishedCb` Lambda (L1139-1189)

The lambda in `toolCallingLoop.ts` is the **primary consumer** on the conversation/intent side:
- Pushes deltas to `FetchStreamSource` for rendering
- Extracts structured data (tool calls, server tool calls, markers, thinking, phase, context management) into local variables
- These extracted values are used **after** the fetch resolves to determine the next tool-calling iteration
- The `stopEarly` flag (set when response processor `processResponse` promise resolves) allows early termination of the LLM stream

---

## Patterns

### Pattern 1: Dual-Purpose Callback
`finishedCb` serves two purposes simultaneously:
- **Streaming**: Pushes deltas through `FetchStreamSource` → response processor → `ChatResponseStream` for live UI rendering
- **Extraction**: Accumulates structured data (tool calls, markers) into local vars for post-fetch processing

### Pattern 2: Synthetic Delta Injection for Retry Coordination
The fetcher layer injects synthetic deltas with `retryReason` to signal upstream layers to clear their UI state before a retry. This is a **reverse-flow control signal** embedded in the data stream — no separate error channel exists.

### Pattern 3: Layered Wrapping
Each layer wraps `finishedCb` to add its concern:
1. `FetchStreamRecorder` → TTFTe tracking + delta recording
2. `DefaultIntentRequestHandler` → telemetry timing
3. `ToolCallingLoop` → data extraction + stream bridging

### Pattern 4: Stream-Based Response Processing
`FetchStreamSource` acts as a bridge between the callback world (sync push from SSE) and the async iterable world (pull from response processors), enabling decoupled response rendering.

---

## Applicability

### For 503-Retry UX Progress Feature

1. **Retry visibility hook**: The `retryReason` delta is the existing mechanism for signaling retries upstream. A UX progress indicator could intercept these deltas at the `PseudoStopStartResponseProcessor.applyDelta()` level or in the `ToolCallingLoop`'s `finishedCb` lambda.

2. **Progress reporting location**: The `FetchStreamSource.update()` call or the response processor's `applyDelta()` method are ideal injection points for showing retry progress (e.g., "Retrying 2/3...") to the user via `progress.markdown()` or a dedicated progress API.

3. **Retry count propagation**: Currently, retry count is tracked locally in `chatMLFetcher.ts` loop variables. To show "attempt N of M" in the UI, the `retryReason` delta would need to be extended with retry metadata (attempt number, max attempts), or a new delta field added.

4. **`clearToPreviousToolInvocation` impact**: On each retry, the response processor wipes rendered content back to the last tool boundary. Any progress indicator must be re-rendered after each clear, or placed outside the clearable region.

5. **Multiple retry paths**: There are at least 5 distinct retry code paths in `chatMLFetcher.ts` (filter, empty, 503, 499, server-error, network-error), each with different max attempts and backoff strategies. A unified progress mechanism would need to handle all of them.

---

## Open Questions

1. **Can `IResponseDelta` be extended with retry metadata** (attempt number, max attempts, delay) without breaking the platform/extension boundary? The interface is in `src/platform/networking/common/fetch.ts` — adding optional fields should be additive.

2. **Should progress be shown via `ChatResponseStream`** (markdown/progress parts) or via a dedicated VS Code proposed API like `ChatResponseStream.progress()`? The former renders inline; the latter may offer better UX.

3. **How does `clearToPreviousToolInvocation` interact with agent-mode multi-iteration loops?** If a 503 retry happens mid-tool-calling-loop, the clear wipes the current iteration's output, but previous iterations' tool results remain. Is this the desired behavior for the progress indicator?

4. **Is `FetchStreamSource.pause()/unpause()` used during retries?** If so, does the queued content include retry-reason deltas that might arrive out of order?

5. **The `stopEarly` flag**: If the response processor resolves early during a retry (e.g., detecting a retry reason), does the fetcher respect it and stop the current fetch before starting the retry? The code suggests yes (returns `text.length` to abort reading), but the interaction between `stopEarly` and retry loops needs validation.
