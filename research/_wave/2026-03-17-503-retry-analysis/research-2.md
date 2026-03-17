# Research Report: Silent 503 Retry Loop Mechanics

**Source**: `src/extension/prompt/node/chatMLFetcher.ts` (class `ChatMLFetcherImpl`)

## Findings

### Static Configuration (L101-103)

| Constant | Value | Purpose |
|----------|-------|---------|
| `_maxSilent503Retries` | `3` | Maximum retry attempts |
| `_maxSilent503RetryDelayMs` | `10_000` (10s) | Hard cap on any single retry delay |
| `_silentlyRetryable503ErrorCodes` | `Set(['model_degraded'])` | Error codes that qualify for silent retry without an explicit retry signal |

### Eligibility — `_getSilentlyRetryable503Info()` (L907-925)

A 503 response is silently retryable when **either**:

1. **Explicit retry signal present** — any of:
   - `response.data.retryAfter` is a string
   - `response.data.rateLimitKey` is a string
   - `capiError.code === 'upstream_provider_rate_limit'`
   - `capiError.type === 'rate_limit_error'`
2. **Known error code** — `capiError.code` is in `_silentlyRetryable503ErrorCodes` (currently just `'model_degraded'`)

If neither condition holds, returns `undefined` → no silent retry.

Return value: `{ retryReason: capiErrorCode ?? 'service_unavailable_503', retryAfterDelayMs: <parsed or undefined> }`

### Delay Parsing — `_parseRetryAfterDelayMs()` (L889-906)

Parses the `retryAfter` string from the server response:
- **Integer string** → interpreted as seconds, converted to ms (`seconds * 1000`), floored at 0.
- **Date string** → parsed via `Date.parse()`, delay = `parsedDate - Date.now()`, floored at 0.
- **Missing/unparseable** → returns `undefined` (triggers fallback linear delay).

### Retry Loop — Attempt Counting & Delay Calculation (L504-543)

**Entry gate**: `enableRetryOnError && silentlyRetryable503` must both be truthy.

**Loop**: `for (let attempt = 1; attempt <= 3; attempt++)`

**Delay per attempt**:
```
if (server retryAfterDelayMs is undefined)
    delay = attempt * 2000ms    // linear backoff: 2s, 4s, 6s
else
    delay = min(retryAfterDelayMs, 10_000ms)   // server-specified, capped at 10s
```

Key distinction: the linear fallback scales with attempt number, but the server-specified delay is **constant** across attempts (capped but not scaled).

**Cancellation**: checked at the top of each iteration via `token.isCancellationRequested`.

### Recursion Prevention (L522-531)

Each retry calls `this.fetchMany()` recursively with **`enableRetryOnError: false`**. This is the critical recursion guard — the nested call can never spawn its own 503 retry loop because the flag is disabled. Additional properties set on retry:
- `debugName`: prefixed `retry-503-{attempt}-` for tracing
- `userInitiatedRequest: false`
- `telemetryProperties.retryAfterError` and `retryAfterErrorGitHubRequestId` populated for attribution

### Early Exit on Different Failure (L533-539)

After each retry, the result is compared to the original failure:
```ts
const isSameFailure = retryResult.type === processed.type
    && 'reason' in retryResult
    && retryResult.reason === processed.reason;
if (!isSameFailure) { return retryResult; }
```
Any non-identical failure (including success) breaks out and returns immediately. Only if the **exact same failure** recurs does the loop continue.

### Interaction with `enableRetryOnError` Flag

The flag governs **all** retry mechanisms in `fetchMany()`:

| Retry mechanism | Guard condition |
|-----------------|-----------------|
| Silent 503 retry | `enableRetryOnError && silentlyRetryable503` (L506) |
| HTTP 499 (server-canceled) retry | `enableRetryOnError && ServerCanceled` (L546) |
| Generic server-error retry | `!attemptedSilent503Retry && enableRetryOnError && ...` (L575) |
| Network error retry | `enableRetryOnError && NetworkError && experiment` (L638) |

**`enableRetryOnError` derivation** (L231): `opts.enableRetryOnError ?? opts.enableRetryOnFilter` — falls back to the filter-retry flag if the error-retry flag is unset.

### Mutual Exclusion with Generic Server-Error Retry (L575)

The generic server-error retry block is guarded by `!attemptedSilent503Retry`. If the 503 silent retry ran (even if all attempts exhausted), the generic retry is **skipped**. This prevents double-retrying the same 503.

### Stream Callback Notifications (L521)

Before each retry, a stream callback is emitted: `streamRecorder.callback('', 0, { text: '', retryReason })`. This propagates retry status to the UI/stream consumer without sending actual content.

## Patterns

1. **Flag-gated recursion with self-disabling**: The retry calls itself (`fetchMany`) but disables the retry flag, creating a single-depth retry pattern rather than unbounded recursion.
2. **Dual delay strategy**: Server-directed delay (Retry-After header) takes priority but is capped; linear backoff serves as fallback.
3. **Same-failure continuation**: Only retries if the exact same failure recurs; any different outcome (success, different error) exits immediately.
4. **Mutual exclusion**: `attemptedSilent503Retry` flag prevents the 503 retry and generic server-error retry from both firing on the same request.
5. **Telemetry attribution**: Every retry carries forward the original failure reason and request ID for post-hoc analysis.

## Applicability

This mechanism is relevant to:
- **Ralph retry/resilience design**: The flag-gated self-disabling recursion is a clean pattern for preventing retry storms while keeping retry logic co-located.
- **Delay calculation**: The dual strategy (server-directed vs. linear fallback) with a hard cap is a good model for any API client retry logic.
- **Stream-aware retries**: Emitting retry notifications through the stream callback keeps UI consumers informed without breaking the streaming contract.

## Open Questions

1. **Why is the server-specified delay constant across attempts?** When `retryAfterDelayMs` is present, the same capped value is used for all 3 attempts with no escalation. Is this intentional (server knows best) or an oversight?
2. **What happens if all 3 retries exhaust?** After logging exhaustion (L543), control falls through to the generic server-error retry check — but that's blocked by `attemptedSilent503Retry`. The error telemetry and `processFailedResponse` result are returned. Is there a user-facing error message distinguishing "retried and failed" from "not retried"?
3. **The `model_degraded` error code**: This is the only code in `_silentlyRetryable503ErrorCodes`. How frequently does this actually fire in production? Is the set expected to grow?
4. **`canRetryOnce` interaction** (L232): `canRetryOnce` is set to `true` when neither retry flag is set. How does this one-shot retry interact with the 503 retry — are there scenarios where both could fire?
