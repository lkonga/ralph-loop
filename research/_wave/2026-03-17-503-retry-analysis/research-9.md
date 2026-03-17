# Research 9: How `ChatRequestFailed` Carries Response Data for `_getSilentlyRetryable503Info`

## Findings

### The `ChatRequestFailed` Interface (src/platform/openai/node/fetch.ts, L20–26)

The interface is deliberately minimal — it does **not** carry raw HTTP `statusCode`, `headers`, or `responseText` fields:

```ts
export interface ChatRequestFailed {
  type: FetchResponseKind.Failed;
  modelRequestId: RequestId | undefined;
  failKind: ChatFailKind;
  reason: string;
  data?: Record<string, any>;   // ← the escape hatch
}
```

All HTTP response details are **pre-digested** inside `_handleError()` (chatMLFetcher.ts L1514–1760) and stuffed into the untyped `data?: Record<string, any>` bag. The raw `Response` object is never exposed outside `_handleError`.

### What `_handleError` puts into `data` for a 503

At chatMLFetcher.ts L1719–1734, the 503 branch constructs:

```ts
data: {
  retryAfter,     // string | null — from response.headers.get('retry-after')
  rateLimitKey,   // string | null — from response.headers.get('x-ratelimit-exceeded')
  capiError,      // Record<string, any> — JSON-parsed body, or { message: text }
}
```

The `capiError` sub-object preserves the full JSON error body which typically includes `code` (e.g., `'model_degraded'`, `'upstream_provider_rate_limit'`) and `type` (e.g., `'rate_limit_error'`).

### How `_getSilentlyRetryable503Info` Reads the Data (L907–928)

The method receives two arguments: the `ChatRequestFailed` response and the `actualStatusCode` (threaded separately via the fetch result tuple):

```ts
_getSilentlyRetryable503Info(response: ChatRequestFailed, actualStatusCode: number | undefined)
```

It reads:
| Field accessed | Source |
|---|---|
| `response.data?.retryAfter` (string) | `retry-after` header |
| `response.data?.rateLimitKey` (string) | `x-ratelimit-exceeded` header |
| `response.data?.capiError?.code` (string) | JSON body `.error.code` or root `.code` |
| `response.data?.capiError?.type` (string) | JSON body `.error.type` or root `.type` |

The actual HTTP status code (`503`) is **not** on `ChatRequestFailed` — it travels as a separate `actualStatusCode` number through `_fetchAndStreamChat` → `fetchResult.statusCode` → the calling method at L504.

### Decision Logic

1. **Guard**: `actualStatusCode !== 503` → return undefined (not retryable)
2. **Explicit retry signal**: `retryAfter` present, OR `rateLimitKey` present, OR `capiErrorCode === 'upstream_provider_rate_limit'`, OR `capiErrorType === 'rate_limit_error'` → retryable
3. **Known error code**: `capiErrorCode` in `_silentlyRetryable503ErrorCodes` (currently only `'model_degraded'`) → retryable
4. **Otherwise** → not silently retryable (falls through to normal error handling)

### Other Status Codes That Populate `data`

- **402** (QuotaExceeded): `data = { capiError: jsonData, retryAfter: Date }`
- **429** (RateLimited): `data = { retryAfter, rateLimitKey, capiError: jsonData }`
- **401** (AgentUnauthorized): `data = jsonData` (the `authorize_url` object)
- **400** (InvalidPreviousResponseId): `data = jsonData`
- **Other 5xx**: No `data` field set at all

## Patterns

1. **Untyped bag pattern**: `data?: Record<string, any>` is used as a generic carrier, avoiding per-status-code interface variants. This means consumers must know (via convention) what keys exist for each `failKind`.

2. **Status code travels out-of-band**: The HTTP status code is not embedded in `ChatRequestFailed` — it's returned as a sibling field in the result tuple from `_fetchAndStreamChat()`, so `_getSilentlyRetryable503Info` takes it as a separate parameter.

3. **Header extraction at construction time**: Headers like `retry-after` and `x-ratelimit-exceeded` are read from the raw `Response` inside `_handleError` and stored as plain strings in `data`. The `Response.headers` object is never preserved.

4. **Body pre-parsing**: The response text is read once (`response.text()`), JSON-parsed if possible, then the `.error` sub-object is extracted (`jsonData = jsonData?.error ?? jsonData`). This normalized object becomes `capiError`.

## Applicability

- **For 503 retry analysis**: The mechanism is fully self-contained. `_getSilentlyRetryable503Info` only needs `response.data.{retryAfter, rateLimitKey, capiError.{code,type}}` plus the out-of-band `actualStatusCode`.
- **For extending retry logic**: Any new retry criteria must either add keys to the `data` bag in the 503 branch of `_handleError`, or add codes to `_silentlyRetryable503ErrorCodes`.
- **For typed access**: The `data` bag is untyped. If type safety is desired, a discriminated union or per-failKind typed data would be needed — but the current codebase relies on runtime `typeof` checks.

## Open Questions

1. **Why is `statusCode` not on `ChatRequestFailed`?** It's already computed in `_handleError` (`response.status`) and carried separately. Including it on the interface would simplify `_getSilentlyRetryable503Info`'s signature.
2. **Should `data` be typed?** The current `Record<string, any>` pattern means consumers must guess field shapes. A `ChatRequestFailedData` union type per `failKind` would improve safety.
3. **What happens when the 503 body is not valid JSON?** The fallback `capiError = { message: text }` means `capiError.code` will be `undefined`, so the error won't match `_silentlyRetryable503ErrorCodes` and won't be silently retried unless explicit headers (`retry-after`/`x-ratelimit-exceeded`) are present.
4. **Are there other callers that inspect `data` for 503?** Only `_getSilentlyRetryable503Info` and telemetry code appear to read these fields — but the untyped nature makes it hard to audit exhaustively.
