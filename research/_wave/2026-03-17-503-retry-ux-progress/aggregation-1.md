## Aggregation Report 1

### Source Reports

1. **research-1.md** — FetchStreamRecorder structure, retryReason delta lifecycle, and how 503 retry reasons are misclassified in the UX layer
2. **research-2.md** — Full finishedCb delta propagation chain from ChatMLFetcherImpl through to PseudoStopStartResponseProcessor, including all wrapping layers and injection points
3. **research-3.md** — Complete inventory of VS Code Chat response part types (stable + proposed), with applicability analysis for retry UX

### Deduplicated Findings

#### F1: FetchStreamRecorder Is a Transparent Recording Wrapper
`FetchStreamRecorder` (`chatMLFetcher.ts:114-140`) wraps a `FinishedCallback`, records every delta (including synthetic retry-signal deltas) to `deltas[]`, tracks TTFT, and forwards unmodified to the upstream callback. It does not filter or transform. [source: research-1.md#L7-L22] [source: research-2.md#L19-L34]

#### F2: retryReason Is an IResponseDelta Field with Runtime Type Gaps
`retryReason` on `IResponseDelta` (`fetch.ts:156`) is typed as `FilterReason | 'network_error' | 'server_error'`, but runtime values also include `'empty_response'`, `'server_canceled'`, `'service_unavailable_503'`, and dynamic CAPI error codes like `'upstream_provider_rate_limit'` — none of which are in the TypeScript union. [source: research-1.md#L24-L31]

#### F3: Six Distinct Retry Injection Points in chatMLFetcher.ts
Synthetic `retryReason` deltas are emitted before retry attempts at these points:

| Site | retryReason | Trigger | Max Retries |
|------|------------|---------|-------------|
| L316 | `result.category` (FilterReason) | Copyright/content-safety filter | configurable |
| L372 | `'empty_response'` | No choices in response | 3 |
| L521 | CAPI error code (e.g. `'service_unavailable_503'`) | HTTP 503 with retry signal | `_maxSilent503Retries` |
| L553 | `'server_canceled'` | HTTP 499 server-canceled | 10 |
| L591 | `'server_error'` | Configurable server error codes | configurable |
| L654 | `'network_error'` | Network connectivity failure | configurable |

[source: research-1.md#L33-L44] [source: research-2.md#L74-L87]

#### F4: Full Delta Propagation Chain (7 Layers)
```
ChatMLFetcherImpl.fetchMany()
  → FetchStreamRecorder.callback()        [recording + TTFT]
    → DefaultIntentRequestHandler.fetch()  [telemetry timing]
      → ToolCallingLoop lambda (L1139)     [extraction + stream bridge]
        → FetchStreamSource.update()       [callback→async iterable bridge]
          → PseudoStopStartResponseProcessor.applyDelta()  [rendering]
            → ChatResponseStream.*()       [VS Code UI]
```
[source: research-2.md#L36-L56]

#### F5: PseudoStopStartResponseProcessor Handles retryReason with Three-Tier Classification
`applyDelta()` (`pseudoStartStopConversationCallback.ts:174-187`) clears all accumulated state and calls `clearToPreviousToolInvocation(reason)` with:
- `NoReason` (0) — for `'network_error'` / `'server_error'` → silent rollback
- `CopyrightContentRetry` (2) — for `FilterReason.Copyright`
- `FilteredContentRetry` (1) — **everything else** (catch-all)

[source: research-1.md#L46-L66] [source: research-2.md#L58-L72]

#### F6: 503 Retry Reasons Fall Into the Wrong UX Bucket (THE BUG)
503-specific retry reasons (`'service_unavailable_503'`, `'upstream_provider_rate_limit'`) are not `'network_error'`, `'server_error'`, or `FilterReason.Copyright`, so they fall through to the `else` branch → `FilteredContentRetry`. This shows "content filtered" messaging for what is actually a server capacity issue. [source: research-1.md#L81-L86]

#### F7: VS Code Chat Response Part Inventory for Retry UX
Relevant stable and proposed parts:

| Part | Type | Best Use for Retry UX |
|------|------|-----------------------|
| `ChatResponseProgressPart` | Stable | Transient spinner: "Retrying (2/3)…" |
| `ChatResponseProgressPart2` | Proposed | Progress with async task + sub-warnings during retry |
| `ChatResponseWarningPart` | Proposed | Persistent banner: "Service temporarily unavailable" |
| `ChatResponseMarkdownPart` | Stable | Inline retry status text |
| `ChatToolInvocationPart` | Proposed | Wrap retry as visible tool call with input/output |

No `ChatResponseErrorPart` exists — errors use `ChatResponseWarningPart`, `ChatResult.errorDetails`, or `ChatToolInvocationPart.isError`. [source: research-3.md#L1-L50] [source: research-3.md#L105-L120]

#### F8: ToolCallingLoop Lambda Serves Dual Purpose
The `finishedCb` lambda at `toolCallingLoop.ts:L1139` both pushes deltas to `FetchStreamSource` for live UI rendering AND extracts structured data (tool calls, markers, thinking, phase) into local variables for post-fetch iteration logic. [source: research-2.md#L56-L67]

#### F9: clearToPreviousToolInvocation Wipes Content to Last Tool Boundary
On each retry, all rendered content since the last tool invocation is discarded. Any progress indicator must either be re-rendered after each clear, or placed outside the clearable region (e.g., as a tool invocation itself). [source: research-2.md#L95-L100] [source: research-1.md#L59-L65]

#### F10: Retry Deltas Are Fully Logged
`pendingLoggedChatRequest.resolve(result, streamRecorder.deltas)` persists the complete delta array including retry-signal deltas. Retry events are part of the audit trail alongside content deltas. [source: research-1.md#L68-L71]

### Cross-Report Patterns

**P1: 503 UX Misclassification Is the Core Bug** (research-1 + research-2, HIGH confidence)
Both reports independently identify that 503 retry reasons (`'service_unavailable_503'`, `'upstream_provider_rate_limit'`) hit the `FilteredContentRetry` catch-all in `PseudoStopStartResponseProcessor.applyDelta()`, producing semantically wrong UX messaging. The fix point is the same `if/else if/else` chain at `pseudoStartStopConversationCallback.ts:174-187`.

**P2: Two-Layer Fix Required — Signal + Display** (research-1 + research-2 + research-3, HIGH confidence)
All three reports converge on the need for:
1. **Signal fix**: Map 503/capacity retry reasons to `NoReason` (or a new enum value) in `applyDelta()`
2. **Display fix**: Use `stream.progress()` or `stream.warning()` to show retry status to the user instead of the misleading "filtered content" message

**P3: retryReason IResponseDelta Extension Needed** (research-1 + research-2, HIGH confidence)
Both reports note the TypeScript type gap — runtime 503 values aren't in the type union. Both suggest adding retry metadata (attempt number, max attempts) to `IResponseDelta` as optional fields to enable "attempt N of M" UX. The `IResponseDelta` interface in `fetch.ts` is in the platform layer; adding optional fields is additive and non-breaking.

**P4: Injection Point Convergence** (research-2 + research-3, HIGH confidence)
research-2 identifies `PseudoStopStartResponseProcessor.applyDelta()` as the ideal code injection point; research-3 identifies `stream.progress()` and `stream.warning()` as the ideal VS Code API to call at that point. Together they define the complete implementation location.

**P5: clearToPreviousToolInvocation Constrains Progress UX Design** (research-1 + research-2 + research-3, MEDIUM confidence)
All three reports note that retry clears wipe rendered content. Any progress indicator must account for this — either by being re-emitted after each `clearToPreviousToolInvocation` call, by using a proposed API part that survives clearing, or by wrapping the retry as a tool invocation itself (which acts as a boundary and survives).

### Priority Matrix

| Pattern | Impact | Effort | Sources |
|---------|--------|--------|---------|
| P1: Fix 503 UX misclassification in applyDelta() | HIGH — users see wrong "filtered" msg | LOW — single if/else branch addition | [research-1.md#L81-L86](research-1.md#L81-L86), [research-2.md#L58-L72](research-2.md#L58-L72) |
| P2: Add retry progress/warning display | HIGH — users get no retry visibility | MEDIUM — new stream.progress() calls + delta metadata | [research-2.md#L89-L100](research-2.md#L89-L100), [research-3.md#L105-L120](research-3.md#L105-L120) |
| P3: Extend IResponseDelta type union + add retry metadata | MEDIUM — type safety + enables "N of M" UX | LOW — additive optional fields | [research-1.md#L24-L31](research-1.md#L24-L31), [research-2.md#L103-L105](research-2.md#L103-L105) |
| P4: Implement at applyDelta() using stream.progress/warning | HIGH — defines the exact code path | LOW — location is pinpointed | [research-2.md#L89-L95](research-2.md#L89-L95), [research-3.md#L105-L115](research-3.md#L105-L115) |
| P5: Handle clearToPreviousToolInvocation interaction | MEDIUM — prevents progress indicator from being wiped | MEDIUM — design decision on placement | [research-1.md#L59-L65](research-1.md#L59-L65), [research-2.md#L95-L100](research-2.md#L95-L100), [research-3.md#L108-L112](research-3.md#L108-L112) |

### Gaps

1. **Actual `clearToPreviousToolInvocation` rendering behavior**: No report verified what the user actually *sees* in VS Code when `FilteredContentRetry` vs `NoReason` is used. A screenshot or manual test would confirm the UX impact.
2. **`_maxSilent503Retries` value**: research-1 notes this value was not found — it likely comes from configuration but the actual default is unknown.
3. **Proposed API availability in production**: research-3 notes `ChatResponseWarningPart` and `ChatResponseProgressPart2` require `chatParticipantAdditions` proposed API — no report confirms whether the Copilot Chat extension already has this enabled (it almost certainly does, but was not verified).
4. **Backoff timing during 503 retries**: No report documents the delay/backoff strategy between 503 retry attempts, which affects how long a progress indicator needs to persist.
5. **Multi-model behavior**: Reports focus on the generic fetch path. No analysis of whether different model endpoints (Claude, Gemini, GPT-4) produce different 503 response shapes that might need distinct handling.
6. **Agent mode interaction**: No report analyses how 503 retries interact with agent-mode multi-step tool calling loops beyond noting that `clearToPreviousToolInvocation` preserves previous tool results.

### Sources

- **research-1.md**: FetchStreamRecorder structure, retryReason metadata flow, 503 misclassification analysis
- **research-2.md**: Full finishedCb delta propagation chain, injection points, dual-purpose callback patterns
- **research-3.md**: VS Code Chat response part type inventory (stable + proposed), retry UX applicability analysis
