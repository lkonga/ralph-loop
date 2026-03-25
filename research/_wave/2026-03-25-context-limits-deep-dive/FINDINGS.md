# Context Limits Deep Dive: True vs Advertised Model Limits

**Date**: 2026-03-25
**Models**: Claude Opus 4.6 Fast, Claude Sonnet 4.6, GPT-5.4
**Source**: VS Code Copilot Chat 0.41 (`bisect/v0.41-lean`) + request trace analysis

---

## 1. Executive Summary

The "advertised" context limits for large models (192k for Opus 4.6 fast, 400k for GPT-5.4) are **client-side enforcement only**. The backend inference APIs accept significantly more — empirically proven up to 602k for Opus and 900k for GPT-5.4. The limit enforcement is a combination of:

1. **Backend metadata response**: `max_prompt_tokens` in the model capabilities JSON
2. **Client budget calculation**: `floor((max_prompt_tokens - toolTokens) * 0.85)`
3. **Client-side compaction**: triggers at percentages of the budget

None of these are hard backend limits — they are cosmetic guardrails.

---

## 2. Model Metadata (Backend Response)

From the backend `/models` endpoint:

```
Claude Opus 4.6 Fast:
  max_context_window_tokens: 200,000
  max_prompt_tokens:         128,000
  max_output_tokens:          64,000
  supported_endpoints: ["/v1/messages", "/chat/completions"]

Claude Sonnet 4.6:
  max_context_window_tokens: 200,000
  max_prompt_tokens:         128,000
  max_output_tokens:          32,000
  supported_endpoints: ["/chat/completions", "/v1/messages"]

GPT-5.4:
  max_prompt_tokens:         ~400,000  (via Responses API)
  supported_endpoints: [Responses API, WebSocket Responses]
```

**The actual Anthropic API** natively supports:
- 200k context window (standard)
- 1M context window (with `claude-*-1m` variant or extended beta header)

**The GitHub Copilot proxy** reports `max_prompt_tokens: 128000` for Opus, which is LOWER than Anthropic's native 200k. This is the proxy's own limit, not Anthropic's.

---

## 3. Empirical Evidence: Going Beyond Advertised Limits

### GPT-5.4 (advertised: 400k)
- **Observed**: 900k prompt_tokens in successful requests
- **Mechanism**: `useResponsesApiTruncation: true` sets client budget to `Number.MAX_SAFE_INTEGER`
- **Server behavior**: Accepts full payload. `truncation: 'auto'` in request body allows server-side truncation if needed
- **Real server limit**: ~1M (no 413 until approaching ~1M HTTP body size)

### Claude Opus 4.6 Fast (advertised: 128k via proxy, 192k native)
- **Observed**: 602k prompt_tokens in successful request (b638babd)
- **Breakdown**: `input_tokens=602155`, `cached_tokens=448481`
- **Mechanism**: Model switch (Gemini → Opus Ask → Opus Agent) combined with context editing flags
- **Subsequent request**: 451k prompt_tokens (242ff7fb) — also way beyond limit
- **Eventually**: compacted back to ~127k on later request (889a0a1d)

---

## 4. How Opus 4.6 Fast Went Beyond 128k

### Request trace timeline:
```
08:18:21 — Ask mode, 22 tools        → 126,961 tokens (within budget)
08:27:39 — Agent mode after switch    → 602,155 tokens (4.7x beyond budget!)
08:28:57 — Agent mode continuation    → 451,815 tokens (3.5x beyond budget)
08:37:25 — Agent mode + 22 tools      → 126,776 tokens (back to budget)
```

### Analysis of the 602k request:
- `tools (1): tool_search_tool_regex` — only 1 tool (not 22)
- `cached_tokens: 448481` — 448k cached from previous conversation
- `maxPromptTokens: 127997` — client THINKS budget is 128k

### Hypothesis: How it bypassed the client budget

**Most likely cause**: The Anthropic `context_editing` feature at the proxy/server level.

The user has:
- `contextEditing.triggerThreshold: 500000` — fire at 500k
- `contextEditing.mode: 'off'` (default) BUT it's `ExperimentBased` — the experiment service may have overridden it

If `contextEditing.mode` was experiment-enabled (e.g., `'clear-thinking'`):
1. Client renders ~128k worth of messages into the HTTP body
2. Client sends to GitHub Copilot proxy with `context_management: { edits: [...] }`
3. Proxy forwards to Anthropic with the full conversation
4. Anthropic applies context edits (clears old thinking/tool results)
5. Anthropic processes the edited (shorter) version
6. But reports usage based on the ORIGINAL input count including cache

**Alternative hypothesis**: `forceUnlimitedBudget` was `true` at VS Code startup and then changed to `false` during the session. Since the config is hot-reloaded per-request, this would explain some requests at 602k and later ones at 128k.

**Third hypothesis**: Model switch timing. When switching from Ask mode to Agent mode, the `AgentIntentInvocation` is created fresh. But the conversation history carries over from the Ask mode session. If the Ask mode was using a different model (Gemini), the `modelMaxPromptTokens` from Gemini (potentially higher) might have been cached somewhere and used for the Opus budget calculation before the endpoint was re-resolved.

### Key insight from the token counts:
```
Request  | prompt_tokens | cached_tokens | effective_new
---------|---------------|---------------|---------------
Ask mode | 126,961       | 0             | 126,961
Agent 1  | 602,155       | 448,481       | 153,674
Agent 2  | 451,815       | 450,087       | 1,728
Reset    | 126,776       | 0             | 126,776
```

The `effective_new` (prompt_tokens - cached_tokens) for Agent 2 is only **1,728 tokens** — the conversation was almost entirely cached. This suggests the backend had a massive prompt cache from Agent 1, and Agent 2 just appended a tiny amount.

---

## 5. v0.39 vs v0.41 Compaction Regression

### Root cause
v0.41 introduced `AgentConversationHistory` — a performance-optimized renderer that REPLACES `SummarizedConversationHistory` when `enableCacheBreakpoints = false`.

```
v0.39: ALWAYS → SummarizedConversationHistory
  ✓ Checks round.summary (summary-aware)
  ✓ truncateAt on tool results (capped at 200k per result)
  ✓ /compact summaries honored
  ✓ Sessions at 730k worked (bounded HTTP body)

v0.41: if (enableCacheBreakpoints)
         → SummarizedConversationHistory  (same as v0.39)
       else
         → AgentConversationHistory       (NEW, broken)
  ✗ NO summary check (summary-blind)
  ✗ NO truncateAt (unbounded tool results)
  ✗ /compact silently ignored
  ✗ 413 "failed to parse request" at 730k+
```

### When the broken path is taken:
```
enableCacheBreakpoints = summarizationEnabled
summarizationEnabled = S && !C

Where:
  S = summarizeAgentConversationHistory.enabled
  C = responsesApiContextManagement.enabled

Broken when:
  • S=false (user disabled summarization)
  • C=true (server compaction enabled → forces S=false)
```

### Why the 413 specifically:
- `AgentConversationHistory` has NO `truncateAt` prop on `ChatToolCalls`
- Historical tool results are rendered at FULL SIZE (some 50-100k chars each)
- At 730k tokens, the JSON HTTP body exceeds the server's parse limit
- 413 "failed to parse request" — not a token limit, an HTTP body size limit

---

## 6. Compaction System Architecture

### Three-tier hierarchy with mutual exclusion:
```
1. Server-side (Responses API) — GPT models
   • context_management: [{ type: 'compaction', compact_threshold: 90% }]
   • Data round-tripped via CompactionDataContainer
   • Exclusions: gpt-5, gpt-5.1, gpt-5.2 (GPT-5.4 NOT excluded)
   
2. Server-side (Anthropic Messages API) — Claude models
   • context_management: { edits: [clear_thinking, clear_tool_uses] }
   • triggerThreshold: 100k default (user set to 500k)
   • Modes: off | clear-thinking | clear-tooluse | clear-both

3. Client-side summarization — all models
   • Background: dual-threshold (75%/95% of budgetThreshold)
   • Foreground: triggered on BudgetExceededError
   • Disabled when server compaction (C) is on
```

### Budget calculation:
```typescript
baseBudget = Math.min(configThreshold ?? modelMaxPromptTokens, modelMaxPromptTokens)
budgetThreshold = floor((baseBudget - toolTokens) * 0.85)
safeBudget = (forceUnlimited || useTruncation) ? ∞ : budgetThreshold
```

### SummarizeAgentConversationHistoryThreshold limitation:
```typescript
baseBudget = Math.min(threshold ?? modelMP, modelMP)  // CAPPED at modelMP!
```
Setting threshold to 999999 when modelMP=128k gives 128k — useless for raising limits.

---

## 7. Conversation Transcript Lookup

When enabled (`conversationTranscriptLookup.enabled: true`):

1. **Before compaction**: Writes full conversation to `workspaceStorage/transcripts/{sessionId}.jsonl`
2. **After compaction**: Injects into summary message:
   > "If you need specific details from before compaction, use the read_file tool to look up the full uncompacted conversation transcript at: {path}"
3. **ONLY works** with `SummarizedConversationHistory` renderer (requires `enableCacheBreakpoints = true` → `summarizationEnabled = true`)
4. Does NOT work with `AgentConversationHistory` (the v0.41 regression path)

### Format: JSONL
```json
{"type":"session.start","data":{"sessionId":"...","version":1}}
{"type":"user.message","data":{"content":"..."}}
{"type":"assistant.message","data":{"content":"...","toolRequests":[...]}}
{"type":"tool.execution_complete","data":{"toolCallId":"...","result":"..."}}
```

---

## 8. Exhastive 8-Combination Analysis

| S | T | C | Can reach 400k+? | /compact works? | Post-compact | Outcome |
|---|---|---|---|---|---|---|
| 0 | 0 | 0 | NO (340k) | Yes but... | BLIND render | 💀 crash |
| 0 | 0 | 1 | NO (340k) | BLOCKED | N/A | 💀 crash |
| 0 | 1 | 0 | YES | Yes but... | BLIND render | ⚠️ 413 |
| 0 | 1 | 1 | YES (server) | BLOCKED | Server slice | ✅ works? |
| 1 | 0 | 0 | NO (340k) | ✅ works | AWARE render | ✅ bounded |
| 1 | 0 | 1 | NO (340k) | BLOCKED | BLIND render | 💀 crash |
| 1 | 1 | 0 | YES | ✅ once | AWARE render | ⚠️ regrows |
| 1 | 1 | 1 | YES (server) | BLOCKED | Server slice | ✅ works? |

Where:
- S = `summarizeAgentConversationHistory.enabled`
- T = `useResponsesApiTruncation`
- C = `responsesApiContextManagement.enabled`

---

## 9. Fix Plan

### Surgical fix 1: `maxPromptTokensOverride`
Override `modelMaxPromptTokens` at the endpoint level to the TRUE server limit (850k).
This shifts ALL compaction thresholds to match reality:

```
With override at 850k:
  baseBudget = 850k
  budgetThreshold = ~722k
  Background compact starts at ~542k (75%)
  Background compact blocks at ~686k (95%)
  Server compact_threshold = ~765k (90%)
```

### Surgical fix 2: Add `truncateAt` to `AgentConversationHistory`
The v0.41 regression — missing `truncateAt` on historical `ChatToolCalls`.
Adding it restores v0.39 behavior without changing the renderer selection.

### Surgical fix 3: Summary awareness in `AgentConversationHistory`
Add `round.summary` check and `break` logic to `AgentConversationHistory`.
This fixes `/compact` being silently ignored on the non-summarization path.

### Config recommendation for 1M usage:
```json
{
  "github.copilot.chat.summarizeAgentConversationHistory.enabled": true,
  "github.copilot.chat.conversationTranscriptLookup.enabled": true,
  "github.copilot.chat.responsesApiContextManagement.enabled": false,
  "github.copilot.chat.fork.maxPromptTokensOverride": 850000,
  "github.copilot.chat.anthropic.contextEditing.mode": "clear-both",
  "github.copilot.chat.anthropic.contextEditing.triggerThreshold": 100000
}
```

---

## 10. Key Config Flag Reference

| Flag | Default | What it does |
|---|---|---|
| `summarizeAgentConversationHistory.enabled` | **true** | Master switch: enables client-side compaction AND selects SummarizedConversationHistory renderer |
| `summarizeAgentConversationHistoryThreshold` | undefined | Overrides baseBudget — BUT capped at modelMaxPromptTokens via Math.min |
| `useResponsesApiTruncation` | false | Sets safeBudget=∞ for Responses API models (GPT). Sends `truncation: 'auto'` |
| `responsesApiContextManagement.enabled` | false | Server-side compaction for GPT models. Disables client summarization when on |
| `anthropic.contextEditing.mode` | off (exp) | Server-side pruning for Claude: off/clear-thinking/clear-tooluse/clear-both |
| `anthropic.contextEditing.triggerThreshold` | 100000 | Token threshold for Anthropic context editing |
| `conversationTranscriptLookup.enabled` | false (exp) | Writes transcript pre-compaction, injects PD hint post-compaction |
| `backgroundCompaction` | false (exp) | Background summarization at 75%/95% thresholds |
| `agentHistorySummarizationHelperModel` | "" | Model override for generating summaries (default: copilot-base/GPT-4.1) |
| `agentHistorySummarizationMode` | undefined | Force 'simple' or 'full' summarization mode |
| `agentHistorySummarizationWithPromptCache` | false | Use prompt cache during summarization (Anthropic optimization) |
| `anthropic.promptCaching.extendedTtl` | false | 1h cache TTL for claude-opus-4.6-1m only |
| `fork.forceUnlimitedBudget` | false | Sets safeBudget=∞ for ALL models (debug flag) |
| `fork.maxPromptTokensOverride` | 0 | Override modelMaxPromptTokens at endpoint level |
| `virtualTools.threshold` | 128 | Virtualize (lazy-load) tool results above this token count |

---

## 11. Open Questions

1. **Exact experiment state**: What values does the A/B testing service set for `anthropic.contextEditing.mode` and `backgroundCompaction`?
2. **Model switch cache leakage**: Does switching models mid-session cause budget from the previous model to persist?
3. **Proxy vs native limits**: Does the GitHub Copilot proxy enforce max_prompt_tokens at the HTTP level, or just report it in metadata?
4. **Anthropic 1M access**: Can the proxy be configured to use the 1M context variant for Opus 4.6?
5. **Memory tool**: Currently Anthropic-only. How to enable for GPT models?

---

*Analysis performed on `bisect/v0.41-lean` (2026-03-25)*
*Request traces from live session using Claude Opus 4.6 Fast (claude-opus-4-6)*
