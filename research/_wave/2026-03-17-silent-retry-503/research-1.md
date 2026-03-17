# Research: HTTP Error Handling & Silent Retry in ChatMLFetcherImpl

**Question**: How does the chat request pipeline handle HTTP errors, which status codes are retried silently, and where would a 503 with `model_degraded` land?

---

## 1. Entry Point: `fetchMany()` and `enableRetryOnError`

**File**: [src/extension/prompt/node/chatMLFetcher.ts](../../../vscode-copilot-chat/src/extension/prompt/node/chatMLFetcher.ts) — Line 228

```ts
const enableRetryOnError = opts.enableRetryOnError ?? opts.enableRetryOnFilter;
```

`enableRetryOnError` defaults to `enableRetryOnFilter` when not explicitly set. In practice, all major request paths set `enableRetryOnFilter: true`:

| Caller | File | Line |
|--------|------|------|
| `defaultIntentRequestHandler` | `src/extension/prompt/node/defaultIntentRequestHandler.ts` | L718 |
| `newNotebookTool` | `src/extension/tools/node/newNotebookTool.tsx` | L78 |
| `editFileHealing` | `src/extension/tools/node/editFileHealing.tsx` | L421 |
| `applyPatchTool` | `src/extension/tools/node/applyPatchTool.tsx` | L528 |

**Result**: For all standard chat/agent requests, `enableRetryOnError` is **true**.

---

## 2. HTTP Status-to-FailKind Mapping (Server Response Parser)

**File**: [src/extension/prompt/node/chatMLFetcher.ts](../../../vscode-copilot-chat/src/extension/prompt/node/chatMLFetcher.ts) — Lines ~1430–1660 (in the response handler that processes non-200 responses)

### 4xx Status Codes

| Status | Condition | `ChatFailKind` | Retried? |
|--------|-----------|-----------------|----------|
| 400 | body contains `off_topic` | `OffTopic` | No |
| 400 | `previous_response_not_found` | `InvalidPreviousResponseId` | No |
| 401 | body contains `authorize_url` | `AgentUnauthorized` | No |
| 401/403 | other | `TokenExpiredOrInvalid` | No (token reset) |
| 402 | — | `QuotaExceeded` | No (quota surfaced) |
| 404 | — | `NotFound` | No |
| 422 | — | `ContentFilter` | No |
| 424 | — | `AgentFailedDependency` | No |
| 429 | `extension_blocked` | `ExtensionBlocked` | No |
| 429 | other | `RateLimited` | No |
| 466 | — | `ClientNotSupported` | No |
| 499 | — | `ServerCanceled` | **Yes** (up to 10 retries, linear backoff) |

### 5xx Status Codes

| Status | `ChatFailKind` | Notes |
|--------|-----------------|-------|
| **503** | `RateLimited` | Hardcoded — treated as upstream provider rate limit, NOT as `ServerError` |
| 500, 501, 502, 504+ | `ServerError` | Generic 5xx fallback |

### Anything else (outside 400–599)

Falls through to `ChatFailKind.Unknown`.

---

## 3. Three Retry Pathways in `FetchResponseKind.Failed`

**File**: [src/extension/prompt/node/chatMLFetcher.ts](../../../vscode-copilot-chat/src/extension/prompt/node/chatMLFetcher.ts) — Lines 500–560

### Pathway A: ServerCanceled (HTTP 499) — Lines 502–523

```ts
if (enableRetryOnError && response.failKind === ChatFailKind.ServerCanceled) {
    // Up to 10 retries with linear backoff (attempt * 1000ms)
}
```

- **Applies to**: HTTP 499 only
- **Max retries**: 10
- **Backoff**: linear (1s, 2s, ... 10s)

### Pathway B: Server Error Status Codes — Lines 527–557

```ts
const retryServerErrorStatusCodes = this._configurationService.getExperimentBasedConfig(
    ConfigKey.TeamInternal.RetryServerErrorStatusCodes, this._experimentationService);
const statusCodesToRetry = retryServerErrorStatusCodes.split(',').map(s => parseInt(s.trim(), 10));
const retryAfterServerError = enableRetryOnError
    && response.failKind !== ChatFailKind.ServerCanceled
    && actualStatusCode !== undefined
    && statusCodesToRetry.includes(actualStatusCode);
```

- **Default config value**: `'500,502'` (from `configurationService.ts` line 897)
- **Config key**: `chat.advanced.retryServerErrorStatusCodes`
- **Calls**: `_retryAfterError()` which checks network connectivity first, then retries once
- **503 is NOT in the default list**

### Pathway C: WebSocket Fallback — Line 532

```ts
const retryWithoutWebSocket = enableRetryOnError && useWebSocket;
```

Retries any failed request if it was using WebSocket, falling back to HTTP.

---

## 4. Additional Retry: Empty/Unknown Response — Lines 362–385

```ts
if (enableRetryOnError && result.type === ChatFetchResponseType.Unknown) {
    // Up to 3 retries with backoff (attempt * 2000ms)
}
```

Retries when a successful HTTP response returned no useful choices.

---

## 5. Network Error Retries (catch block) — Lines 594–615

```ts
const retryNetworkError = enableRetryOnError
    && processed.type === ChatFetchResponseType.NetworkError
    && this._configurationService.getExperimentBasedConfig(ConfigKey.TeamInternal.RetryNetworkErrors, ...);
```

- **Config key**: `chat.advanced.enableRetryNetworkErrors` (default: `true`)
- Also handles `ERR_NETWORK_CHANGED` and Electron network process crashes

---

## 6. `ChatFetchRetriableError` Type

**File**: [src/platform/chat/common/commonTypes.ts](../../../vscode-copilot-chat/src/platform/chat/common/commonTypes.ts) — Lines 184–188

```ts
export type ChatFetchRetriableError<T> =
    { type: ChatFetchResponseType.FilteredRetry; reason: string; category: FilterReason; value: T; ... }
```

This type only covers content-filter retries (snippy/copyright), not HTTP error retries. The HTTP error retry logic is entirely procedural in `fetchMany()`, not type-driven.

---

## 7. `_retryAfterError()` Implementation

**File**: [src/extension/prompt/node/chatMLFetcher.ts](../../../vscode-copilot-chat/src/extension/prompt/node/chatMLFetcher.ts) — Lines 731–830

Key behavior:
1. Checks network connectivity first (`_checkNetworkConnectivity()`)
2. If unreachable, **does not retry** (returns empty)
3. Sends error telemetry for the original failure (marked `wasRetried: true`)
4. Retries **exactly once** with `enableRetryOnError: false` (prevents retry loops)
5. Falls back from WebSocket to HTTP if applicable

---

## 8. Where a 503 with `model_degraded` Lands

### Current Flow

1. **HTTP response**: status 503 received
2. **Status parsing** (line ~1638): Matches `response.status === 503` → returns `ChatFailKind.RateLimited` with:
   - `reason: 'Upstream provider rate limit hit'`
   - `capiError: { code: 'upstream_provider_rate_limit', message: <body text> }`
   - The `model_degraded` info in the response body is **discarded** — the code hardcodes the error code to `'upstream_provider_rate_limit'`

3. **`processFailedResponse()`** (line ~1892): `ChatFailKind.RateLimited` → `ChatFetchResponseType.RateLimited`

4. **Retry check** (line 531): The retry-after-server-error condition requires:
   - `response.failKind !== ChatFailKind.ServerCanceled` → ✅ (it's `RateLimited`)
   - `actualStatusCode !== undefined` → ✅
   - `statusCodesToRetry.includes(actualStatusCode)` → **❌ (503 is NOT in default `'500,502'`)**

5. **Result**: The 503 is **NOT retried**. It is surfaced to the user as a rate-limit error with the message:
   > "Sorry, the upstream model provider is currently experiencing high demand. Please try again later or consider switching to Auto."
   (from `getRateLimitMessage()` in `commonTypes.ts` line ~205 which checks `capiError?.code === 'upstream_provider_rate_limit'`)

### Why 503 Is Not Retried

Two compounding reasons:
1. **503 is mapped to `RateLimited`, not `ServerError`** — The retry-status-code path checks `statusCodesToRetry` against `actualStatusCode`, but achieves nothing because the `failKind` is `RateLimited` (not `ServerCanceled`), and 503 is not in the default `'500,502'` list.
2. **Even if 503 were in `statusCodesToRetry`**, it would pass the `statusCodesToRetry.includes(503)` check and hit `_retryAfterError()`, which retries once — this would work. But currently 503 isn't listed.

### To Enable 503 Retries

Either:
- **Option A**: Add `503` to the `RetryServerErrorStatusCodes` default: change `'500,502'` to `'500,502,503'` at line 897 of `configurationService.ts`
- **Option B**: Add a separate retry pathway for `ChatFailKind.RateLimited` with specific CAPI error codes like `model_degraded`
- **Option C**: Change the 503 handler to return `ChatFailKind.ServerError` instead of `RateLimited` (but this changes user-facing messaging)

---

## Summary Table: All Silent Retry Scenarios

| Trigger | Max Retries | Backoff | Gate |
|---------|-------------|---------|------|
| HTTP 499 (ServerCanceled) | 10 | Linear (N × 1s) | `enableRetryOnError` |
| HTTP 500, 502 (configurable) | 1 | Connectivity check | `enableRetryOnError` + `statusCodesToRetry` |
| Empty/Unknown response | 3 | Linear (N × 2s) | `enableRetryOnError` |
| Content filter (snippy/copyright) | 1 | None | `enableRetryOnFilter` |
| Network error | 1 | Connectivity check | `enableRetryOnError` + `RetryNetworkErrors` config |
| WebSocket failure | 1 | Connectivity check | `enableRetryOnError` + `useWebSocket` |

**HTTP 503 is NOT silently retried. It is surfaced as a rate-limit error.**
