# Research Report: Compaction-Related Git History Changes (v0.38 → v0.41)

## Question
What git history changes have been made to the compaction-related files since v0.38? Have there been algorithmic or threshold changes?

## Findings

### 1. Compaction File Inventory

The vscode-copilot-chat codebase has **three distinct compaction systems**:

| System | Files | Purpose |
|--------|-------|---------|
| **Responses API Context Management** | `src/platform/endpoint/node/responsesApi.ts`, `src/platform/endpoint/common/compactionDataContainer.tsx`, `src/platform/networking/common/openai.ts` | Server-side compaction via OpenAI Responses API — encrypted context summarization |
| **Background Compaction (Summarization)** | `src/extension/intents/node/agentIntent.ts`, `src/extension/prompts/node/agent/backgroundSummarizer.ts` | Client-side background summarization of conversation history |
| **Foreground Summarization** | `src/extension/intents/node/agentIntent.ts` (same file) | Synchronous conversation summarization when budget exceeded |

Minor/unrelated compaction references:
- `src/extension/trajectory/vscode-node/otelChatDebugLogProvider.ts` — span array compaction (data structure, not conversation)
- `src/util/vs/base/common/event.ts` — listener array compaction (VS Code utility, readonly)
- `src/platform/inlineEdits/common/workspaceEditTracker/nesXtabHistoryTracker.ts` — edit history compaction

### 2. Key Configuration Settings

| Setting | Type | Default | Purpose |
|---------|------|---------|---------|
| `chat.backgroundCompaction` | ExperimentBased | `false` | Enables background compaction (dual-threshold approach) |
| `chat.responsesApiContextManagement.enabled` | ExperimentBased | `false` | Enables server-side Responses API compaction |
| `chat.summarizeAgentConversationHistory.enabled` | Simple | `true` | Enables foreground summarization |
| `chat.advanced.summarizeAgentConversationHistoryThreshold` | Simple | `undefined` (uses model max) | Token threshold override for summarization trigger |

### 3. Algorithmic Details — Current State

#### Responses API Compaction (Server-Side)
- **Threshold**: `compact_threshold = Math.floor(endpoint.modelMaxPromptTokens * 0.9)` or fallback `50000`
- **Model exclusions**: `gpt-5`, `gpt-5.1`, `gpt-5.2` excluded via `modelsWithoutResponsesContextManagement`
- **Guard**: Only active when `endpoint.apiType === 'responses'` AND the experiment flag is enabled
- **Mechanism**: Sends `context_management: [{ type: 'compaction', compact_threshold }]` to the API; the server returns encrypted compaction data that gets round-tripped via `CompactionDataContainer` opaque prompt elements
- **When active, disables client-side summarization** — `summarizationEnabled = ... && !responsesCompactionContextManagementEnabled`

#### Background Compaction (Client-Side)
- **Guard**: `BackgroundCompaction` experiment flag AND `SummarizeAgentConversationHistory` enabled AND Responses API compaction NOT enabled
- **Budget calculation**: `budgetThreshold = Math.floor((baseBudget - toolTokens) * 0.85)`
- **Dual-threshold approach** (from comments in agentIntent.ts):
  - **≥ 95% context usage + InProgress** → Block, wait for background compaction to complete, apply before rendering
  - **≥ 95% context usage + Completed** → Apply immediately
  - **≥ 75% context usage + Idle/Failed** → Kick off background compaction for future use
  - **Budget exceeded + InProgress/Completed** → Wait/apply background result instead of new summarization request
- **State machine**: `Idle → InProgress → Completed/Failed → (consumeAndReset) → Idle`

#### Foreground Summarization
- Triggered when `BudgetExceededError` is thrown during prompt rendering
- Falls back through: try with `triggerSummarize: true` → if that fails, render without cache breakpoints with original endpoint

### 4. CHANGELOG Evidence of Changes

**v0.38** (2026-03-05):
- "Claude agent improvements — context window rendering with compaction, new slash commands (`/compact`, ...)"
- "Session memory for plans — Plans persist to session memory and stay available across conversation turns, surviving compaction."
- This is the first mention of `/compact` as a slash command

**v0.40** (2026-03-18):
- No explicit compaction changelog entries, but this is the latest release before v0.41

**Earlier (v0.32, ~2025-08):**
- "Conversation history summarized and optimized for prompt caching" — first introduction of the foreground summarization system

### 5. Identified Changes Between v0.38 and v0.41

Based on code analysis (git history not directly accessible from the search tools), the following features appear to have been added or evolved in this window:

1. **Background Compaction System** — The entire `BackgroundSummarizer` class and dual-threshold orchestration in `agentIntent.ts` appears to be a recent addition (experiment-gated, sophisticated state machine with telemetry). The `BackgroundCompaction` config key suggests this is a v0.39+ feature being tested via experiments.

2. **Responses API Context Management** — The `isResponsesCompactionContextManagementEnabled()` guard function and the mutual exclusion with client-side summarization (`!responsesCompactionContextManagementEnabled`) indicates an evolution from pure client-side summarization to server-side compaction. The model exclusion set (`gpt-5`, `gpt-5.1`, `gpt-5.2`) suggests active iteration on which models support this.

3. **CompactionDataContainer** — The round-trip mechanism for persisting server-generated compaction data as opaque prompt elements is architectural infrastructure supporting the Responses API approach.

4. **Copilot CLI `/compact` command** — Explicit user-triggered compaction via `this._sdkSession.compactHistory()` in `copilotcliSession.ts`.

5. **Threshold changes**: The 90% compact threshold for Responses API and the dual 75%/95% thresholds for background compaction are the current values. The `0.85` multiplier for `budgetThreshold` adds a safety margin.

### 6. Architecture Flow

```
User message → agentIntent.ts buildPrompt()
  ├─ If responsesCompactionContextManagementEnabled:
  │   └─ responsesApi.ts adds context_management to request body
  │       └─ Server returns compaction data → stored as opaque part
  │       └─ On next request: extractCompactionData() round-trips it
  ├─ Else if summarizationEnabled:
  │   ├─ If backgroundCompactionEnabled:
  │   │   ├─ Check for completed background summary → apply
  │   │   ├─ At ≥95% + InProgress → block and wait
  │   │   ├─ At ≥75% + Idle → start background compaction
  │   │   └─ On budget exceeded → wait for background, else foreground
  │   └─ Else (foreground only):
  │       └─ On BudgetExceededError → renderWithSummarization()
  └─ Render prompt normally
```

## Patterns

1. **Progressive compaction hierarchy**: Server-side (preferred, when available) → background client-side → foreground client-side (fallback)
2. **Experiment gating**: Both `BackgroundCompaction` and `ResponsesApiContextManagement` are behind experiment flags, suggesting active A/B testing
3. **Mutual exclusion**: Server-side compaction disables client-side summarization entirely
4. **Telemetry-rich**: Every compaction decision path emits telemetry (`backgroundSummarizationApplied`, `triggerSummarizeFailed`)
5. **Threshold constants**: 90% for server compaction, 85% budget multiplier, 75%/95% dual thresholds for background compaction

## Applicability

For the ralph-loop `PreCompact` hook system:
- The VS Code extension's background compaction uses a **dual-threshold approach** (75% start, 95% block) that could inform ralph-loop's compaction trigger strategy
- The **state machine pattern** (`BackgroundSummarizer`) is a clean model for async compaction lifecycle management
- The **mutual exclusion** between server-side and client-side compaction is important — if adopting Responses API compaction, local summarization hooks should be disabled
- The **0.85 budget safety margin** and **0.9 compact threshold** are empirical values worth noting for ralph-loop threshold tuning

## Open Questions

1. **Exact git diff between v0.38 and v0.41**: Without direct `git log` access from the search tools, the precise commit-by-commit changelog for compaction files cannot be enumerated. Running `git log v0.38..HEAD -- <files>` would provide this.
2. **Experiment rollout status**: Both `BackgroundCompaction` and `ResponsesApiContextManagement` are experiment-gated — what percentage of users have them enabled?
3. **Threshold tuning history**: Were the 75%/85%/90%/95% values tuned based on telemetry, or are they initial educated guesses?
4. **Model exclusion rationale**: Why are `gpt-5`, `gpt-5.1`, `gpt-5.2` excluded from Responses API context management but `gpt-5.3-codex-spark-preview` is not?
5. **Interaction with `/compact` slash command**: Does the user-triggered `/compact` interact with the automatic background compaction, or are they independent paths?
