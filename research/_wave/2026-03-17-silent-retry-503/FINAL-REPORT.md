# Final Report: Silent Retry for HTTP 503 `model_degraded` in Copilot Chat

## Executive Summary

HTTP 503 responses from upstream model providers are **misclassified** as `ChatFailKind.RateLimited` at `chatMLFetcher.ts:1636`, causing them to bypass all retry mechanisms across *both* the fetcher (L1) and ToolCallingLoop (L2) layers. The agent silently dies on transient 503s, surfacing a misleading "upstream provider rate limit" error to the user.

All six source reports converge on a single recommended fix: **add an inline 503 retry loop at the ChatMLFetcher transport layer (L1)**, modeled on the existing Pattern D (empty-response retry, 3 attempts, linear backoff) and Pattern E (499 retry, status-code detection). This location has zero billing impact (`userInitiatedRequest: false`), is invisible to higher-layer consumers, and follows established codebase conventions.

The fix requires no reclassification of 503 — detect via `actualStatusCode === 503` after `processFailedResponse()`, retry up to 3 times with linear backoff, and only propagate the `RateLimited` error if all retries are exhausted.

---

## Consolidated Findings

### Root Cause: 503 Misclassification

HTTP 503 is hardcoded to `ChatFailKind.RateLimited` in the status parser (`_handleError` at `chatMLFetcher.ts:1636`). The response body (which may contain `model_degraded`) is discarded — `capiError.code` is forced to `upstream_provider_rate_limit`. This single classification decision blocks all downstream retry paths. [via: aggregation-1.md#L28-L31 ← research-1.md#L55-L66]

### Two-Layer Retry Architecture (Both Layers Exclude 503)

| Layer | Location | Retry Logic | 503 Handling |
|-------|----------|-------------|--------------|
| **L1 (Transport)** | `chatMLFetcher.ts` | 6 retry patterns: 499 (10×), 500/502 (1×), empty (3×), network (1×), WS→HTTP (1×), content-filter (1×) | **Excluded** — 503 not in `RetryServerErrorStatusCodes` (`'500,502'`) |
| **L2 (Loop)** | `ToolCallingLoop._runLoop()` | `shouldAutoRetry()`: up to 3 retries, 1s delay, agent modes only | **Excluded** — `RateLimited` explicitly blocked |
| **L3 (Stop Hook)** | `ToolCallingLoop` | Hook-mediated continuation | Sets `stopHookUserInitiated=true` → **BILLED** — wrong abstraction |

[via: aggregation-1.md#L33-L39 ← research-1.md#L69-L110, research-2.md#L50-L67] [via: aggregation-2.md#L41-L50 ← research-6.md#L17-L28]

### Full 503 Error Flow

```
HTTP 503 → _handleError() [chatMLFetcher.ts:1636]
  → ChatFailKind.RateLimited + capiError='upstream_provider_rate_limit'
  → processFailedResponse() [chatMLFetcher.ts:1886]
  → ChatFetchResponseType.RateLimited
  → NOT retried by fetcher (503 ∉ RetryServerErrorStatusCodes)
  → shouldAutoRetry() returns false (RateLimited excluded)
  → processResult() → getErrorDetailsFromChatFetchError() → ChatErrorDetails
  → modifyErrorDetails() adds "Try Again" button
  → VS Code UI renders error + button
```

[via: aggregation-2.md#L70-L82 ← research-4.md#L112-L139, research-6.md#L67-L96]

### Eight Existing Retry Patterns (None Cover 503)

| Pattern | Trigger | Max | Backoff | Location |
|---------|---------|-----|---------|----------|
| A: canRetryOnce | ECONNRESET, ETIMEDOUT | 1 | None | networking.ts:415 |
| B: WS→HTTP | WebSocket failure | 1 | Connectivity | chatMLFetcher.ts:532 |
| C: FilterRetry | RAI filtered | 1 | None | chatMLFetcher.ts:300 |
| **D: [FORK] Empty** | Unknown/no choices | **3** | **Linear 2s×N** | chatMLFetcher.ts:362 |
| **E: ServerCanceled** | HTTP 499 | **10** | **Linear 1s×N** | chatMLFetcher.ts:502 |
| F: ServerError | HTTP 500,502 | 1 | Connectivity | chatMLFetcher.ts:528 |
| G: Connectivity | Used by F, H | 3 pings | 1s, 10s, 10s | chatMLFetcher.ts:679 |
| H: NetworkError | Thrown exception | 1 | Connectivity | chatMLFetcher.ts:594 |

Patterns D and E (bolded) are the recommended templates for the 503 retry. [via: aggregation-2.md#L52-L67 ← research-5.md#L148-L160]

### Billing Safety

L1 retries explicitly set `userInitiatedRequest: false` → `X-Initiator: agent` → FREE. The fork's default `BillingMode` is `force-agent` which also forces unbilled, but L1 placement makes billing safety independent of fork-specific billing overrides. [via: aggregation-1.md#L55-L58 ← research-3.md#L23-L38] [via: aggregation-2.md#L89-L91 ← research-6.md#L142-L158]

### Other Error Consumers

`getErrorDetailsFromChatFetchError()` feeds inline chat (`inlineChatIntent.ts:277`), LM API (`languageModelAccess.ts:593`), and code mapper (`codeMapper.ts:402`). An L1 fix resolves 503 before any of these consumers see it — all benefit automatically. [via: aggregation-2.md#L93-L95 ← research-4.md#L205-L214]

---

## Pattern Catalog

### P1: 503 Falls Through Every Safety Net [CRITICAL — HIGH CONFIDENCE]
503 maps to `RateLimited`, which is excluded from both fetcher-level retry (`statusCodesToRetry`) and loop-level auto-retry (`shouldAutoRetry()` blocklist). The agent dies silently on what should be a retryable transient error.
[via: aggregation-1.md#L65-L68 ← research-1.md#L55-L66, research-2.md#L60-L67]
[via: aggregation-2.md#L30-L35 ← research-4.md#L11-L29, research-5.md#L122-L143]

### P2: L1/ChatMLFetcher Is the Only Correct Insertion Point [CRITICAL — HIGH CONFIDENCE]
All six source reports independently converge: L1 is the only layer with zero billing impact, full mode coverage (works in all modes, not just agent), no stop hook interactions, and established retry patterns to follow.
[via: aggregation-2.md#L103-L106 ← research-4.md#L145-L155, research-5.md#L96-L105, research-6.md#L100-L130]

### P3: Pattern D/E Hybrid as Implementation Template [HIGH CONFIDENCE]
The new retry should use Pattern D's structure (inline loop, 3 attempts, linear backoff) with Pattern E's detection approach (status-code-specific, `enableRetryOnError` guard). Connectivity checks (Pattern F/G) are wasteful since the server did respond.
[via: aggregation-2.md#L109-L111 ← research-5.md#L79-L95, research-6.md#L100-L128]

### P4: Detect via `actualStatusCode === 503`, Don't Reclassify [HIGH CONFIDENCE]
Two approaches are viable: (a) reclassify 503 to a new `ChatFailKind.ModelDegraded`, or (b) keep the classification but detect via `actualStatusCode === 503` in the retry logic. Option (b) is preferred for minimal disruption — no telemetry changes, no message changes, no downstream behavioral shifts.
[via: aggregation-2.md#L113-L115 ← research-4.md#L161-L168, research-5.md#L122-L143, research-6.md#L67-L83]

### P5: `userInitiatedRequest: false` Is Non-Negotiable [HIGH CONFIDENCE]
Retry requests MUST be unbilled. L1 placement guarantees this by convention — all existing L1 retries set `userInitiatedRequest: false`.
[via: aggregation-2.md#L117-L119 ← research-4.md#L25-L28, research-6.md#L142-L158]

### P6: Error Body Discarded at Classification [HIGH]
The 503 handler hardcodes `capiError.code = 'upstream_provider_rate_limit'` regardless of actual response body content (`model_degraded`, infrastructure error, etc.). Downstream components cannot make nuanced decisions about 503 subtypes.
[via: aggregation-1.md#L77-L78 ← research-1.md#L117-L125, research-2.md#L42-L48]

### P7: Billing Interaction With Stop Hook Path [MEDIUM]
If the fix causes the stop hook to run more often (e.g., after exhausting retries), `stopHookUserInitiated` could trigger billing in `dialog` mode. An L1 fix avoids this entirely since the error is resolved before the loop sees it.
[via: aggregation-1.md#L80-L81 ← research-2.md#L94-L100, research-3.md#L58-L62]

---

## Priority Matrix

| Item | Impact | Effort | Priority | Sources |
|------|--------|--------|----------|---------|
| Inline 503 retry at L1 (ChatMLFetcher) | **Critical** — agent silently dies on transient 503s, all modes affected | **Low** — follows Pattern D/E inline loop | **P0** | [via: agg-1#L65-L68 ← r1#L55-L66, r2#L60-L67] [via: agg-2#L103-L106 ← r4#L145, r5#L96, r6#L100] |
| Detect 503 via `actualStatusCode` post-`processFailedResponse` | **Critical** — unblocks retry without reclassification | **Low** — single conditional check | **P0** | [via: agg-2#L113-L115 ← r4#L161, r5#L122, r6#L67] |
| Enforce `userInitiatedRequest: false` on retry | **High** — prevents billing for transient errors | **Trivial** — single parameter | **P0** | [via: agg-2#L117-L119 ← r4#L25, r6#L142] |
| Add telemetry tag for 503 retry events | **Medium** — observability for retry success/exhaustion rates | **Low** — follow Pattern D's `retryAfterError` convention | **P1** | [via: agg-2#L128-L129 ← research-5.md] |
| Parse `Retry-After` header for backoff | **Medium** — server-suggested delay could improve retry success | **Low** — header already available in response | **P2** | [gap from agg-2#L130-L131] |
| Preserve 503 response body for future nuance | **Low** — enables future model-degraded vs. rate-limit distinction | **Low** — store body before overwriting capiError | **P2** | [via: agg-1#L77-L78 ← r1#L117, r2#L42] |

---

## Recommended Plan

### Phase 1: Core Fix (P0)

1. **Add inline 503 retry loop** in `chatMLFetcher.ts` after `processFailedResponse()` (~line 500).
   - Detect: `response.actualStatusCode === 503 && result.type === ChatFetchResponseType.RateLimited`
   - Guard: `enableRetryOnError` flag (same guard as Pattern D/E)
   - Retry: up to 3 attempts, linear backoff (2s × attempt)
   - Billing: `userInitiatedRequest: false` on each retry request
   - On exhaustion: propagate original `RateLimited` error unchanged
   - *Dependency: none*

2. **Add unit tests** covering:
   - 503 retried and succeeds on attempt 2
   - 503 exhausts all 3 retries → original error propagated
   - 503 retry sets `userInitiatedRequest: false`
   - Non-503 `RateLimited` (429) is NOT retried by this path
   - *Dependency: step 1*

### Phase 2: Observability (P1)

3. **Add telemetry** for 503 retry events:
   - `retry_503_attempt` with attempt number and delay
   - `retry_503_success` when retry succeeds
   - `retry_503_exhausted` when all retries fail
   - Follow Pattern D's `retryAfterError` tagging convention
   - *Dependency: step 1*

### Phase 3: Enhancements (P2)

4. **Honor `Retry-After` header** if present in 503 response, capping at a reasonable maximum (e.g., 30s).
   - *Dependency: step 1*

5. **Preserve 503 response body** before overwriting `capiError.code`, enabling future differentiation of 503 subtypes.
   - *Dependency: none (can be done independently)*

---

## Gaps & Further Research

1. **503 response body schema** — No report documents the exact JSON structure of 503 responses or how to distinguish `model_degraded` from genuine upstream rate limits. Needed for Phase 3 body preservation.
2. **Production telemetry analysis** — No data on 503 frequency, retry-worthiness, or correlation with specific models/endpoints. Would inform retry count and backoff tuning.
3. **`Retry-After` header prevalence** — Unknown whether upstream providers include this header on 503 responses. Determines Phase 3 priority.
4. **Per-model retry behavior** — Different providers may return 503 for different reasons. No analysis of whether retry strategy should vary by `modelFamily`.
5. **`enableRetryOnFilter` interaction** — Content-filter retries share the `enableRetryOnError` flag but were not deeply explored for potential conflict with a new 503 retry path.
6. **`dialog` mode billing edge cases** — What happens if a 503 occurs between the billing dialog confirmation and the actual model call is not covered.
7. **Stop hook test scenarios** — No concrete test scenarios for 503 hitting during stop hook-mediated continuation (mitigated by L1 fix but untested).

---

## Source Chain

```
FINAL-REPORT.md
├── aggregation-1.md
│   ├── research-1.md — HTTP error handling pipeline, status-to-FailKind mapping, fetcher retry paths
│   ├── research-2.md — ToolCallingLoop error/stop decision tree, auto-retry logic, stop hook mechanism
│   └── research-3.md — Fork billing system (BillingMode, X-Initiator, userInitiatedRequest)
└── aggregation-2.md
    ├── research-4.md — Error surfacing path: ChatFetchError → ChatErrorDetails → VS Code UI
    ├── research-5.md — Retry patterns catalog (8 patterns A–H), template recommendation
    └── research-6.md — Insertion point analysis across 3 layers, billing impact evaluation
```
