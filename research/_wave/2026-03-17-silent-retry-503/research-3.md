# Research Report: Custom Initiator v039 — Fork Billing System

**Wave**: 2026-03-17-silent-retry-503  
**Report**: research-3  
**Question**: What is the "custom initiator" / fork billing system (`[FORK X-INITIATOR]` code), how does `BillingMode` interact with request headers, and how is `userInitiatedRequest` computed?

---

## 1. Overview

The "custom initiator v039" is a **fork-specific billing control system** that governs how the `X-Initiator` HTTP header is set on Copilot API requests. This header determines whether a request is billed as `user` (premium quota consumed) or `agent` (not billed). The system has three layers:

1. **Configuration** — `BillingMode` setting with three modes
2. **Computation** — `userInitiatedRequest` calculated in `toolCallingLoop.ts`
3. **Application** — Header injected in `chatMLFetcher.ts` for both HTTP and WebSocket paths

---

## 2. BillingMode Configuration

**File**: [configurationService.ts](../../../vscode-copilot-chat/src/platform/configuration/common/configurationService.ts) (lines 688–692)

```typescript
export const BillingMode = defineSetting<'force-agent' | 'dialog' | 'default'>(
  'chat.advanced.billingMode', ConfigType.Simple, 'force-agent'
);
```

### Three Modes

| Mode | Default? | Behavior |
|------|----------|----------|
| `force-agent` | **Yes** (factory default) | Always sends `X-Initiator: agent` → **never billed** |
| `dialog` | No | Shows a billing confirmation dialog before first premium turn; bills only if user accepts |
| `default` | No | Upstream behavior for Gemini-3 Flash (billed); force-agent for all other models |

---

## 3. userInitiatedRequest Computation (toolCallingLoop.ts)

**File**: [toolCallingLoop.ts](../../../vscode-copilot-chat/src/extension/intents/node/toolCallingLoop.ts) (lines 1190–1222)

The `userInitiatedRequest` value is computed as an IIFE inside `this.makeRequest()`. The logic is a decision tree:

### Step 1: Free / BYOK models — pure upstream path
```
IF endpoint.multiplier === 0 OR undefined → free model
IF model.vendor !== 'copilot' → BYOK model
→ Use upstream logic:
  userInitiatedRequest = (iter === 0 && !isContinuation && !isSubAgent && isFirstTurn) || stopHookUserInitiated
```
No fork billing logic applies to free or BYOK models.

### Step 2: `force-agent` mode
```
→ return false  (always unbilled)
```

### Step 3: `default` mode
```
IF model is NOT gemini-3-flash:
  → return false  (force-agent for non-gemini)
IF model IS gemini-3-flash:
  → return (iter === 0 && !isContinuation && !isSubAgent) || stopHookUserInitiated
  (billed on user messages only, not tool-call iterations)
```

### Step 4: `dialog` mode (falls through to dialog-specific logic)
```
IF model is high-risk (claude-opus-4 with multiplier >= 30):
  → return false  (never bill high-risk models)
IF billingAccepted (user accepted the confirmation dialog):
  → return true  (BILLED via billing guard)
ELSE:
  → upstream logic: (iter === 0 && !isContinuation && !isSubAgent && isFirstTurn) || stopHookUserInitiated
```

### stopHookUserInitiated
**Line 169**: `private stopHookUserInitiated = false;`  
**Line 879**: Set to `true` when a stop hook blocks stopping and the agent continues — this ensures the continuation round is treated as user-initiated for billing purposes.  
**Line 1221**: Reset to `false` in the `.finally()` after `makeRequest()`.

---

## 4. Billing Guard Dialog (dialog mode only)

**File**: [toolCallingLoop.ts](../../../vscode-copilot-chat/src/extension/intents/node/toolCallingLoop.ts) (lines 752–790)

Before the tool-calling loop begins, if `billingMode === 'dialog'` and the user hasn't already accepted/rejected billing:

1. Check if the request would be billed (first turn, not subagent)
2. Skip free models, BYOK models, and high-risk models (claude-opus-4 ≥30x)
3. Show a VS Code confirmation dialog:
   > "Model **{name}** (multiplier: {n}x) will consume premium quota. Continue as billed request, or cancel to send as non-billed."
4. Return early with an empty response — no model call is made yet
5. If user clicks "Continue", a re-request arrives with `copilotBillingAccepted: true` in `acceptedConfirmationData`
6. `isBillingAccepted()` then returns `true`, and `userInitiatedRequest` is set to `true`

**File**: [defaultIntentRequestHandler.ts](../../../vscode-copilot-chat/src/extension/prompt/node/defaultIntentRequestHandler.ts) (line 157)
```typescript
if (resultDetails.toolCallRounds.length === 0 && !isBillingAccepted(this.request)) {
    return resultDetails.chatResult || {};  // Early return for billing dialog shown
}
```

---

## 5. X-Initiator Header Application (chatMLFetcher.ts)

**File**: [chatMLFetcher.ts](../../../vscode-copilot-chat/src/extension/prompt/node/chatMLFetcher.ts)

### 5a. Double Override in `fetchMany()` (lines 146–177)

Before headers are set, `fetchMany()` applies a **second** billing mode override (defense-in-depth):

| BillingMode | Override Action |
|-------------|-----------------|
| `force-agent` | If `userInitiatedRequest === true`, force it to `false` |
| `dialog` | No override — let upstream value pass through |
| `default` | If model is gemini-3-flash → passthrough; otherwise force `false` |

A `[FORK BILLING-SUMMARY]` log line records the final state for premium models.

### 5b. HTTP Path — `fetchChatCompletion()` (line 1316)

```typescript
const additionalHeaders: Record<string, string> = {
    'X-Interaction-Id': this._interactionService.interactionId,
    'X-Initiator': userInitiatedRequest ? 'user' : 'agent',
};
```
Logged as `[FORK X-HEADER-HTTP]`.

### 5c. WebSocket Path — (line 1075)

```typescript
const additionalHeaders: Record<string, string> = {
    'Authorization': `Bearer ${secretKey}`,
    'X-Request-Id': ourRequestId,
    'OpenAI-Intent': intent,
    'X-GitHub-Api-Version': '2025-05-01',
    'X-Interaction-Id': this._interactionService.interactionId,
    'X-Initiator': userInitiatedRequest ? 'user' : 'agent',
};
```
Logged as `[FORK X-HEADER-WS]`.

---

## 6. IBillingConfirmation Type System

**File**: [specialRequestTypes.ts](../../../vscode-copilot-chat/src/extension/prompt/common/specialRequestTypes.ts) (lines 35–42)

```typescript
export interface IBillingConfirmation {
    copilotBillingAccepted: true;
}

const isBillingConfirmation = (c: unknown): c is IBillingConfirmation =>
    !!(c && (c as IBillingConfirmation).copilotBillingAccepted === true);

export const isBillingAccepted = (request: ChatRequest) =>
    !!request.acceptedConfirmationData?.some(isBillingConfirmation);

export const isBillingRejected = (request: ChatRequest) =>
    !!request.rejectedConfirmationData?.some(isBillingConfirmation);
```

Uses VS Code's `ChatRequest.acceptedConfirmationData` / `rejectedConfirmationData` arrays to carry the billing decision across re-requests.

---

## 7. Failsafe Logging

**File**: [chatMLFetcher.ts](../../../vscode-copilot-chat/src/extension/prompt/node/chatMLFetcher.ts) (lines 141–143)

```typescript
if (userInitiatedRequest === undefined && chatEndpoint.multiplier && chatEndpoint.multiplier > 0) {
    this._logService.warn(`[FORK BILLING-FAILSAFE] fetchMany called with userInitiatedRequest=undefined ...`);
}
```

Warns if a premium model request reaches the fetcher without an explicit billing classification — a safety net for catching regressions.

---

## 8. Data Flow Summary

```
User sends message
    │
    ▼
chatParticipants.ts [line 208-209]
    → logs turn info, billingMode
    │
    ▼
toolCallingLoop.ts (billing guard, lines 752-790)
    → IF dialog mode: show confirmation, return early
    → IF accepted re-request: proceed with billingAccepted=true
    │
    ▼
toolCallingLoop.ts (userInitiatedRequest IIFE, lines 1190-1222)
    → Compute userInitiatedRequest based on:
       - free/BYOK → upstream
       - force-agent → false
       - default → false (non-gemini) / upstream (gemini-flash)
       - dialog → high-risk=false / billingAccepted=true / upstream
    │
    ▼
chatMLFetcher.ts fetchMany() (lines 146-177)
    → Second override (defense-in-depth)
    → Log [FORK BILLING-SUMMARY]
    │
    ▼
chatMLFetcher.ts HTTP or WS path
    → Set header: X-Initiator: user|agent
    → Log [FORK X-HEADER-HTTP] or [FORK X-HEADER-WS]
    │
    ▼
GitHub Copilot API
    → X-Initiator: user → billed (premium quota)
    → X-Initiator: agent → not billed
```

---

## 9. Key Files Index

| File | Lines | Purpose |
|------|-------|---------|
| `src/platform/configuration/common/configurationService.ts` | 688–692 | `BillingMode` setting definition |
| `src/extension/intents/node/toolCallingLoop.ts` | 169 | `stopHookUserInitiated` field |
| `src/extension/intents/node/toolCallingLoop.ts` | 752–790 | Billing guard dialog (dialog mode) |
| `src/extension/intents/node/toolCallingLoop.ts` | 879 | `stopHookUserInitiated = true` on hook block |
| `src/extension/intents/node/toolCallingLoop.ts` | 1190–1222 | `userInitiatedRequest` computation IIFE |
| `src/extension/prompt/node/chatMLFetcher.ts` | 141–143 | Billing failsafe warning |
| `src/extension/prompt/node/chatMLFetcher.ts` | 146–177 | Defense-in-depth override + summary log |
| `src/extension/prompt/node/chatMLFetcher.ts` | 1075 | WebSocket `X-Initiator` header |
| `src/extension/prompt/node/chatMLFetcher.ts` | 1316 | HTTP `X-Initiator` header |
| `src/extension/prompt/common/specialRequestTypes.ts` | 35–42 | `IBillingConfirmation` type + helpers |
| `src/extension/prompt/node/defaultIntentRequestHandler.ts` | 157 | Early return after billing dialog |
| `src/extension/conversation/vscode-node/chatParticipants.ts` | 208–209 | Turn/billing mode logging |
