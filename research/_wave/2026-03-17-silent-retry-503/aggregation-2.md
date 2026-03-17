# Aggregation Report 2

**Wave**: 2026-03-17-silent-retry-503
**Group**: 2 — Error Surfacing, Retry Patterns, and Insertion Point Analysis
**Date**: 2026-03-17

---

## Source Reports

### research-4.md — Error Surfacing Path to UI
Traced the full 503 error path: `HTTP 503` → `ChatFailKind.RateLimited` → `ChatFetchResponseType.RateLimited` → `getErrorDetailsFromChatFetchError()` → `ChatErrorDetails` with "upstream provider rate limit" message → `ChatResult.errorDetails` → VS Code chat UI renders error banner + "Try Again" button. Key finding: 503 is misclassified as `RateLimited` (not `ServerError`), which causes it to bypass all existing retry mechanisms at every layer. [source: research-4.md#L1-L10]

### research-5.md — Existing Retry Patterns Catalog
Cataloged 8 distinct retry patterns (A–H) in the codebase. None handle 503 because it's classified as `RateLimited`. Recommended a hybrid of Pattern D (FORK empty retry, linear backoff, 3 attempts) and Pattern E (499 retry, inline loop) as the best-fit template for a new 503 retry. [source: research-5.md#L1-L12]

### research-6.md — Optimal Insertion Point Analysis
Evaluated three insertion points across three architectural layers (L1: Transport/ChatMLFetcher, L2: ToolCallingLoop auto-retry, L3: Stop Hook). Conclusively recommended **L1 (ChatMLFetcher)** — zero billing impact, invisible to the loop, follows established patterns, no stop hook interaction needed. [source: research-6.md#L1-L12]

---

## Deduplicated Findings

### F1: 503 Misclassification Is the Root Cause
HTTP 503 is mapped to `ChatFailKind.RateLimited` at `chatMLFetcher.ts:1636`, not `ServerError`. This single classification decision causes 503 to bypass **all** existing retry mechanisms: fetcher-level server error retry (Pattern F), ToolCallingLoop auto-retry (`shouldAutoRetry` explicitly excludes `RateLimited`), and configurable `RetryServerErrorStatusCodes` (default `'500,502'` — 503 not included). [source: research-4.md#L11-L29], [source: research-5.md#L122-L143], [source: research-6.md#L67-L83]

### F2: Three-Layer Retry Architecture
The codebase has three retry layers with different billing implications:
- **L1 (Transport/ChatMLFetcher)**: Sets `userInitiatedRequest: false` → NOT billed. All existing server/network retries operate here.
- **L2 (ToolCallingLoop)**: Re-enters `runOne()` → billing depends on mode/state. Only works in autoApprove/autopilot.
- **L3 (Stop Hook)**: Sets `stopHookUserInitiated=true` → BILLED at premium model rate. Wrong abstraction for transport errors.
[source: research-6.md#L17-L28], [source: research-6.md#L142-L158]

### F3: Eight Existing Retry Patterns
| Pattern | Trigger | Max Retries | Backoff | Location |
|---------|---------|-------------|---------|----------|
| A: canRetryOnce | ECONNRESET, ETIMEDOUT, etc. | 1 | None | networking.ts:415 |
| B: WS→HTTP | WebSocket failure | 1 (+disable after 3) | Via connectivity | chatMLFetcher.ts:532 |
| C: FilterRetry | RAI filtered | 1 | None | chatMLFetcher.ts:300 |
| D: [FORK] Empty | Unknown/no choices | 3 | Linear 2s×N | chatMLFetcher.ts:362 |
| E: ServerCanceled | HTTP 499 | 10 | Linear 1s×N | chatMLFetcher.ts:502 |
| F: ServerError | HTTP 500,502 (config) | 1 | Via connectivity | chatMLFetcher.ts:528 |
| G: Connectivity | Used by F, H | 3 pings | 1s, 10s, 10s | chatMLFetcher.ts:679 |
| H: NetworkError | Thrown exception | 1 | Via connectivity | chatMLFetcher.ts:594 |
[source: research-5.md#L148-L160]

### F4: Full Error Flow (503 Specific)
```
HTTP 503 → _handleError() [chatMLFetcher.ts:1636]
  → ChatFailKind.RateLimited + capiError='upstream_provider_rate_limit'
  → processFailedResponse() [chatMLFetcher.ts:1886]
  → ChatFetchResponseType.RateLimited
  → NOT retried by fetcher (503 ∉ RetryServerErrorStatusCodes)
  → shouldAutoRetry() returns false (RateLimited excluded)
  → processResult() [defaultIntentRequestHandler.ts:511]
  → getErrorDetailsFromChatFetchError() → ChatErrorDetails
  → modifyErrorDetails() adds "Try Again" button [agentIntent.ts:643]
  → VS Code UI renders error + button
```
[source: research-4.md#L112-L139], [source: research-6.md#L67-L96]

### F5: Billing/X-Initiator Header Mechanics
`userInitiatedRequest` controls the `X-Initiator` header: `true` → `user` (BILLED), `false` → `agent` (FREE). L1 retries explicitly set `userInitiatedRequest: false`, making them free. L2/L3 retries re-enter billing computation with potential premium charges. [source: research-6.md#L142-L158]

### F6: Five Interception Options Evaluated
All three reports converge on the same set of options with consistent pros/cons analysis:

| Option | Approach | Billing | Scope | Verdict |
|--------|----------|---------|-------|---------|
| A | Add 503 to `RetryServerErrorStatusCodes` | Free | All modes | Good but wasteful connectivity check |
| B | Reclassify 503 as `ServerError` | Free (L1) | All modes | Enables existing retry but changes telemetry/messaging |
| C | Remove `RateLimited` from `shouldAutoRetry` exclusions | Depends | Agent only | Conflates 503 with real 429 rate limits |
| D | Retry in `processResult` before error becomes `ChatResult` | Depends | All modes | Wrong abstraction layer |
| E | Inline 503 retry in `_handleError` / after `processFailedResponse` | Free | All modes | **Best — targeted, silent, follows Pattern D/E template** |
[source: research-4.md#L145-L197], [source: research-5.md#L96-L119], [source: research-6.md#L100-L139]

### F7: Other Error Consumers
`getErrorDetailsFromChatFetchError` is also consumed by inline chat (`inlineChatIntent.ts:277`), LM API (`languageModelAccess.ts:593` — throws `LanguageModelError`), and code mapper (`codeMapper.ts:402`). An L1 fix resolves the error before any of these consumers see it. [source: research-4.md#L205-L214]

---

## Cross-Report Patterns

### P1: Universal Agreement on L1/ChatMLFetcher as Optimal Insertion Point [HIGH CONFIDENCE]
All three reports independently conclude the retry should be placed at the ChatMLFetcher transport layer (L1), specifically after `processFailedResponse()` around line 500, before the error propagates to the ToolCallingLoop. Reasons cited across reports: zero billing impact, invisibility to higher layers, alignment with existing patterns (D/E), no stop hook complications. [source: research-4.md#L145-L155], [source: research-5.md#L96-L105], [source: research-6.md#L100-L130]

### P2: Pattern D (FORK Empty Retry) + Pattern E (499 Retry) as Implementation Template [HIGH CONFIDENCE]
Reports 5 and 6 both recommend modeling the new retry on the hybrid of Pattern D (3 attempts, linear/exponential backoff, inline loop) and Pattern E (status-code-specific detection, `enableRetryOnError: false` guard). Both agree connectivity checks (Pattern F/G) are wasteful since the server responded. [source: research-5.md#L79-L95], [source: research-6.md#L100-L128]

### P3: 503 RateLimited Classification Must Be Addressed [HIGH CONFIDENCE]
All three reports identify the `ChatFailKind.RateLimited` mapping at `chatMLFetcher.ts:1636` as the root blocker. Two approaches are viable: (a) reclassify 503 to a new `ChatFailKind.ModelDegraded`, or (b) keep the classification but detect via `actualStatusCode === 503` in the retry logic. Reports 5 and 6 prefer (b) for minimal disruption. [source: research-4.md#L161-L168], [source: research-5.md#L122-L143], [source: research-6.md#L67-L83]

### P4: `userInitiatedRequest: false` Is Non-Negotiable for Silent Retries [HIGH CONFIDENCE]
Reports 4 and 6 both emphasize that retry requests MUST set `userInitiatedRequest: false` to avoid billing users for transient errors. This is already the established convention for all L1 retry patterns. [source: research-4.md#L25-L28], [source: research-6.md#L142-L158]

---

## Priority Matrix

| Pattern | Impact | Effort | Sources |
|---------|--------|--------|---------|
| P1: L1 insertion in ChatMLFetcher | Critical — only location with zero billing + full coverage | Low — follows existing inline loop patterns | [research-4.md#L145-L155](research-4.md#L145-L155), [research-5.md#L96-L105](research-5.md#L96-L105), [research-6.md#L100-L130](research-6.md#L100-L130) |
| P3: Handle 503 RateLimited classification | Critical — current classification blocks all retries | Low — detect via `actualStatusCode === 503` | [research-4.md#L161-L168](research-4.md#L161-L168), [research-5.md#L122-L143](research-5.md#L122-L143), [research-6.md#L67-L83](research-6.md#L67-L83) |
| P2: Use Pattern D/E hybrid template | High — proven backoff + guard patterns | Low — copy existing inline loop structure | [research-5.md#L79-L95](research-5.md#L79-L95), [research-6.md#L100-L128](research-6.md#L100-L128) |
| P4: Enforce `userInitiatedRequest: false` | High — prevents billing for retries | Trivial — single parameter | [research-4.md#L25-L28](research-4.md#L25-L28), [research-6.md#L142-L158](research-6.md#L142-L158) |

---

## Gaps

1. **No research on telemetry tagging** — none of the reports detail what telemetry events should be emitted for 503 retries (success after retry, exhaustion after max attempts, latency distribution). Pattern D uses `retryAfterError: 'empty_response'` as a tag, but the full telemetry contract for a new retry reason isn't specified.
2. **No analysis of `Retry-After` header parsing** — 503 responses may include a `Retry-After` header with a server-suggested delay. The current 503 handler sets `retryAfter: null`. No report examines whether to honor this header in the retry backoff.
3. **No exploration of per-model retry behavior** — different model providers may return 503 for different reasons (true overload vs. model-specific degradation). No report examines whether retry strategy should vary by `modelFamily` or endpoint.
4. **No stop hook test scenarios** — while research-6 correctly identifies the stop hook interaction, there are no concrete test scenarios showing what happens when a 503 hits during a stop hook-mediated continuation.

---

## Sources
- [research-4.md](research-4.md) — ChatFetchError → ChatErrorDetails → UI display path trace
- [research-5.md](research-5.md) — Retry mechanisms and patterns catalog (8 patterns, A–H)
- [research-6.md](research-6.md) — Silent retry interceptor placement and stop hook interaction analysis
