# Research-7: 499/Server-Canceled Retry Loop — UI Communication

## Findings

### How the 499 Retry Loop Works

The 499 retry is implemented in [chatMLFetcher.ts](../../../vscode-copilot-chat/src/extension/prompt/node/chatMLFetcher.ts#L546-L568):

1. When a response returns HTTP 499, it's classified as `ChatFailKind.ServerCanceled` (L1712)
2. The retry loop runs up to **10 attempts** with **linear backoff** (`attempt * 1000ms`)
3. Each attempt is cancellation-aware (`token.isCancellationRequested`)
4. On each retry attempt, a delta is emitted: `streamRecorder.callback('', 0, { text: '', retryReason: 'server_canceled' })` (L553)

### How `retryReason` Flows to the UI

The delta callback chain:
1. `FetchStreamRecorder.callback` → wraps the `finishedCb` and records deltas
2. The `finishedCb` routes through `PseudoStopStartResponseProcessor.applyDelta()` in [pseudoStartStopConversationCallback.ts](../../../vscode-copilot-chat/src/extension/prompt/node/pseudoStartStopConversationCallback.ts#L173-L188)

In `applyDelta` (L174-187), when `delta.retryReason` is truthy:
- All staged/pending state is cleared (staged deltas, start/stop state, thinking state)
- Then a branch determines which `ClearToPreviousToolInvocationReason` to use:
  - `'network_error'` or `'server_error'` → `NoReason` 
  - `FilterReason.Copyright` → `CopyrightContentRetry`
  - **Everything else** → `FilteredContentRetry`

### Where `'server_canceled'` Lands

`'server_canceled'` is **not** `'network_error'`, not `'server_error'`, and not `FilterReason.Copyright`. It falls into the **else** branch → `clearToPreviousToolInvocation(ChatResponseClearToPreviousToolInvocationReason.FilteredContentRetry)`.

### Type Mismatch Issue

The `IResponseDelta.retryReason` type is `FilterReason | 'network_error' | 'server_error'` (see [fetch.ts](../../../vscode-copilot-chat/src/platform/networking/common/fetch.ts#L156)). The string `'server_canceled'` is **not** included in this union type. This works at runtime because TypeScript doesn't enforce string literal unions at runtime, but it's a type-level inconsistency.

### Visible UI Feedback

| Aspect | Behavior |
|--------|----------|
| **Logging** | `_logService.info("Retrying canceled-by-server request, attempt N/10...")` — internal log only, not user-visible |
| **Stream clearing** | `clearToPreviousToolInvocation(FilteredContentRetry)` is called on each retry — this rolls back the chat response stream to the last tool invocation boundary |
| **Progress indicator** | No explicit progress message (e.g., "Retrying...") is shown to the user |
| **Spinner/status** | The chat remains in its "waiting for response" state (spinner continues) since the request hasn't resolved |
| **Delay** | Linear backoff (1s, 2s, ... 10s) between attempts; total max wait ≈ 55 seconds |
| **Final failure** | If all 10 retries exhaust, falls through to standard error telemetry and error display |

### What `clearToPreviousToolInvocation` Does

From the VS Code proposed API ([chatParticipantAdditions.d.ts](../../../vscode-copilot-chat/src/extension/vscode.proposed.chatParticipantAdditions.d.ts#L660)):
- Clears the response stream back to the previous tool invocation boundary
- With `FilteredContentRetry` reason, VS Code core may show a brief "content was filtered" indicator while the retry proceeds
- The partial response accumulated before the 499 is discarded from the UI

## Patterns

1. **Silent retry with stream rollback**: The 499 retry uses the same `retryReason` delta mechanism as content filters and 503 retries — emit a marker delta that clears the UI stream, then re-fetch transparently
2. **Shared infrastructure, divergent semantics**: `server_canceled` piggybacks on the `FilteredContentRetry` codepath even though it's not a content filter — it's a server-side cancellation. This is a design shortcut.
3. **Log-only diagnostics**: Retry progress is logged (`_logService.info`) but never surfaced to the user through progress messages or status bar updates
4. **Linear backoff**: Unlike the 503 retry (which uses server-provided `retry-after` headers), the 499 retry uses simple linear backoff with no jitter

## Applicability

- The 499 retry provides **no user-visible feedback** beyond the chat spinner continuing to spin. Users cannot tell whether the system is retrying or simply slow.
- The `FilteredContentRetry` reason is semantically wrong for server cancellations — it may cause VS Code core to show misleading "filtered content" hints depending on how core interprets the reason enum.
- 503 retries have richer logging (`🔄 [503-RETRY]` prefix with retry reason and delay) vs. 499 retries which use plain `info` messages.

## Open Questions

1. **Type safety**: Should `'server_canceled'` be added to the `IResponseDelta.retryReason` union type, or should the 499 retry use an existing value like `'server_error'`?
2. **Semantic mismatch**: Does VS Code core distinguish between `FilteredContentRetry` and `NoReason` in `clearToPreviousToolInvocation`? If so, using `FilteredContentRetry` for server cancellations may trigger unintended UI behaviors.
3. **User feedback gap**: Should the 499 retry show a progress message (e.g., `progress.progress("Server busy, retrying...")`) so users know what's happening during the up-to-55-second retry window?
4. **Exhaustion behavior**: When all 10 retries fail, the code falls through to generic error telemetry — is the resulting error message meaningful to users, or does it show a cryptic "canceled by server" string?
