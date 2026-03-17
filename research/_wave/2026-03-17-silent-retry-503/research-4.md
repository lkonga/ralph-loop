# Research Report: ChatFetchError → ChatErrorDetails → UI Display Path

## Question
How does the error response get surfaced to the user after a failed model request? Trace the full path from `ChatFetchError` types through `getErrorDetailsFromChatFetchError()` to the chat UI error rendering. Identify where to intercept to make a retry "silent" (no user-visible error).

---

## 1. Error Origin: HTTP Response → `ChatRequestFailed` (chatMLFetcher.ts)

The error journey starts in `chatMLFetcher.ts` when an HTTP error response arrives.

### 503 Specifically
A **503** is mapped to `ChatFailKind.RateLimited` (NOT `ServerError`), with a synthetic `upstream_provider_rate_limit` code:

**File:** `src/extension/prompt/node/chatMLFetcher.ts` (line ~1636)
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

### Other 5xx errors
Other server errors (500, 502, 504, etc.) become `ChatFailKind.ServerError` → `ChatFetchResponseType.Failed`.

### Fetcher-Level Retry (Layer 1 — silent)
Before any error reaches the participant handler, `chatMLFetcher.fetchMany()` can auto-retry:
- **HTTP 499** (server-cancelled): up to 10 retries with linear backoff (line ~502)
- **Server errors matching `RetryServerErrorStatusCodes`** config: default is `'500,502'` — **503 NOT included** (line ~531, config at `src/platform/configuration/common/configurationService.ts:897`)
- **Network errors**: retried with connectivity check (line ~594)

These retries are **silent** — the user sees nothing if the retry succeeds.

---

## 2. Mapping: `ChatRequestFailed` → `ChatFetchError` (processFailedResponse)

**File:** `src/extension/prompt/node/chatMLFetcher.ts` (line ~1886)

`processFailedResponse()` maps `ChatFailKind` to `ChatFetchResponseType`:

| ChatFailKind | → ChatFetchResponseType |
|---|---|
| `RateLimited` | `ChatFetchResponseType.RateLimited` |
| `QuotaExceeded` | `ChatFetchResponseType.QuotaExceeded` |
| `ServerError` | `ChatFetchResponseType.Failed` |
| `OffTopic` | `ChatFetchResponseType.OffTopic` |
| `TokenExpiredOrInvalid`, `ClientNotSupported` | `ChatFetchResponseType.BadRequest` |
| `ContentFilter` | `ChatFetchResponseType.PromptFiltered` |
| `NotFound` | `ChatFetchResponseType.NotFound` |
| (default) | `ChatFetchResponseType.Failed` |

So a **503 becomes `ChatFetchResponseType.RateLimited`** with `capiError.code = 'upstream_provider_rate_limit'`.

---

## 3. Mapping: `ChatFetchError` → `ChatErrorDetails` (getErrorDetailsFromChatFetchError)

**File:** `src/platform/chat/common/commonTypes.ts` (line 272)

```typescript
export function getErrorDetailsFromChatFetchError(
    fetchResult: ChatFetchError,
    copilotPlan: string,
    gitHubOutageStatus: GitHubOutageStatus,
    hideRateLimitTimeEstimate?: boolean
): ChatErrorDetails {
    return {
        code: fetchResult.type,
        ...getErrorDetailsFromChatFetchErrorInner(fetchResult, copilotPlan, gitHubOutageStatus, hideRateLimitTimeEstimate)
    };
}
```

The inner function (line 301) does the switch:

| ChatFetchResponseType | → ChatErrorDetails.message |
|---|---|
| `RateLimited` | `getRateLimitMessage()` → user-visible rate-limit message |
| `QuotaExceeded` | `getQuotaHitMessage()` → quota exceeded message |
| `Failed` / `BadRequest` | "Sorry, your request failed. Please try again." + request IDs |
| `NetworkError` | "Sorry, there was a network error." |
| `Filtered` / `PromptFiltered` | Responsible AI filtered message |
| `OffTopic` | "I can only assist with programming related questions." |

For a **503**, `getRateLimitMessage()` (line ~229) checks `capiError.code === 'upstream_provider_rate_limit'` and returns:
> "Sorry, the upstream model provider is currently experiencing high demand. Please try again later or consider switching to Auto."

The `ChatErrorDetails` object also gets:
- `level: ChatErrorLevel.Info`
- `isRateLimited: true`

---

## 4. Error → ChatResult → VS Code UI

### 4a. DefaultIntentRequestHandler.processResult() (ask/edit modes)

**File:** `src/extension/prompt/node/defaultIntentRequestHandler.ts` (line ~497)

The big `switch` on `fetchResult.type` creates `chatResult = { errorDetails, metadata }` and calls `turn.setResponse()`:

```typescript
case ChatFetchResponseType.RateLimited: {
    const errorDetails = getErrorDetailsFromChatFetchError(fetchResult, ...);
    const chatResult = { errorDetails, metadata: metadataFragment };
    this.turn.setResponse(TurnStatus.Error, undefined, ..., chatResult);
    return chatResult;  // ← returned to VS Code
}
```

### 4b. Agent mode error modification

**File:** `src/extension/intents/node/agentIntent.ts` (line 643)

After `processResult()`, agent mode's `modifyErrorDetails()` adds a "Try Again" button:
```typescript
modifyErrorDetails(errorDetails, response) {
    if (!errorDetails.responseIsFiltered) {
        errorDetails.confirmationButtons = [
            { data: { copilotContinueOnError: true }, label: 'Try Again' },
        ];
    }
    return errorDetails;
}
```

### 4c. Return to VS Code

**File:** `src/extension/prompt/node/chatParticipantRequestHandler.ts` (line ~277)

The `ChatResult` (with `errorDetails`) is returned from `handler.getResult()` → through `getChatParticipantHandler()` → to `vscode.chat.createChatParticipant()` callback → **VS Code core renders it**.

**File:** `src/extension/conversation/vscode-node/chatParticipants.ts` (line 197-239)

VS Code's chat UI reads `ChatResult.errorDetails` and renders:
- The `.message` as an error/info banner in the chat response
- The `.level` (Info vs Error) controls the visual style
- The `.confirmationButtons` become clickable action buttons
- `isRateLimited` / `isQuotaExceeded` flags may trigger special UI

### 4d. ToolCallingLoop auto-retry (Layer 2 — silent, agent mode only)

**File:** `src/extension/intents/node/toolCallingLoop.ts` (line 382-404, 838-842)

In auto-approve/autopilot modes, `shouldAutoRetry()` catches errors **before** they reach `processResult`:

```typescript
private shouldAutoRetry(response: ChatResponse): boolean {
    if (permLevel !== 'autoApprove' && permLevel !== 'autopilot') return false;
    if (this.autopilotRetryCount >= MAX_AUTOPILOT_RETRIES) return false;
    switch (response.type) {
        case ChatFetchResponseType.RateLimited:    // ← 503 is this type
        case ChatFetchResponseType.QuotaExceeded:
        case ChatFetchResponseType.Canceled:
        case ChatFetchResponseType.OffTopic:
            return false;  // ← NOT retried automatically
        default:
            return response.type !== ChatFetchResponseType.Success;
    }
}
```

**Critical:** Since 503 maps to `RateLimited`, `shouldAutoRetry` returns **false** for 503 — it's NOT auto-retried by the tool calling loop.

---

## 5. Full Flow Diagram (503 Example)

```
HTTP 503 from model endpoint
  │
  ▼
chatMLFetcher.handleErrorResponse()        [src/extension/prompt/node/chatMLFetcher.ts:1636]
  │  → ChatFailKind.RateLimited + capiError.code='upstream_provider_rate_limit'
  │
  ▼
chatMLFetcher.processFailedResponse()      [chatMLFetcher.ts:1886]
  │  → ChatFetchResponseType.RateLimited
  │  (NOT retried by fetcher since 503 ∉ RetryServerErrorStatusCodes)
  │
  ▼
ToolCallingLoop.shouldAutoRetry()           [toolCallingLoop.ts:385]
  │  → returns false (RateLimited excluded from auto-retry)
  │
  ▼
DefaultIntentRequestHandler.processResult() [defaultIntentRequestHandler.ts:511]
  │  → getErrorDetailsFromChatFetchError() → ChatErrorDetails
  │  → turn.setResponse(TurnStatus.Error, ...)
  │  → returns { errorDetails, metadata }
  │
  ▼
AgentIntent.modifyErrorDetails()            [agentIntent.ts:643]
  │  → adds "Try Again" confirmationButton
  │
  ▼
ChatParticipantRequestHandler.getResult()   [chatParticipantRequestHandler.ts:277]
  │  → returns ChatResult to VS Code
  │
  ▼
VS Code chat UI renders error message + "Try Again" button
```

---

## 6. Interception Points for Silent Retry

### Option A: Fetcher-level retry (add 503 to RetryServerErrorStatusCodes) — CLEANEST
**Where:** `src/extension/prompt/node/chatMLFetcher.ts` (line ~531)
**How:** Add 503 to the `RetryServerErrorStatusCodes` config default or override
**Currently:** Default is `'500,502'` at `src/platform/configuration/common/configurationService.ts:897`
**Pro:** Completely silent, happens before any error propagation
**Con:** 503 is currently mapped as RateLimited, NOT ServerError — the retry logic at line 531 checks `response.failKind !== ChatFailKind.ServerCanceled` AND `statusCodesToRetry.includes(actualStatusCode)`, so this would work if 503's raw status code is available

### Option B: Change 503 mapping from RateLimited to ServerError
**Where:** `src/extension/prompt/node/chatMLFetcher.ts` (line ~1636)
**How:** Map 503 to `ChatFailKind.ServerError` instead of `ChatFailKind.RateLimited`
**Effect:** It then becomes `ChatFetchResponseType.Failed`, which IS eligible for `shouldAutoRetry()` in agent mode AND for fetcher-level retry via `RetryServerErrorStatusCodes`
**Pro:** Fully silent retry at multiple layers
**Con:** Changes error messaging (from rate-limit message to generic "request failed"), may affect telemetry

### Option C: Modify shouldAutoRetry to include RateLimited
**Where:** `src/extension/intents/node/toolCallingLoop.ts` (line ~393)
**How:** Remove `ChatFetchResponseType.RateLimited` from the exclusion list
**Pro:** Only affects agent/autopilot modes
**Con:** Would also auto-retry legitimate rate limits (429), not just 503

### Option D: Intercept in processResult before error becomes ChatResult
**Where:** `src/extension/prompt/node/defaultIntentRequestHandler.ts` (line ~511)
**How:** Add retry logic in the `RateLimited` case before creating errorDetails
**Pro:** Targeted, can check `capiError.code === 'upstream_provider_rate_limit'` to only retry 503
**Con:** Retry loop at wrong abstraction layer

### Option E: Add 503-specific handling in chatMLFetcher.handleErrorResponse
**Where:** `src/extension/prompt/node/chatMLFetcher.ts` (line ~1636)
**How:** Instead of returning the error, perform an inline retry loop for 503 (similar to 499 handling at line ~502)
**Pro:** Most targeted, completely silent, specific to 503
**Con:** Adds complexity to an already complex method

### Recommended: Option A + partial Option B
1. Map 503 to `ChatFailKind.ServerError` (not `RateLimited`)
2. Add `503` to the default `RetryServerErrorStatusCodes` → `'500,502,503'`
3. The existing `_retryAfterError` mechanism handles it silently with connectivity check

This gives silent retry at the fetcher level. If the retry fails, the error surfaces as "request failed" (generic) rather than the misleading "upstream provider rate limit" message. In agent mode, `shouldAutoRetry` would also catch it as a second safety net.

---

## 7. Other Consumers of getErrorDetailsFromChatFetchError

| File | Location | Context |
|---|---|---|
| `src/extension/inlineChat/node/inlineChatIntent.ts:277` | Inline chat | Maps error for inline editing UI |
| `src/extension/conversation/vscode-node/languageModelAccess.ts:593` | LM API | Throws `LanguageModelError` for extensions using LM API |
| `src/extension/prompts/node/codeMapper/codeMapper.ts:402` | Code mapper | Maps edits generation errors |

The LM API path (`languageModelAccess.ts`) is different — it throws typed errors (`LanguageModelError.Blocked`, `ChatQuotaExceeded`, `ChatRateLimited`) rather than returning `ChatResult`. Extensions consuming the LM API would see thrown errors, not UI error messages.
