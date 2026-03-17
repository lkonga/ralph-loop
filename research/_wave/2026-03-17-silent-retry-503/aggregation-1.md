## Aggregation Report 1

### Source Reports

1. **research-1.md** — HTTP error handling pipeline in `ChatMLFetcherImpl`: status-to-`FailKind` mapping, all retry pathways, and why 503 `model_degraded` is surfaced as a rate-limit error rather than retried.
2. **research-2.md** — `ToolCallingLoop._runLoop()` error/stop decision tree: auto-retry in agent modes (up to 3 attempts), stop hook mechanism, `shouldContinue` semantics, and the exact 503 flow at loop level.
3. **research-3.md** — Fork billing system (`BillingMode`, `userInitiatedRequest`, `X-Initiator` header): three billing modes, the billing guard dialog, defense-in-depth overrides, and `stopHookUserInitiated` linkage.

### Deduplicated Findings

#### F1: 503 Is Classified as RateLimited, Not ServerError
HTTP 503 is hardcoded to `ChatFailKind.RateLimited` in the status parser. The response body (which may contain `model_degraded`) is discarded — the error code is forced to `upstream_provider_rate_limit`. This means 503 **never** enters the server-error retry pathway (`'500,502'` config). [source: research-1.md#L55-L66]

#### F2: Two Independent Retry Layers Exist
- **Layer 1 (fetcher)**: `chatMLFetcher.ts` retry pathways handle HTTP 499 (10 retries), HTTP 500/502 (1 retry via config), empty responses (3 retries), network errors (1 retry), and WebSocket fallback (1 retry). 503 is excluded from all of these. [source: research-1.md#L69-L110]
- **Layer 2 (loop)**: `ToolCallingLoop._runLoop()` has `shouldAutoRetry()` which retries any non-success response up to 3 times with 1s delay — but only in `autoApprove`/`autopilot` modes. Explicitly excludes `RateLimited`. [source: research-2.md#L50-L67]

#### F3: 503 Hits Zero Retry Pathways
Since 503 maps to `ChatFailKind.RateLimited` → `ChatFetchResponseType.RateLimited`, and both retry layers exclude `RateLimited`:
- Fetcher: 503 not in `statusCodesToRetry` default (`'500,502'`)
- Loop: `shouldAutoRetry()` explicitly excludes `RateLimited`
Result: 503 is immediately surfaced to the user with the message "upstream model provider is currently experiencing high demand." [source: research-1.md#L113-L140] [source: research-2.md#L60-L67]

#### F4: Stop Hook Runs After Auto-Retry Exhaustion
When `shouldAutoRetry()` returns false (wrong mode, retries exhausted, or excluded error type), the stop hook executes. Hooks return `shouldContinue: false` by default; only an explicit `decision: 'block'` with a `reason` makes `shouldContinue: true`. For 503/RateLimited, auto-retry is skipped entirely, so the stop hook runs immediately on first attempt (in non-agent modes) or never triggers retry (since RateLimited is excluded from auto-retry even in agent modes). [source: research-2.md#L69-L112]

#### F5: stopHookUserInitiated Bridges Loop and Billing
When a stop hook blocks termination (`shouldContinue: true`), `stopHookUserInitiated` is set to `true`, which feeds into the `userInitiatedRequest` computation. This ensures the continuation round is treated as user-initiated for billing purposes across all billing modes. [source: research-3.md#L58-L62] [source: research-2.md#L94-L100]

#### F6: BillingMode Defaults to `force-agent` (Never Billed)
The fork's `BillingMode` setting defaults to `force-agent`, which unconditionally sets `userInitiatedRequest = false` → `X-Initiator: agent`. The `dialog` mode adds a confirmation dialog before billing premium models, and `default` mode only bills gemini-3-flash. [source: research-3.md#L23-L38]

#### F7: Defense-in-Depth Billing Override in Fetcher
Even after `toolCallingLoop.ts` computes `userInitiatedRequest`, `chatMLFetcher.ts` applies a second override: in `force-agent` mode, any `true` value is forced to `false`. This prevents billing leaks from code paths that bypass the loop's billing logic. [source: research-3.md#L94-L103]

#### F8: Error Responses Skip Autopilot Internal Stop Hook
The autopilot-specific `shouldAutopilotContinue` check (line 887) requires `ChatFetchResponseType.Success`. Error responses always fall through to the final `break`, meaning the autopilot continuation logic is never consulted for error cases. [source: research-2.md#L103-L107]

### Cross-Report Patterns

**P1: 503 Falls Through Every Safety Net** (research-1 + research-2)
The 503 classification as `RateLimited` creates a compound failure: it's excluded from fetcher-level retry (not in `statusCodesToRetry`), excluded from loop-level auto-retry (`shouldAutoRetry()` blocklist), and immediately terminates the agent. This is the core bug — 503 is treated as a permanent quota signal rather than a transient server condition. High confidence.

**P2: Two-Layer Retry Architecture With Shared Blind Spot** (research-1 + research-2)
Both the fetcher and the loop have independent retry mechanisms, but they share the same classification of 503 as `RateLimited`. Fixing at either layer alone would work, but fixing only the fetcher (Option A: add 503 to `statusCodesToRetry`) would be invisible to agent-mode users who rely on loop retry. Fixing only the loop (removing `RateLimited` from exclusion) would retry all rate limits. The cleanest fix is at the classification layer itself. High confidence.

**P3: Billing Mode Interacts With Retry Behavior** (research-2 + research-3)
`stopHookUserInitiated` is set when a stop hook extends the loop, which changes billing classification. If a 503 retry fix causes the stop hook to run more often (e.g., after exhausting retries), the billing state for subsequent rounds would be affected. In `force-agent` mode this is harmless (always unbilled), but in `dialog` mode, unexpected continuation rounds could trigger billing without user consent. Medium confidence.

**P4: Error Body Is Discarded at Classification** (research-1 + research-2)
The 503 handler hardcodes `capiError.code = 'upstream_provider_rate_limit'` regardless of actual response body content (which could be `model_degraded`, infrastructure error, etc.). The loop has no visibility into the original error semantics — it only sees `ChatFailKind.RateLimited`. This prevents any downstream component from making nuanced decisions about 503 subtypes. High confidence.

### Priority Matrix

| Pattern | Impact | Effort | Sources |
|---------|--------|--------|---------|
| P1: 503 falls through all retries | **Critical** — agent silently dies on transient 503s | S — single classification change | [research-1.md#L55-L66](research-1.md#L55-L66), [research-2.md#L60-L67](research-2.md#L60-L67) |
| P4: Error body discarded at classification | **High** — no ability to distinguish 503 subtypes | S — parse body before classifying | [research-1.md#L117-L125](research-1.md#L117-L125), [research-2.md#L42-L48](research-2.md#L42-L48) |
| P2: Shared blind spot across retry layers | **High** — architectural debt | M — requires decision on which layer to fix | [research-1.md#L69-L110](research-1.md#L69-L110), [research-2.md#L50-L67](research-2.md#L50-L67) |
| P3: Billing interaction with retry changes | **Medium** — potential unintended billing in dialog mode | S — audit billing paths after retry fix | [research-2.md#L94-L100](research-2.md#L94-L100), [research-3.md#L58-L62](research-3.md#L58-L62) |

### Gaps

1. **No research on the actual 503 response body format** — reports assume `model_degraded` is in the body but don't document the exact JSON schema or how to distinguish it from genuine rate limits.
2. **No telemetry analysis** — no data on how frequently 503s occur in production, their retry-worthiness, or correlation with `model_degraded` vs actual upstream rate limits.
3. **No research on the `enableRetryOnFilter` path** — content-filter retries (`ChatFetchRetriableError`) interact with the same `enableRetryOnError` flag but were not deeply explored for 503 interaction.
4. **`dialog` mode billing re-request flow under errors** — what happens if a 503 occurs between the billing dialog and the actual model call is not covered.

### Sources
- research-1.md — HTTP error handling pipeline and status code retry logic in `ChatMLFetcherImpl`
- research-2.md — ToolCallingLoop stop hook mechanism and error retry flow
- research-3.md — Custom initiator / fork billing system (`BillingMode`, `X-Initiator`, `userInitiatedRequest`)
