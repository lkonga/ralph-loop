# Research-4: ChatFailKind & FetchResponseKind Enum Values and 503 Mapping

## Findings

### FetchResponseKind Enum (3 values)
Defined at `src/platform/openai/node/fetch.ts` L9-13:

| Value | String | Used By |
|-------|--------|---------|
| `Success` | `'success'` | `ChatResults` |
| `Failed` | `'failed'` | `ChatRequestFailed` |
| `Canceled` | `'canceled'` | `ChatRequestCanceled` |

### ChatFailKind Enum (14 values)
Defined at `src/platform/openai/node/fetch.ts` L33-48:

| Value | String | HTTP Status Context |
|-------|--------|-------------------|
| `OffTopic` | `'offTopic'` | 400 (content policy) |
| `TokenExpiredOrInvalid` | `'tokenExpiredOrInvalid'` | 401 |
| `ServerCanceled` | `'serverCanceled'` | 499 |
| `ClientNotSupported` | `'clientNotSupported'` | 400 (version mismatch) |
| `RateLimited` | `'rateLimited'` | 429, or 503 with rate-limit signal |
| `QuotaExceeded` | `'quotaExceeded'` | 403 |
| `ExtensionBlocked` | `'extensionBlocked'` | 403 (DMCA/blocked) |
| `ServerError` | `'serverError'` | 500-599 (default), 503 without rate-limit signal |
| `ContentFilter` | `'contentFilter'` | 400/422 (content filter) |
| `AgentUnauthorized` | `'unauthorized'` | 401 (agent-specific) |
| `AgentFailedDependency` | `'failedDependency'` | 424 |
| `ValidationFailed` | `'validationFailed'` | Pre-send validation errors |
| `InvalidPreviousResponseId` | `'invalidPreviousResponseId'` | 400 (conversation threading) |
| `NotFound` | `'notFound'` | 404 |
| `Unknown` | `'unknown'` | Unhandled status codes |

### 503 Status Code Mapping — No New Enum Value

**No new `ChatFailKind` was added for transient 503.** The 503 handler at L1720-1738 reuses existing values with conditional logic:

```typescript
if (response.status === 503) {
    const hasExplicitRateLimitSignal = !!retryAfter || !!rateLimitKey
        || capiError.code === 'upstream_provider_rate_limit'
        || capiError.type === 'rate_limit_error';
    return {
        failKind: hasExplicitRateLimitSignal
            ? ChatFailKind.RateLimited    // ← 503 with rate-limit headers
            : ChatFailKind.ServerError,   // ← 503 without rate-limit headers (transient)
        data: { retryAfter, rateLimitKey, capiError }
    };
}
```

The **dual mapping** means:
- **503 + rate-limit signal** → `ChatFailKind.RateLimited`
- **503 without rate-limit signal** → `ChatFailKind.ServerError`

### Silent 503 Retry — Operates Before FailKind Matters

The silent 503 retry system (`_getSilentlyRetryable503Info`) operates at L907-927 using **the actual HTTP status code and response data**, not the `ChatFailKind`. It checks:
1. `actualStatusCode === 503`
2. Either `hasExplicitRetrySignal` (retry-after header, rate-limit key, upstream_provider_rate_limit code) OR error code in `_silentlyRetryable503ErrorCodes` set (currently only `'model_degraded'`).

If retryable, it retries up to 3 times with max 10s delay per attempt before falling through to normal error handling. The `ChatFailKind` assigned to the response is only relevant *after* silent retries are exhausted.

## Patterns

1. **Reuse-over-extend pattern**: The codebase avoids adding new enum values for HTTP-specific transient conditions. Instead, it uses the `data` bag (`retryAfter`, `rateLimitKey`, `capiError`) to carry context and conditional logic to decide behavior.
2. **Two-tier retry system**: Silent 503 retries operate on raw HTTP data (status code + headers), while the general server-error retry (`retryAfterServerError`) operates on `ChatFailKind` + configurable status code list. The `attemptedSilent503Retry` flag prevents double-retrying.
3. **Discriminated union**: `FetchResponseKind` creates a type-safe discriminated union across `ChatResults | ChatRequestFailed | ChatRequestCanceled`, with `ChatFailKind` sub-discriminating the `Failed` case.

## Applicability

- Any retry/resilience implementation for 503 errors should follow the existing pattern of reusing `ChatFailKind.ServerError` or `ChatFailKind.RateLimited` rather than adding a new enum value.
- The `data` field on `ChatRequestFailed` is the extension point for carrying extra context (retry-after timing, error codes) without changing the type system.
- The `_silentlyRetryable503ErrorCodes` set is the correct extension point for adding new retryable 503 error codes — currently only `'model_degraded'`.

## Open Questions

1. **Should `model_degraded` get its own `ChatFailKind`?** Currently it maps to either `RateLimited` or `ServerError` depending on headers, but its retry semantics (silent, up to 3 times) are unique. A dedicated kind could improve telemetry clarity.
2. **Is the 10-second max delay sufficient?** `_maxSilent503RetryDelayMs = 10_000` caps retry-after, but some 503s from upstream providers may indicate longer outages.
3. **Config-driven retry codes**: The `RetryServerErrorStatusCodes` config allows experiment-based retry on arbitrary status codes — are there other 5xx codes being experimented with beyond the hardcoded 503 path?
