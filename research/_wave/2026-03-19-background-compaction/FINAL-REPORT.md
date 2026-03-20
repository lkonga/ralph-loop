# Final Report: Background Compaction Architecture in VS Code Copilot Chat

## Executive Summary

The VS Code Copilot Chat extension implements a **three-tier progressive compaction hierarchy** to manage conversation context within LLM token limits: (1) server-side Responses API compaction (preferred), (2) background client-side dual-threshold summarization, and (3) foreground client-side summarization (fallback on `BudgetExceededError`). Server-side and client-side paths are mutually exclusive. Background compaction uses a state machine with dual thresholds — speculative start at 75% context usage, blocking wait at 95% — with an 85% safety margin on the budget calculation. Summarization is LLM-based (not algorithmic), with full 8-section and simple fallback modes. Both newer compaction systems (background and Responses API) are experiment-gated. The `/compact` slash command provides user-triggered compaction. Key evolution: foreground summarization since v0.32, `/compact` command in v0.38, background and server-side compaction experiment-gated from v0.39+.

## Consolidated Findings

### 1. Three-Tier Compaction Architecture

The system uses a **progressive hierarchy with mutual exclusion**:

1. **Server-side (Responses API)** — Preferred when available. Sends `context_management` with `compact_threshold = floor(modelMaxPromptTokens * 0.9)` (fallback `50000`). Server returns encrypted compaction data round-tripped via `CompactionDataContainer`. Model exclusions: `gpt-5`, `gpt-5.1`, `gpt-5.2`. [via: aggregation-1.md#L24-L25 ← research-4.md#L30-L38]
2. **Background client-side** — Dual-threshold state machine (`BackgroundSummarizer`): ≥75% context → speculative start; ≥95% → blocking wait; Completed → immediate apply. [via: aggregation-1.md#L26 ← research-2.md#L30-L40]
3. **Foreground client-side** — Synchronous fallback when `BudgetExceededError` is thrown during prompt rendering. Falls back through: try with `triggerSummarize: true` → render without cache breakpoints. [via: aggregation-1.md#L27 ← research-2.md#L22-L28]

When server-side compaction is active, client-side summarization is fully disabled. [via: aggregation-1.md#L29 ← research-2.md#L48-L50, research-4.md#L37-L38]

### 2. Background Compaction Dual-Threshold State Machine

Budget calculation: `budgetThreshold = floor((baseBudget - toolTokens) * 0.85)`

State machine transitions:
- **≥75% context + Idle/Failed** → kick off background compaction
- **≥95% context + InProgress** → block and wait for completion
- **≥95% context + Completed** → apply immediately
- Lifecycle: `Idle → InProgress → Completed/Failed → (consumeAndReset) → Idle`

[via: aggregation-1.md#L33-L36 ← research-2.md#L30-L40] [via: aggregation-2.md#L20-L27 ← research-4.md#L44-L55]

### 3. LLM-Based Summarization Modes

Conversation history is re-sent to the LLM with a structured summarization prompt (not algorithmically compressed). Two modes:

- **Full mode** (`ConversationHistorySummarizationPrompt`): Detailed 8-section summary (Overview, Technical Foundation, Codebase Status, Problem Resolution, Progress Tracking, Active Work State, Recent Operations, Continuation Plan). Uses `tool_choice: 'none'`. [via: aggregation-1.md#L39-L40 ← research-2.md#L56-L66]
- **Simple mode** (`SimpleSummarizedHistory`): Fallback with text truncation — tool results halved, arguments capped at 200 chars, `PrioritizedList` packing. Used for model switches or failed prior summarizations. [via: aggregation-1.md#L41-L42 ← research-2.md#L68-L74]

### 4. Summarization Boundary Logic

`SummarizedConversationHistoryPropsBuilder.getProps()` determines the summarization boundary:
- Multiple tool call rounds in current turn → exclude last round, summarize up to second-to-last
- Single/zero rounds → summarize from last round of previous turn, mark as `isContinuation`
- Summary anchors to a specific `toolCallRoundId`; everything before is replaced in prompt rendering

[via: aggregation-1.md#L44-L49 ← research-2.md#L77-L83]

### 5. Summary Persistence and Rendering

- **In-memory**: `round.summary = summaryText` on the identified round
- **Persistence**: `turn.resultMetadata.summaries[]`
- **Restoration**: `normalizeSummariesOnRounds()` re-applies each request start
- **Rendering**: `ConversationHistory.render()` replaces summarized turns with `<conversation-summary>` tag; all preceding turns discarded
- **Optional**: Transcript JSONL lookup via `ReadFile` tool (gated behind `ConfigKey.ConversationTranscriptLookup`)

[via: aggregation-1.md#L51-L58 ← research-2.md#L85-L100]

### 6. Budget Calculation

```
baseBudget = min(configOverride ?? modelMaxPromptTokens, modelMaxPromptTokens)
budgetThreshold = floor((baseBudget - toolTokens) * 0.85)
```

85% safety margin applied. Summary rejected if `summaryTokens > effectiveBudget`. [via: aggregation-1.md#L60-L64 ← research-2.md#L106-L112]

### 7. Configuration and Experiment Gating

| Setting | Default | Purpose |
|---------|---------|---------|
| `chat.backgroundCompaction` | `false` (experiment) | Enables background dual-threshold compaction |
| `chat.responsesApiContextManagement.enabled` | `false` (experiment) | Enables server-side Responses API compaction |
| `chat.summarizeAgentConversationHistory.enabled` | `true` | Enables foreground summarization |
| `chat.advanced.summarizeAgentConversationHistoryThreshold` | `undefined` | Token threshold override |

[via: aggregation-1.md#L66-L73 ← research-4.md#L20-L28] [via: aggregation-2.md#L33-L34 ← research-4.md#L27-L32]

### 8. PreCompact Hook

A `PreCompact` hook is executed before summarization via `chatHookService.executeHook('PreCompact', ...)`, enabling transcript archival or cleanup. [via: aggregation-1.md#L75-L76 ← research-2.md#L102-L103]

### 9. Key Implementation Files

`agentIntent.ts` (orchestration), `backgroundSummarizer.ts` (state machine), `responsesApi.ts` (server-side), `compactionDataContainer.tsx` (data round-trip), `openai.ts` (API integration). [via: aggregation-2.md#L36 ← research-4.md#L11-L16]

### 10. Telemetry

Every compaction decision path emits telemetry events (`backgroundSummarizationApplied`, `triggerSummarizeFailed`). [via: aggregation-2.md#L40 ← research-4.md#L107]

## Pattern Catalog

| # | Pattern | Details | Source Refs |
|---|---------|---------|-------------|
| 1 | **Dual-threshold state machine** | 75% speculative / 95% blocking with Idle→InProgress→Completed/Failed lifecycle | [via: aggregation-1.md#L83-L84 ← research-2.md#L30-L40, research-4.md#L42-L50] |
| 2 | **Mutual exclusion guard** | Server-side compaction boolean disables all client-side summarization | [via: aggregation-1.md#L86-L87 ← research-2.md#L48-L50, research-4.md#L37-L38] |
| 3 | **Progressive fallback chain** | Server-side → background → foreground, each level a safety net for the prior | [via: aggregation-1.md#L24-L28 ← research-4.md#L11-L16] |
| 4 | **LLM self-summarization** | Re-send history to LLM for compression rather than algorithmic truncation | [via: aggregation-1.md#L39-L42 ← research-2.md#L56-L74] |
| 5 | **Budget safety margin (0.85)** | Empirical multiplier preventing token overflow edge cases | [via: aggregation-1.md#L89 ← research-2.md#L106-L112, research-4.md#L89] |
| 6 | **Experiment gating for rollout** | New compaction paths behind feature flags for A/B testing | [via: aggregation-1.md#L90 ← research-2.md#L131, research-4.md#L86-L87] |
| 7 | **Opaque encrypted round-trip** | Server-side compaction data stored as encrypted blob, client never inspects | [via: aggregation-2.md#L17-L18 ← research-4.md#L36-L42] |

## Priority Matrix

| Pattern | Impact | Effort | Priority | Sources |
|---------|--------|--------|----------|---------|
| Dual-threshold background compaction (75%/95%) | High | Medium | P0 | [via: aggregation-1.md#L83-L84 ← research-2.md#L30-L40, research-4.md#L42-L50] |
| Server-side vs client-side mutual exclusion | High | Low | P0 | [via: aggregation-1.md#L86-L87 ← research-2.md#L48-L50, research-4.md#L37-L38] |
| LLM-based summarization (full/simple fallback) | High | High | P1 | [via: aggregation-1.md#L91 ← research-2.md#L56-L74] |
| Budget safety margin (0.85 multiplier) | Medium | Low | P1 | [via: aggregation-1.md#L93 ← research-2.md#L106-L112, research-4.md#L89] |
| Experiment gating for rollout | Medium | Low | P1 | [via: aggregation-1.md#L90 ← research-4.md#L105-L106] |
| `/compact` slash command | Medium | Low | P2 | [via: aggregation-2.md#L46 ← research-4.md#L60-L64] |
| PreCompact hook integration | Medium | Low | P2 | [via: aggregation-1.md#L92 ← research-2.md#L102-L103] |
| Transcript JSONL lookup fallback | Low | Low | P3 | [via: aggregation-1.md#L94 ← research-2.md#L97-L100] |

## Recommended Plan

1. **Understand the state machine** — Start with `backgroundSummarizer.ts` to internalize the dual-threshold lifecycle before making any changes
2. **Review mutual exclusion logic** — Verify the server-side guard in `agentIntent.ts` to ensure client-side paths are correctly disabled
3. **Tune thresholds if needed** — The 75%/95%/85% values are empirical; any adjustment should be data-driven using existing telemetry events
4. **Evaluate summarization quality** — Compare full vs simple mode outputs to assess semantic fidelity (currently unmeasured)
5. **Test `/compact` + background interaction** — Clarify behavior when user triggers `/compact` while background compaction is in-progress
6. **Monitor experiment rollout** — Track `BackgroundCompaction` and `ResponsesApiContextManagement` experiment metrics before broader enablement

## Gaps & Further Research

1. **Missing research reports**: research-1.md and research-3.md were requested but do not exist — their intended topics are unknown and may contain critical findings
2. **Summary quality metrics**: No data on how well compacted summaries preserve critical information (semantic fidelity measurement needed)
3. **Telemetry analysis**: Rich instrumentation exists but no actual metrics on compaction frequency, success rates, or threshold hit rates were analyzed
4. **User experience impact**: No data on how compaction affects perceived response quality or conversation coherence
5. **Recursive summarization**: Code explicitly chose not to implement recursive summarization over chunks — no analysis of whether this is a practical limitation
6. **Exact git diffs**: Precise commit-level changes between v0.38 and v0.41 remain unavailable (no `git log` access)
7. **Threshold tuning rationale**: Whether 75%/95%/85% values are data-driven or heuristic is not established
8. **`/compact` + background interaction**: Behavior when user triggers manual compaction during active background compaction is unclear
9. **gpt-5 family exclusion rationale**: Why these models are excluded from Responses API compaction is not explained

## Source Chain

- aggregation-1.md → research-2.md (compaction algorithm implementation), research-4.md (git history changes v0.38→v0.41)
- aggregation-2.md → research-4.md (compaction-related git history changes v0.38→v0.41)
- Note: research-1.md and research-3.md referenced but not found in wave directory
