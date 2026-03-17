# Research-5: Retry Mechanisms & Patterns Catalog in vscode-copilot-chat

**Question**: What existing retry mechanisms exist that a silent 503 retry could follow?

**Date**: 2026-03-17

---

## 1. Catalog of All Retry Patterns

### Pattern A: `canRetryOnceWithoutRollback` — Low-Level Network Retry

- **Location**: [src/platform/networking/common/networking.ts](src/platform/networking/common/networking.ts) lines 329, 355, 415–431
- **Mechanism**: On `ECONNRESET`, `ETIMEDOUT`, `ERR_NETWORK_CHANGED`, `ERR_HTTP2_*` errors, the fetcher disconnects all connections and retries the fetch **once** immediately (no backoff).
- **Scope**: Operates at the raw HTTP fetch level, inside `networkRequest()`.
- **Backoff**: None — immediate retry after `fetcher.disconnectAll()`.
- **Guard**: `canRetryOnce` flag (defaults to `true`), checked via `canRetryOnceNetworkError(reason)` which matches specific error codes.
- **Eligible errors** (from `canRetryOnceNetworkError`):
  ```
  ECONNRESET, ETIMEDOUT, ERR_CONNECTION_RESET, ERR_NETWORK_CHANGED,
  ERR_HTTP2_INVALID_SESSION, ERR_HTTP2_STREAM_CANCEL,
  ERR_HTTP2_GOAWAY_SESSION, ERR_HTTP2_PROTOCOL_ERROR
  ```
- **Surface**: [networking.ts lines 433–443](src/platform/networking/common/networking.ts#L433-L443)

---

### Pattern B: WebSocket → HTTP Fallback

- **Location**: [src/extension/prompt/node/chatMLFetcher.ts](src/extension/prompt/node/chatMLFetcher.ts) lines 100–113, 175–180, 532–533, 595–596, 830–843
- **Mechanism**: When a WebSocket request fails (network error or server error), the system retries via HTTP (`useWebSocket: false`). After 3 consecutive WS failures with successful HTTP fallback, WebSocket is disabled entirely for subsequent requests.
- **Trigger**: `retryWithoutWebSocket = enableRetryOnError && useWebSocket` — activates on both `Failed` response kind (line 532) and caught exceptions producing `NetworkError`/`Failed` types (line 595).
- **Backoff**: No intrinsic backoff; uses connectivity check delays before the HTTP retry (Pattern F).
- **Counter**: `_consecutiveWebSocketRetryFallbacks` tracks consecutive fallbacks; threshold is `_maxConsecutiveWebSocketFallbacks = 3`.
- **Key detail**: The retry call sets `useWebSocket: false, enableRetryOnError: false` to prevent retry loops.

---

### Pattern C: `ChatFetchRetriableError` / Filter Retry

- **Location**: [src/platform/chat/common/commonTypes.ts](src/platform/chat/common/commonTypes.ts) lines 184–189
- **Type**: `ChatFetchRetriableError<T>` — a `FilteredRetry` response type.
- **Mechanism**: When the AI response is filtered by RAI (snippy), the system can retry with augmented messages (adding a system prompt to encourage compliance). Controlled by `enableRetryOnFilter`.
- **Usage in chatMLFetcher.ts**: Lines 300–355 — on `FilteredRetry` result, it augments messages and calls `this.fetchMany()` recursively.
- **Backoff**: None — immediate retry.
- **Guard**: `enableRetryOnFilter: false` on the retry call prevents infinite loops; `canRetryOnceWithoutRollback: false` disables Pattern A.

---

### Pattern D: [FORK] Empty Response Retry

- **Location**: [src/extension/prompt/node/chatMLFetcher.ts](src/extension/prompt/node/chatMLFetcher.ts) lines 362–385
- **Mechanism**: When the model returns `ChatFetchResponseType.Unknown` (no choices), retries up to **3 times** with **linear backoff** (`attempt * 2000ms` → 2s, 4s, 6s).
- **Backoff**: Linear — `attempt * 2000ms`.
- **Guard**: `enableRetryOnError` must be true; retry calls set `enableRetryOnError: false` to prevent recursion.
- **Telemetry**: Tags retry with `retryAfterError: 'empty_response'`.
- **Log prefix**: `[FORK]` — this is a fork-specific addition.
- **Exit**: If all 3 retries still return `Unknown`, logs exhaustion and falls through to normal error handling.

---

### Pattern E: ServerCanceled (HTTP 499) Retry

- **Location**: [src/extension/prompt/node/chatMLFetcher.ts](src/extension/prompt/node/chatMLFetcher.ts) lines 502–527
- **Mechanism**: On `ChatFailKind.ServerCanceled` (HTTP 499), retries up to **10 times** with **linear backoff** (`attempt * 1000ms` → 1s, 2s, ... 10s).
- **Backoff**: Linear — `attempt * 1000ms`.
- **Guard**: `enableRetryOnError` required; each retry sets `enableRetryOnError: false`.
- **Break condition**: Stops retrying if the response is no longer the same cancellation error.
- **Log**: `Retrying canceled-by-server request, attempt N/10...`

---

### Pattern F: Server Error Status Code Retry (via `_retryAfterError`)

- **Location**: [src/extension/prompt/node/chatMLFetcher.ts](src/extension/prompt/node/chatMLFetcher.ts) lines 528–565, 731–843
- **Config**: `RetryServerErrorStatusCodes` setting (line 897 of configurationService.ts) — default: `'500,502'`.
- **Mechanism**: On `FetchResponseKind.Failed` where `actualStatusCode` is in the configured list (and fail kind is not `ServerCanceled`), calls `_retryAfterError()`:
  1. Checks for `ERR_NETWORK_CHANGED` or Electron network process crash → falls back to `node-fetch`.
  2. Calls `_checkNetworkConnectivity()` (Pattern G) to verify connectivity.
  3. If connectivity confirmed, retries with `useWebSocket: false, enableRetryOnError: false`.
- **Backoff**: Indirect — the connectivity check introduces delays (Pattern G).
- **CRITICAL for 503**: Currently **503 is NOT in the default retry status codes** (`'500,502'`). Moreover, 503 is mapped to `ChatFailKind.RateLimited` in `_handleError()` (line 1636–1646), not `ChatFailKind.ServerError`. The `retryAfterServerError` path explicitly excludes `ServerCanceled`, but because 503 maps to `RateLimited` (not `ServerError`), it gets processed as a rate limit — shown to user as "Upstream provider rate limit hit" — and **never enters the server error retry path**.

---

### Pattern G: Connectivity Check Delays

- **Location**: [src/extension/prompt/node/chatMLFetcher.ts](src/extension/prompt/node/chatMLFetcher.ts) lines 103–112, 679–712
- **Delays**: `[1000, 10000, 10000]` ms (1s, 10s, 10s) — total 21 seconds maximum wait.
- **Mechanism**: Pings CAPI endpoint to verify network connectivity before retrying. Iterates through delay array, sleeping then pinging. On 2xx response, returns `retryRequest: true`. On non-2xx or exception, continues to next delay.
- **Used by**: `_retryAfterError()` (Pattern F) for both network errors and server errors.

---

### Pattern H: `RetryNetworkErrors` Config-Gated Retry

- **Location**: [src/extension/prompt/node/chatMLFetcher.ts](src/extension/prompt/node/chatMLFetcher.ts) line 594; config at [configurationService.ts](src/platform/configuration/common/configurationService.ts) line 896.
- **Config**: `chat.advanced.enableRetryNetworkErrors` — experiment-based, default `true`.
- **Mechanism**: When a caught exception produces `ChatFetchResponseType.NetworkError`, and this config is enabled, calls `_retryAfterError()` (Pattern F) with connectivity check.
- **Scope**: Only for thrown exceptions (not HTTP status code failures).

---

## 2. How 503 Is Currently Handled

The 503 path in `_handleError()` (chatMLFetcher.ts lines 1636–1646):

```typescript
if (response.status === 503) {
    return {
        type: FetchResponseKind.Failed,
        modelRequestId: modelRequestIdObj,
        failKind: ChatFailKind.RateLimited,
        reason: 'Upstream provider rate limit hit',
        data: {
            retryAfter: null,
            rateLimitKey: null,
            capiError: { code: 'upstream_provider_rate_limit', message: text }
        }
    };
}
```

This returns `ChatFailKind.RateLimited`, which in `processFailedResponse()` maps to `ChatFetchResponseType.RateLimited`. The `RateLimited` type is **never retried** — it's displayed to the user as a rate limit message.

---

## 3. Best-Fit Pattern for `model_degraded` 503 Retry

### Recommendation: Hybrid of Pattern D (FORK empty retry) + Pattern E (ServerCanceled)

**Why this hybrid is the best fit:**

| Criterion | Pattern D (FORK) | Pattern E (499) | Pattern F (_retryAfterError) |
|-----------|-----------------|-----------------|------------------------------|
| Backoff | Linear (2s increments) | Linear (1s increments) | Connectivity delays (21s) |
| Max attempts | 3 | 10 | 1 (after connectivity) |
| Inline loop | Yes | Yes | No (delegates to helper) |
| Complexity | Low | Low | High (connectivity check) |
| Fit for transient degradation | **Best** | Good | Overkill |

**Recommended implementation strategy:**

1. **Detection**: In `_handleError()`, check if 503 response body contains `model_degraded` (or similar signal). If yes, return a new `ChatFailKind` (e.g. `ModelDegraded`) instead of `RateLimited`.

2. **Retry location**: In the `FetchResponseKind.Failed` case block (around line 500), add a new branch for `ChatFailKind.ModelDegraded` — similar to the ServerCanceled block (Pattern E).

3. **Backoff strategy**: Use **exponential backoff with jitter**, modeled on Pattern D's linear approach but improved:
   ```
   delay = min(baseDelay * 2^attempt + jitter, maxDelay)
   ```
   - Base: 2000ms, Max: 30000ms, Attempts: 3–5
   - Jitter: random 0–1000ms

4. **Telemetry**: Tag with `retryReason: 'model_degraded'` and `retryAfterError: 'model_degraded_503'`.

5. **Guard**: Set `enableRetryOnError: false` on retry (same as all existing patterns).

6. **Key advantage**: Unlike Pattern F, this avoids unnecessary connectivity checks (the server _is_ reachable — it responded with 503). Unlike Pattern E, fewer attempts are needed since degradation is typically resolved in seconds.

### Alternative: Add `503` to `RetryServerErrorStatusCodes`

This is simpler but has drawbacks:
- The `_retryAfterError` path does a full connectivity check (21s delay) which is wasteful for a server that already responded.
- 503 is currently mapped to `RateLimited`, not `ServerError`, so `retryAfterServerError` would need the ChatFailKind mapping fixed first.
- No backoff control — it's one retry after connectivity check.

---

## 4. Summary Table

| Pattern | Trigger | Max Retries | Backoff | Connectivity Check | Location |
|---------|---------|-------------|---------|-------------------|----------|
| A: canRetryOnce | ECONNRESET, ETIMEDOUT, etc. | 1 | None | No | networking.ts:415 |
| B: WS→HTTP | WS failure | 1 (+disable after 3) | Via Pattern G | Yes | chatMLFetcher.ts:532,595 |
| C: FilterRetry | RAI filtered response | 1 | None | No | chatMLFetcher.ts:300–355 |
| D: [FORK] Empty | Unknown/no choices | 3 | Linear 2s×N | No | chatMLFetcher.ts:362–385 |
| E: ServerCanceled | HTTP 499 | 10 | Linear 1s×N | No | chatMLFetcher.ts:502–527 |
| F: ServerError | HTTP 500,502 (configurable) | 1 | Via Pattern G | Yes | chatMLFetcher.ts:528–565 |
| G: Connectivity | Used by F, H | 3 pings | 1s, 10s, 10s | Is the check | chatMLFetcher.ts:679–712 |
| H: NetworkError | Thrown exception | 1 | Via Pattern G | Yes | chatMLFetcher.ts:594 |

---

## 5. Key Files

| File | Role |
|------|------|
| `src/extension/prompt/node/chatMLFetcher.ts` | All retry orchestration |
| `src/platform/networking/common/networking.ts` | Low-level fetch retry (Pattern A) |
| `src/platform/chat/common/commonTypes.ts` | Response types and ChatFetchRetriableError |
| `src/platform/openai/node/fetch.ts` | ChatFailKind enum |
| `src/platform/configuration/common/configurationService.ts` | Retry config settings |
