# Research: FetchStreamRecorder & retryReason Metadata Flow

**Question**: How does `FetchStreamRecorder` work, and what happens to `retryReason` metadata passed via `streamRecorder.callback()`?

---

## Findings

### FetchStreamRecorder: Structure & Purpose

`FetchStreamRecorder` (defined in `src/platform/chat/common/chatMLFetcher.ts:114-140`) is a thin wrapper around a `FinishedCallback`. It serves two roles:

1. **Delta recording**: Every delta passed through `callback()` is pushed to a public `deltas: IResponseDelta[]` array, creating a full log of all streaming events for a request.
2. **TTFT (Time-to-First-Token) tracking**: Records `firstTokenEmittedTime` on the first delta that carries meaningful content (text, tool calls, thinking).

**Constructor pattern**: Wraps an optional upstream `FinishedCallback` (called `finishedCb`), creating a new `callback` that:
```
callback(text, index, delta) → records TTFT → forwards to original finishedCb → pushes delta to deltas[]
```

The upstream `finishedCb` is the real consumer — typically a `PseudoStopStartResponseProcessor` or a `ChatResponseStreamWrapper`.

### retryReason on IResponseDelta

`retryReason` is an optional field on `IResponseDelta` (`src/platform/networking/common/fetch.ts:156`):
```ts
retryReason?: FilterReason | 'network_error' | 'server_error';
```

Where `FilterReason` includes: `hate`, `self_harm`, `sexual`, `violence`, `snippy` (copyright), `prompt`.

Additional runtime values used but not in the type union: `'empty_response'`, `'server_canceled'`, `'service_unavailable_503'`, and dynamic CAPI error codes.

### How retryReason Is Emitted

`streamRecorder.callback('', 0, { text: '', retryReason: ... })` is called in `ChatMLFetcherImpl.fetchMany()` at these points:

| Call site | retryReason value | Trigger |
|---|---|---|
| Line 316 | `result.category` (FilterReason) | Filtered response (copyright/content safety) before retry |
| Line 372 | `'empty_response'` | Unknown/empty response, up to 3 retries |
| Line 521 | `silentlyRetryable503.retryReason` | Transient 503 with explicit retry signal, up to `_maxSilent503Retries` |
| Line 553 | `'server_canceled'` | HTTP 499 server-canceled, up to 10 retries |
| Line 858 | `retryReason` param (`'network_error'` or `'server_error'`) | `_retryAfterError()` — network errors or configurable server error status codes |

### What Happens to retryReason Downstream

The delta with `retryReason` flows through the `FetchStreamRecorder.callback` → upstream `finishedCb` → eventually into `PseudoStopStartResponseProcessor.applyDelta()` (`src/extension/prompt/node/pseudoStartStopConversationCallback.ts:174-187`).

**The handler clears all accumulated progress and resets the response stream**:

```ts
if (delta.retryReason) {
    this.stagedDeltasToApply = [];
    this.currentStartStop = undefined;
    this.nonReportedDeltas = [];
    this.thinkingActive = false;
    if (delta.retryReason === 'network_error' || delta.retryReason === 'server_error') {
        progress.clearToPreviousToolInvocation(NoReason);
    } else if (delta.retryReason === FilterReason.Copyright) {
        progress.clearToPreviousToolInvocation(CopyrightContentRetry);
    } else {
        progress.clearToPreviousToolInvocation(FilteredContentRetry);
    }
    return;  // skip normal delta processing
}
```

**Key effect**: `clearToPreviousToolInvocation()` is a VS Code proposed API that rolls back the chat UI to the last tool invocation boundary, discarding all streamed text/markdown since then. The `reason` enum controls the UI message shown:
- `NoReason` (0) — silent rollback (network/server errors)
- `FilteredContentRetry` (1) — indicates content safety filter triggered
- `CopyrightContentRetry` (2) — indicates copyright similarity detected

### Recording in Request Logger

After the full fetch completes, `pendingLoggedChatRequest.resolve(result, streamRecorder.deltas)` passes the complete delta array (including retry-reason deltas) to the request logger. This means **retry events are persisted in the log** alongside normal content deltas.

---

## Patterns

1. **Signal-then-retry**: retryReason deltas are always emitted *before* the retry `fetchMany()` call. This signals the UI to clear, then the retry produces fresh content.
2. **Passthrough recording**: `FetchStreamRecorder` does not filter or transform deltas — it records everything, including empty retry-signal deltas. The `deltas[]` array is a complete audit trail.
3. **Three-tier retry classification**: The system maps many error types into three UX buckets via `clearToPreviousToolInvocation`: silent (network/server), copyright, and content-safety.
4. **Guard via options**: The `enableRetryOnFilter` and `enableRetryOnError` options gate whether retries happen at all. The API comments note: *"if using finishedCb, requires supporting delta.retryReason, eg with clearToPreviousToolInvocation"*.

---

## Applicability

For 503-retry UX work:

- **Silent 503 retries** (`_getSilentlyRetryable503Info`) emit `retryReason` with the CAPI error code (e.g., `'upstream_provider_rate_limit'`, `'service_unavailable_503'`). These hit the `else` branch in `applyDelta` → `FilteredContentRetry` reason → the UI shows a "filtered content" message, which is **semantically wrong** for a 503 overload.
- A 503 retry reason like `'service_unavailable_503'` is not `'network_error'` nor `'server_error'` nor `FilterReason.Copyright`, so it falls through to the generic `FilteredContentRetry` bucket. This is the UX mismatch.
- To fix: either map 503-specific retry reasons to `NoReason` (silent rollback), or introduce a new `ChatResponseClearToPreviousToolInvocationReason` enum value for capacity/overload retries.

---

## Open Questions

1. **Is the `FilteredContentRetry` UX message visible to end users during silent 503 retries?** If `clearToPreviousToolInvocation` with `FilteredContentRetry` shows UI chrome, users see "content filtered" for what is actually a server capacity issue.
2. **Should `_getSilentlyRetryable503Info` retryReason values be added to the `IResponseDelta.retryReason` type union?** Currently values like `'upstream_provider_rate_limit'` and `'service_unavailable_503'` are passed at runtime but not in the TypeScript type.
3. **Does the request logger (or any telemetry consumer) distinguish retry-signal deltas from content deltas?** The `deltas[]` array mixes both; consumers would need to check for `delta.retryReason` to filter.
4. **What is `_maxSilent503Retries`?** Its value was not found in the searched range — it likely comes from configuration or a static field.
