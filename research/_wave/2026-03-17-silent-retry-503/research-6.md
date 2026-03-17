# Research Report: Silent Retry Interceptor Placement for 503/Server Errors

**Wave**: 2026-03-17-silent-retry-503  
**Researcher**: research-6  
**Date**: 2026-03-17  
**Question**: Where should a silent retry interceptor be inserted in the ToolCallingLoop or ChatMLFetcher, and how should it interact with the stop hook to prevent premature termination?

---

## 1. Architecture Overview: Three Retry Layers

The codebase has **three distinct layers** where retries can occur, each with different characteristics:

| Layer | Location | Scope | Billing Impact |
|-------|----------|-------|----------------|
| **L1: Transport** | `ChatMLFetcherImpl.fetchMany()` | HTTP-level retry, invisible to loop | Retry marked `userInitiatedRequest: false` — no extra billing |
| **L2: Loop Auto-Retry** | `ToolCallingLoop.run()` main while-loop | Re-runs entire `runOne()` iteration | Re-enters `userInitiatedRequest` IIFE — may trigger billing |
| **L3: Stop Hook** | `ToolCallingLoop.executeStopHook()` | Blocks loop termination, appends context | Sets `stopHookUserInitiated=true` → **BILLED** on next fetch |

---

## 2. Existing Retry Mechanisms (L1: ChatMLFetcherImpl)

### 2a. HTTP 499 (Server-Canceled) Retry
**File**: [src/extension/prompt/node/chatMLFetcher.ts](src/extension/prompt/node/chatMLFetcher.ts#L502-L522)

```
enableRetryOnError && response.failKind === ChatFailKind.ServerCanceled
→ linear backoff (attempt * 1000ms), up to 10 retries
→ userInitiatedRequest: false on retry (NOT billed)
```

### 2b. Configurable Server Error Status Code Retry
**File**: [src/extension/prompt/node/chatMLFetcher.ts](src/extension/prompt/node/chatMLFetcher.ts#L527-L555)

```
RetryServerErrorStatusCodes config → parsed comma-separated status codes
retryAfterServerError = enableRetryOnError && !ServerCanceled && statusCode in list
→ calls _retryAfterError() with connectivity check
→ userInitiatedRequest: false on retry (NOT billed)
```

### 2c. Empty/Unknown Response Retry
**File**: [src/extension/prompt/node/chatMLFetcher.ts](src/extension/prompt/node/chatMLFetcher.ts#L362-L383)

Fork-added retry: up to 3 attempts with `attempt * 2000ms` backoff for `ChatFetchResponseType.Unknown`.

### 2d. Network Error Retry
**File**: [src/extension/prompt/node/chatMLFetcher.ts](src/extension/prompt/node/chatMLFetcher.ts#L594-L612)

Network errors trigger `_retryAfterError()` with a connectivity pre-check (CAPI ping).

### 2e. CRITICAL: 503 is Classified as RateLimited, NOT ServerError
**File**: [src/extension/prompt/node/chatMLFetcher.ts](src/extension/prompt/node/chatMLFetcher.ts#L1636-L1647)

```typescript
if (response.status === 503) {
    return {
        type: FetchResponseKind.Failed,
        failKind: ChatFailKind.RateLimited,  // ← NOT ServerError!
        reason: 'Upstream provider rate limit hit',
    };
}
```

This means **503 bypasses all existing server error retry mechanisms** because:
- `retryAfterServerError` checks `response.failKind !== ChatFailKind.ServerCanceled` but relies on `statusCodesToRetry.includes(actualStatusCode)` — but the status is already consumed by the response classifier before reaching this check
- The `processFailedResponse()` at [chatMLFetcher.ts#L1889](src/extension/prompt/node/chatMLFetcher.ts#L1889) maps `ChatFailKind.RateLimited` → `ChatFetchResponseType.RateLimited`

---

## 3. Existing Retry Mechanism (L2: ToolCallingLoop.shouldAutoRetry)

**File**: [src/extension/intents/node/toolCallingLoop.ts](src/extension/intents/node/toolCallingLoop.ts#L385-L401)

```typescript
private shouldAutoRetry(response: ChatResponse): boolean {
    // Only in autoApprove/autopilot mode
    if (permLevel !== 'autoApprove' && permLevel !== 'autopilot') return false;
    if (this.autopilotRetryCount >= ToolCallingLoop.MAX_AUTOPILOT_RETRIES) return false;  // MAX = 3
    switch (response.type) {
        case ChatFetchResponseType.RateLimited:    // ← 503 hits this!
        case ChatFetchResponseType.QuotaExceeded:
        case ChatFetchResponseType.Canceled:
        case ChatFetchResponseType.OffTopic:
            return false;                          // ← 503 is NOT retried!
        default:
            return response.type !== ChatFetchResponseType.Success;
    }
}
```

**503 is explicitly excluded from auto-retry** because it maps to `RateLimited`.

The call site at [toolCallingLoop.ts#L839-L843](src/extension/intents/node/toolCallingLoop.ts#L839-L843):
```typescript
if (result.response.type !== ChatFetchResponseType.Success && this.shouldAutoRetry(result.response)) {
    this.autopilotRetryCount++;
    await timeout(1000, token);
    continue;  // re-enters runOne()
}
```

---

## 4. Stop Hook Interaction (L3)

**File**: [src/extension/intents/node/toolCallingLoop.ts](src/extension/intents/node/toolCallingLoop.ts#L863-L893)

The stop hook executes **after** the auto-retry check fails:

```
runOne() returns non-success response
  → shouldAutoRetry() → false for RateLimited (503)
  → executeStopHook() runs
    → if hook says shouldContinue=true:
      → stopHookUserInitiated = true  ← BILLING IMPACT!
      → continue (re-enters loop)
    → if hook says shouldContinue=false:
      → break (loop ends, error surfaces to user)
```

**Key problem**: When the stop hook forces continuation after a 503, the next `runOne()` iteration will compute `userInitiatedRequest` with `stopHookUserInitiated=true`, meaning the retry **IS BILLED** at the premium model multiplier.

The `stopHookUserInitiated` flag is set at [line 879](src/extension/intents/node/toolCallingLoop.ts#L879) and consumed in the billing IIFE at [lines 1186-1221](src/extension/intents/node/toolCallingLoop.ts#L1186-L1221).

---

## 5. Analysis of Three Insertion Points

### Option (a): Inside ChatMLFetcherImpl Before Error Propagates — **RECOMMENDED**

**Where**: [src/extension/prompt/node/chatMLFetcher.ts](src/extension/prompt/node/chatMLFetcher.ts#L500-L555), after `processFailedResponse()` but before returning the error.

**Pros**:
- ✅ **Zero billing impact** — retries use `userInitiatedRequest: false` (established pattern for all L1 retries)
- ✅ **Invisible to ToolCallingLoop** — the loop never sees the error, so stop hook never fires
- ✅ **Follows existing patterns** — 499, unknown, network error retries all work this way
- ✅ **No stop hook interaction needed** — error is resolved before it propagates

**Cons**:
- ⚠️ Must handle the 503-as-RateLimited classification — either reclassify 503 or add a special case

**Recommended implementation**:
```typescript
// After line 500 (processFailedResponse), before existing retryAfterServerError check:
if (enableRetryOnError && response.failKind === ChatFailKind.RateLimited 
    && actualStatusCode === 503) {
    // 503 is upstream provider overload, not a true user rate limit — retry silently
    for (let attempt = 1; attempt <= 3; attempt++) {
        if (token.isCancellationRequested) break;
        await new Promise<void>(resolve => setTimeout(resolve, attempt * 2000));
        this._logService.info(`[FORK] Retrying 503 upstream rate limit, attempt ${attempt}/3...`);
        streamRecorder.callback('', 0, { text: '', retryReason: 'upstream_503' });
        const retryResult = await this.fetchMany({
            ...opts, debugName: `retry-503-${attempt}-${debugName}`,
            userInitiatedRequest: false,  // NOT billed
            enableRetryOnError: false,
        }, token);
        if (retryResult.type !== ChatFetchResponseType.RateLimited) {
            pendingLoggedChatRequest?.resolve(retryResult, streamRecorder.deltas);
            return retryResult;
        }
    }
}
```

### Option (b): Inside ToolCallingLoop.runOne() Wrapping the Model Call

**Where**: [src/extension/intents/node/toolCallingLoop.ts](src/extension/intents/node/toolCallingLoop.ts#L839-L843), modifying `shouldAutoRetry()`.

**Pros**:
- ✅ Simple one-line change — remove `RateLimited` from the exclusion list in `shouldAutoRetry()`
- ✅ Already has retry count (MAX_AUTOPILOT_RETRIES = 3) and 1s backoff

**Cons**:
- ❌ **Only works in autoApprove/autopilot mode** — non-agent users get no retry
- ❌ **Billing risk** — the retry re-enters `runOne()` which recomputes `userInitiatedRequest` via the IIFE. While `iterationNumber > 0` and `isContinuation` checks may yield `false`, the `stopHookUserInitiated` flag could be stale
- ❌ **Conflates upstream 503 with real rate limits** — removing `RateLimited` from exclusions would also retry genuine user-level rate limits, which is incorrect behavior
- ❌ **Retries entire prompt rebuild** — wastes compute rebuilding the prompt when only the fetch needs retrying

### Option (c): Modifying the Stop Hook to Recognize Retryable Errors

**Where**: [src/extension/intents/node/toolCallingLoop.ts](src/extension/intents/node/toolCallingLoop.ts#L271-L309), adding error-type awareness to `executeStopHook()`.

**Pros**:
- ✅ Extensible — hooks could implement custom retry policies per error type

**Cons**:
- ❌ **BILLED** — stop hook continuation sets `stopHookUserInitiated=true` at [line 879](src/extension/intents/node/toolCallingLoop.ts#L879), causing the next request to be billed
- ❌ **Wrong abstraction level** — stop hooks are designed for task-completion logic ("should the agent keep working?"), not transport-level error recovery
- ❌ **Adds unnecessary model call** — the stop hook continuation re-enters the full loop with `hookContext` injected into the prompt, wasting tokens on "here's why you should continue" when the real problem is a transient HTTP error
- ❌ **Architecture violation** — chatHookService.ts defines StopHookInput as `{ stop_hook_active: boolean }` with no error context — would need interface changes

---

## 6. Token/Billing Analysis with X-Initiator Header

**File**: [src/extension/prompt/node/chatMLFetcher.ts](src/extension/prompt/node/chatMLFetcher.ts#L145-L171)

The `X-Initiator` header is computed from `userInitiatedRequest`:
- `true` → `X-Initiator: user` → **BILLED** at model multiplier
- `false` → `X-Initiator: agent` → **NOT billed** (free)

**Billing mode hierarchy** (fork logic):
1. `force-agent`: always `userInitiatedRequest=false` (never billed)
2. `default`: non-gemini → force-agent; gemini-flash → standard billing
3. `dialog`: upstream billing with billing guard dialog
4. Fallthrough: `billingAccepted` flag or standard first-turn logic

**Critical insight for retries**: Option (a) in ChatMLFetcher explicitly sets `userInitiatedRequest: false` on retry requests, bypassing ALL billing mode logic. Options (b) and (c) re-enter the billing IIFE which may or may not mark the request as billed depending on mode and state.

---

## 7. Recommendation

**Use Option (a): ChatMLFetcherImpl L1 retry** for 503 errors, with these specifics:

1. **Insert after** [chatMLFetcher.ts line 500](src/extension/prompt/node/chatMLFetcher.ts#L500), before the `retryServerErrorStatusCodes` check
2. **Detect** by checking `actualStatusCode === 503` directly (don't rely on `failKind` since it's `RateLimited`)
3. **Retry** with exponential backoff (2s, 4s, 6s), max 3 attempts
4. **Set** `userInitiatedRequest: false` on all retries to avoid billing
5. **Set** `enableRetryOnError: false` to prevent recursive retries
6. **No stop hook modification needed** — error never reaches the loop

**Alternative/complementary**: If you also want L2 coverage (for modes where `force-agent` is active and billing isn't a concern), modify `shouldAutoRetry()` to distinguish 503 from true rate limits by adding a `failKind` or `actualStatusCode` field to the response type flowing back to the loop. But this is secondary to the L1 fix.

---

## 8. File Reference Summary

| File | Key Lines | Role |
|------|-----------|------|
| [src/extension/prompt/node/chatMLFetcher.ts](src/extension/prompt/node/chatMLFetcher.ts) | L138-171 (billing), L228 (enableRetryOnError), L500-555 (retry logic), L1636-1647 (503 classification), L1886-1930 (processFailedResponse) | Transport-level fetch, retry, billing |
| [src/extension/intents/node/toolCallingLoop.ts](src/extension/intents/node/toolCallingLoop.ts) | L160-170 (class + fields), L271-309 (executeStopHook), L331-337 (retry constants), L385-401 (shouldAutoRetry), L827-893 (main loop stop logic), L1175-1221 (userInitiatedRequest IIFE) | Loop orchestration, auto-retry, stop hooks |
| [src/platform/chat/common/chatHookService.ts](src/platform/chat/common/chatHookService.ts) | L136-157 (StopHookInput/Output interfaces) | Hook contracts |
| [src/platform/openai/node/fetch.ts](src/platform/openai/node/fetch.ts) | L33-51 (ChatFailKind enum) | Error classification |
| [src/platform/chat/common/commonTypes.ts](src/platform/chat/common/commonTypes.ts) | L95-117 (ChatFetchResponseType enum) | Response type taxonomy |
