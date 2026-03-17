# Research-3: `_handleError` 503 Classification — Before vs After

## Findings

### Current (New) Classification Logic

In `_handleError` (L1719–L1735 of `chatMLFetcher.ts`), 503 responses are now classified with **conditional logic** instead of a hardcoded kind:

```typescript
if (response.status === 503) {
    const retryAfter = response.headers.get('retry-after');
    const rateLimitKey = response.headers.get('x-ratelimit-exceeded');
    const capiError = jsonData ?? { message: text };
    const hasExplicitRateLimitSignal = !!retryAfter
        || !!rateLimitKey
        || capiError.code === 'upstream_provider_rate_limit'
        || capiError.type === 'rate_limit_error';
    return {
        failKind: hasExplicitRateLimitSignal
            ? ChatFailKind.RateLimited
            : ChatFailKind.ServerError,
        // ...data includes retryAfter, rateLimitKey, capiError
    };
}
```

A 503 becomes `ChatFailKind.RateLimited` **only when** at least one of these signals is present:
1. `retry-after` response header is non-empty
2. `x-ratelimit-exceeded` response header is non-empty
3. `capiError.code === 'upstream_provider_rate_limit'`
4. `capiError.type === 'rate_limit_error'`

Otherwise it falls to `ChatFailKind.ServerError`.

### Previous (Old) Behavior — Evidence of Hardcoded RateLimited

Before this change, the 503 case did **not** exist as a separate branch inside `_handleError`. All 5xx responses fell through to the generic handler:

```typescript
} else if (500 <= response.status && response.status < 600) {
    return {
        failKind: ChatFailKind.ServerError,
        reason: reasonNoText,
    };
}
```

However, examining how `processFailedResponse` (L1976) routes results reveals the full picture:
- `ChatFailKind.RateLimited` → `ChatFetchResponseType.RateLimited` (includes `retryAfter`, `rateLimitKey`, `capiError`)
- `ChatFailKind.ServerError` → `ChatFetchResponseType.Failed` (no retry metadata attached)

The 429 handler (L1687) has always been `ChatFailKind.RateLimited` for rate limits. The critical change was adding **503-specific branching** that distinguishes rate-limit-induced 503s from genuine server errors.

### Two-Layer 503 Retry System

The new code introduces a **two-layer** approach for 503s:

**Layer 1: Silent automatic retries** (`_getSilentlyRetryable503Info`, L907–932)
- Triggers when `hasExplicitRetrySignal` is true OR `capiErrorCode` is in `_silentlyRetryable503ErrorCodes` (currently: `{'model_degraded'}`)
- Up to 3 silent retries (`_maxSilent503Retries`) with exponential-ish backoff (attempt × 2000ms or server-specified delay, capped at 10s)
- Happens transparently before the error bubbles to the user
- Emits `[503-RETRY]` log messages and telemetry

**Layer 2: Generic server error retry** (L575)
- Falls back to `retryServerErrorStatusCodes` config-based retry (experiment-gated)
- Explicitly excluded when `attemptedSilent503Retry` was already done (prevents double-retry)

### Key Downstream Impact

| FailKind | Downstream Response Type | Retry metadata | User-visible |
|---|---|---|---|
| `ChatFailKind.RateLimited` | `ChatFetchResponseType.RateLimited` | `retryAfter`, `rateLimitKey`, `capiError` | Shows rate limit UX |
| `ChatFailKind.ServerError` | `ChatFetchResponseType.Failed` | None | Shows generic server error |

## Patterns

1. **Signal-based classification**: The new logic uses explicit protocol signals (headers + body error codes) rather than HTTP status alone to determine error semantics. A 503 with `upstream_provider_rate_limit` is a rate limit; a 503 with `model_degraded` is a transient server error worthy of silent retry; a bare 503 is a server error shown to the user.

2. **Silent retry before surfacing**: Retryable 503s get up to 3 automatic retries before the user sees an error. This is distinct from the general retry mechanism and takes priority.

3. **capiError as discriminant**: The `capiError` object (parsed from JSON response body) is the primary discriminant. Its `.code` and `.type` fields drive both classification and retry eligibility.

4. **Guard against double-retry**: The `attemptedSilent503Retry` flag prevents the generic retry path from re-retrying a 503 that already exhausted its silent retry budget.

## Applicability

- **Ralph retry logic**: If implementing similar retry-on-503 behavior, the signal-based approach (check headers + body fields) is the pattern to follow. Avoid blanket "all 503 = rate limited" assumptions.
- **Error taxonomy**: The `ChatFailKind` → `ChatFetchResponseType` mapping is a clean two-step classification → routing pattern. First classify the raw HTTP error, then map to user-facing behavior.
- **Configuration**: The `_silentlyRetryable503ErrorCodes` set is a closed allow-list. New retryable codes require explicit addition (currently only `model_degraded`).

## Open Questions

1. **Was the old code ever hardcoding 503 as RateLimited?** The current codebase shows no evidence that 503 ever mapped directly to `ChatFailKind.RateLimited` without signal checking. It appears the old behavior was that 503 fell through to the generic 5xx `ServerError` handler, and the *new* change added the ability to distinguish rate-limit-induced 503s. This contradicts the hypothesis that 503 was previously hardcoded as `RateLimited` — unless that change was made in a commit no longer visible in the current source. Git blame would be needed to confirm.

2. **Why `model_degraded` specifically?** This is the only code in `_silentlyRetryable503ErrorCodes`. What server-side condition triggers this, and are there other candidates?

3. **Interaction with WebSocket retry path**: L639 shows WebSocket failures also trigger retries. How does a 503 over WebSocket interact with the silent 503 retry path?

4. **Experiment gating**: The generic server error retry uses `ConfigKey.TeamInternal.RetryServerErrorStatusCodes` from experimentation service. Is 503 typically included in that list, and if so, does the `attemptedSilent503Retry` guard fully prevent double-retry?
